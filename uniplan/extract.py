"""LLM extraction from announcements / Ed threads / emails, and applying the results to the DB."""
from __future__ import annotations

import difflib
import json
import logging
import re
from collections import defaultdict
from datetime import UTC, datetime, time
from typing import Literal

from pydantic import BaseModel
from sqlmodel import Session, select

from .config import settings
from .db import Assessment, AssessmentGroup, Course, Item, Override, Review, TimetableEvent, pref_float, utcnow
from .llm import get_llm
from .overrides import already_reflected, find_candidates
from .sources.base import chash

log = logging.getLogger("uniplan.extract")


class ClassChange(BaseModel):
    course_code: str
    activity: str
    original_date: str | None
    change: Literal["cancelled", "moved", "room_change", "online"]
    new_date: str | None
    new_start_time: str | None
    new_location: str | None
    confidence: float
    evidence: str


class Deadline(BaseModel):
    course_code: str | None
    title: str
    due_date: str
    due_time: str | None
    is_exam: bool
    location: str | None
    details: str | None
    confidence: float
    evidence: str


class Extraction(BaseModel):
    category: Literal["announcement", "assignment", "mark_release", "class_change", "exam_info", "discussion", "noise"]
    importance: int
    reason: str
    summary: str
    deadlines: list[Deadline]
    class_changes: list[ClassChange]


SYSTEM = """You read university course messages for one ANU student's personal planner and extract structured facts.
Rules:
- Today is {today}. Timezone Australia/Sydney (Canberra). Resolve relative dates ("this Friday", "next week")
  relative to the message's POSTED date, and output YYYY-MM-DD and 24h HH:MM.
- importance: 0 = noise/social, 1 = FYI, 2 = changes what the student should do/plan, 3 = urgent or assessment-critical
  (deadlines, extensions, exam details, cancellations). reason: one short clause.
- summary: one plain sentence a busy student can act on.
- deadlines: only assessable work or exams with an explicit date (include extensions as the NEW date). Use the
  official assessment name. is_exam=true for exams/tests/quizzes held at a set time; then fill location and
  details (duration, permitted materials) if stated. Do not list past deadlines unless they were just changed.
- class_changes: only one-off or new changes to scheduled classes (cancelled, moved to another time, room change,
  moved online). activity = the timetable activity code (e.g. LecA, TutA, ComA) if you can tell from the course's
  timetable listed below, else a word like "Lecture". original_date = the date of the affected class occurrence.
- confidence 0..1. evidence = exact short quote (<=200 chars) from the message.
- Never invent facts. Empty lists are fine."""


def _timetable_summary(s: Session, codes: set[str], tz) -> str:
    rows = s.exec(select(TimetableEvent).where(TimetableEvent.course_code.in_(codes))).all()
    slots: dict[str, set[str]] = defaultdict(set)
    for e in rows:
        local = e.start.replace(tzinfo=UTC).astimezone(tz)
        slots[e.activity].add(f"{local:%a %H:%M}")
    return "; ".join(f"{a}: {', '.join(sorted(v))}" for a, v in sorted(slots.items())) or "(no timetable data)"


def build_prompt(s: Session, item: Item, courses: list[Course], tz) -> str:
    course = next((c for c in courses if c.code == item.course_code), None)
    codes = set((course.all_codes or course.code).split("/")) if course else set()
    posted = item.posted_at.replace(tzinfo=UTC).astimezone(tz).strftime("%Y-%m-%d %a %H:%M") if item.posted_at else "unknown"
    src = {"canvas": "Canvas announcement", "ed": "Ed Discussion thread", "email": "Email"}.get(item.source, item.source)
    return "\n".join([
        "Enrolled courses: " + "; ".join(f"{c.code} ({c.name})" for c in courses),
        f"This message's course: {item.course_code or 'unknown'}",
        f"Timetable for this course: {_timetable_summary(s, codes, tz) if codes else '(unknown)'}",
        f"Source: {src}" + (f" [flags: {item.flags}]" if item.flags else "") + (f" from {item.author}" if item.author else ""),
        f"POSTED: {posted}",
        f"Title: {item.title}",
        "Body:",
        item.body[:8000],
    ])


_NORM = [(re.compile(r"\bass(?:ignment|ignmt|t)?\.?\s*(\d+)\b", re.I), r"assignment \1"),
         (re.compile(r"\bA(\d+)\b"), r"assignment \1"), (re.compile(r"\bhw\s*(\d+)\b", re.I), r"homework \1"),
         (re.compile(r"\bmid[- ]?sem(?:ester)?\b", re.I), "midsemester"), (re.compile(r"[^a-z0-9 ]"), " ")]


def norm_name(name: str) -> str:
    n = name
    for rx, rep in _NORM[:4]:
        n = rx.sub(rep, n)
    n = n.lower()
    n = _NORM[4][0].sub(" ", n)
    return re.sub(r"\s+", " ", n).strip()


def name_similarity(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    ratio = difflib.SequenceMatcher(None, na, nb).ratio()
    nums_a, nums_b = set(re.findall(r"\d+", na)), set(re.findall(r"\d+", nb))
    if nums_a and nums_b and nums_a != nums_b:
        return ratio * 0.4  # "Assignment 2" vs "Assignment 3" must not match
    ta, tb = set(na.split()), set(nb.split())
    jacc = len(ta & tb) / max(1, len(ta | tb))
    return max(ratio, jacc)


def to_utc(d: str, t: str | None, tz) -> datetime | None:
    try:
        dd = datetime.strptime(d, "%Y-%m-%d").date()
        tt = time.fromisoformat(t) if t else time(23, 59)
    except ValueError:
        return None
    return datetime.combine(dd, tt, tz).astimezone(UTC).replace(tzinfo=None)


def apply_deadline(s: Session, dl: Deadline, item: Item, tz, course_codes_all: dict[str, str]) -> str | None:
    code = dl.course_code or item.course_code
    code = course_codes_all.get(code or "", code)
    if not code or dl.confidence < 0.6:
        return None
    due = to_utc(dl.due_date, dl.due_time, tz)
    if not due or due < utcnow():
        return None
    existing = s.exec(select(Assessment).where(Assessment.course_code == code, Assessment.hidden == False,  # noqa: E712
                                               Assessment.duplicate_of == None)).all()  # noqa: E711
    best, score = None, 0.0
    for a in existing:
        sc = name_similarity(dl.title, a.name)
        if sc > score:
            best, score = a, sc
    if best and score >= 0.6:
        if dl.is_exam and (dl.location or dl.details):
            best.location = dl.location or best.location
            best.details = dl.details or best.details
            best.is_exam = True
            s.add(best)
        if best.due_at is None and best.source != "llm":
            best.due_at, best.updated_at = due, utcnow()
            s.add(best)
            return f"due date found for {best.name}"
        if best.due_at and abs((best.due_at - due).total_seconds()) > 1800 and not best.due_overridden:
            if best.source == "llm":
                best.due_at, best.updated_at = due, utcnow()
                s.add(best)
                return f"updated {best.name}"
            ref = f"deadline:{best.id}:{due.isoformat()}"
            if not s.exec(select(Review).where(Review.ref == ref)).first():
                local = due.replace(tzinfo=UTC).astimezone(tz)
                s.add(Review(kind="deadline_change", ref=ref, title=f"{code}: {best.name} due {local:%a %d %b %H:%M}?",
                             detail=f"Source says: “{dl.evidence}” ({item.title})",
                             payload=json.dumps({"assessment_id": best.id, "new_due": due.isoformat(), "item_id": item.id})))
            return f"possible due change for {best.name}"
        return None
    aid = f"llm:{chash(code, norm_name(dl.title))}"
    a = s.get(Assessment, aid)
    if a is None:
        a = Assessment(id=aid, course_code=code, source="llm", name=dl.title, url=item.url, due_at=due,
                       is_exam=dl.is_exam, location=dl.location or "", details=dl.details or "")
    else:
        a.due_at, a.updated_at = due, utcnow()
        a.location, a.details = dl.location or a.location, dl.details or a.details
    s.add(a)
    return f"new {'exam' if dl.is_exam else 'deadline'}: {dl.title}"


def record_class_change(s: Session, cc: ClassChange, item: Item, course_codes_all: dict[str, str]) -> Override | None:
    code = course_codes_all.get(cc.course_code, cc.course_code) or item.course_code
    if not code:
        return None
    dupe = s.exec(select(Override).where(Override.item_id == item.id, Override.activity == cc.activity,
                                         Override.original_date == cc.original_date)).first()
    if dupe:
        return None
    ov = Override(item_id=item.id, course_code=code, activity=cc.activity, original_date=cc.original_date,
                  change=cc.change, new_date=cc.new_date, new_start_time=cc.new_start_time,
                  new_location=cc.new_location, confidence=cc.confidence, evidence=cc.evidence)
    s.add(ov)
    s.flush()
    return ov


def resolve_overrides(s: Session, tz) -> list[str]:
    """Match pending/applied overrides to timetable events. Auto-apply confident unambiguous ones."""
    notes = []
    threshold = pref_float(s, "auto_apply_confidence")
    events = s.exec(select(TimetableEvent)).all()
    by_key = {e.key: e for e in events}
    courses = {c.code: set((c.all_codes or c.code).split("/")) | {c.code} for c in s.exec(select(Course)).all()}
    for ov in s.exec(select(Override).where(Override.status.in_(["pending", "applied", "unmatched"]))).all():
        if ov.status == "applied":
            ev = by_key.get(ov.target_key or "")
            if ev is None or already_reflected(ov, ev, tz):
                ov.status = "resolved"
                s.add(ov)
            continue
        codes = courses.get(ov.course_code, {ov.course_code})
        cands = find_candidates(ov, events, tz, codes)
        ref = f"override:{ov.id}"
        if len(cands) == 1 and ov.confidence >= threshold:
            ov.status, ov.target_key = "applied", cands[0].key
            notes.append(f"{ov.course_code} {cands[0].activity}: {ov.change}")
            for r in s.exec(select(Review).where(Review.ref == ref, Review.status == "open")).all():
                r.status, r.resolution = "resolved", "auto-applied"
                s.add(r)
        else:
            ov.status = "pending" if cands else "unmatched"
            if not s.exec(select(Review).where(Review.ref == ref)).first():
                options = [{"key": e.key, "label": f"{e.activity} {e.start.replace(tzinfo=UTC).astimezone(tz):%a %d %b %H:%M} @ {e.location}"}
                           for e in cands]
                s.add(Review(kind="class_change", ref=ref,
                             title=f"{ov.course_code}: {ov.change.replace('_', ' ')} – {ov.activity or 'class'} {ov.original_date or ''}",
                             detail=f"“{ov.evidence}”" + ("" if cands else " (no matching class found in your timetable)"),
                             payload=json.dumps({"override_id": ov.id, "candidates": options})))
        s.add(ov)
    return notes


def process_items(s: Session, items: list[Item], log_fn=print) -> dict:
    """Run the LLM over new/changed items. Returns counters for the digest."""
    cfg = settings()
    tz = cfg.tz
    llm = get_llm()
    courses = s.exec(select(Course).where(Course.active == True, Course.hidden == False)).all()  # noqa: E712
    alias = {}
    for c in courses:
        for code in (c.all_codes or c.code).split("/"):
            alias[code] = c.code
    system = SYSTEM.format(today=datetime.now(tz).strftime("%Y-%m-%d %A"))
    out = {"processed": 0, "failed": 0, "deadline_notes": [], "class_changes": 0}
    for item in items:
        try:
            ext, model = llm.generate(build_prompt(s, item, courses, tz), system, Extraction, purpose=f"extract:{item.source}")
        except Exception as e:  # noqa: BLE001
            out["failed"] += 1
            log_fn(f"LLM failed on {item.id}: {e}")
            if "both failed" in str(e):
                break
            continue
        item.category, item.importance = ext.category, max(0, min(3, ext.importance))
        item.reason, item.summary, item.llm_model = ext.reason[:300], ext.summary[:500], model
        item.processed_hash = item.content_hash
        s.add(item)
        for dl in ext.deadlines:
            note = apply_deadline(s, dl, item, tz, alias)
            if note:
                out["deadline_notes"].append(f"{dl.course_code or item.course_code}: {note}")
        for cc in ext.class_changes:
            if record_class_change(s, cc, item, alias):
                out["class_changes"] += 1
        s.commit()
        out["processed"] += 1
        if out["processed"] % 10 == 0:
            log_fn(f"llm: {out['processed']}/{len(items)} read")
    return out


# ---------------- weights ----------------

class ProposedGroup(BaseModel):
    name: str
    weight: float  # nominal % of the final grade
    assessments: list[str]  # exact names from the provided list that belong to this task
    keep_best: int  # "only your best N count" -> N, else 0
    capped: bool  # true if this task is part of the combined cap below
    notes: str  # hurdle / redeemable / other rules, else ""


class ProposedWeights(BaseModel):
    found: bool
    groups: list[ProposedGroup]
    cap_weight: float  # if several tasks' combined contribution is capped (e.g. 29% nominal capped at 22%) -> 22, else 0
    note: str


WEIGHT_KINDS = ["class_summary", "page", "syllabus", "announcement", "thread"]


def _pct_snippets(body: str, radius: int = 3, cap: int = 3000) -> str:
    if len(body) <= cap:
        return body
    lines = body.splitlines()
    keep = set()
    for i, line in enumerate(lines):
        if "%" in line or re.search(r"\b(weight|worth|hurdle|redeem)", line, re.I):
            keep.update(range(max(0, i - radius), min(len(lines), i + radius + 1)))
    return "\n".join(lines[i] for i in sorted(keep))[:cap]


def weights_corpus(s: Session, course: Course) -> tuple[str, list[str]]:
    items = s.exec(select(Item).where(Item.course_code == course.code, Item.kind.in_(WEIGHT_KINDS))).all()
    items.sort(key=lambda i: (WEIGHT_KINDS.index(i.kind), -(i.posted_at or i.first_seen).timestamp()))
    parts, titles, budget = [], [], 16000
    for it in items:
        text = it.body[:9000] if it.kind == "class_summary" else _pct_snippets(it.body)
        if it.kind != "class_summary" and "%" not in text:
            continue
        chunk = f"## [{it.kind}] {it.title}\n{text}"
        if len(chunk) > budget:
            continue
        parts.append(chunk)
        titles.append(it.title)
        budget -= len(chunk)
    return "\n\n".join(parts), titles


def _course_assessments(s: Session, code: str) -> list[Assessment]:
    return [a for a in s.exec(select(Assessment).where(Assessment.course_code == code)).all()
            if a.duplicate_of is None and not a.hidden]


def find_weights(s: Session, course: Course, force: bool = False) -> dict | None:
    """Ask the LLM to read the class summary + Canvas pages for the course's weighting scheme.
    Stores the proposal on the course (JSON). Skips if the source text hasn't changed (unless force)."""
    corpus, titles = weights_corpus(s, course)
    if not corpus:
        return None
    asm = _course_assessments(s, course.code)
    groups = s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == course.code)).all()
    h = chash(corpus, sorted(a.name for a in asm))
    if not force and h == course.weights_proposal_hash:
        return json.loads(course.weights_proposal) if course.weights_proposal else None
    prompt = (f"Course {course.code} ({course.name}).\n"
              f"Canvas assignment groups: {', '.join(g.name for g in groups) or '(none)'}\n"
              f"Assessment items in Canvas/Gradescope (use these exact names):\n"
              + "\n".join(f"- {a.name}" for a in asm)
              + f"\n\nCourse text:\n{corpus}")
    system = ("You find a university course's official assessment weighting scheme. The ANU class summary "
              "(Programs & Courses) is authoritative; Canvas pages may add detail (best-of rules, hurdles, redeemable "
              "exams). Return one group per assessment task with its % of the final grade (numbers only), and list "
              "which of the given assessment items belong to it (exact names; an item belongs to at most one group; "
              "practice/ungraded items belong to none). If the text says only the best N of a task's items count, set "
              "keep_best=N, otherwise keep_best=0. "
              "If several tasks' COMBINED contribution is capped (e.g. 'nominal total 29%, capped at 22%'), set "
              "cap_weight to the cap and capped=true ONLY on the tasks inside that cap (all others capped=false), "
              "keeping their nominal weights. "
              "Put hurdles, redeemable marks and other rules in notes. "
              "If no weights are stated, set found=false. Never invent weights.")
    try:
        res, model = get_llm().generate(prompt, system, ProposedWeights, purpose="weights")
    except Exception as e:  # noqa: BLE001
        log.warning("weights LLM failed for %s: %s", course.code, e)
        return None
    by_name = {}
    for a in asm:
        by_name.setdefault(a.name.strip().lower(), a.id)
    proposal = {
        "found": res.found and bool(res.groups),
        "groups": [{"name": g.name, "weight": g.weight, "notes": g.notes, "keep_best": max(0, g.keep_best),
                    "capped": bool(g.capped and res.cap_weight > 0),
                    "assessments": [by_name[n.strip().lower()] for n in g.assessments if n.strip().lower() in by_name]}
                   for g in res.groups],
        "cap_weight": res.cap_weight if any(g.capped for g in res.groups) else 0.0,
        "note": res.note, "sources": titles, "model": model, "at": utcnow().isoformat(),
    }
    _repair_proposal(proposal, corpus)
    if model.startswith("ollama"):
        # the small local model is only a stopgap for this: show it, never auto-apply, retry with Gemini next sync
        proposal["provisional"] = True
        h = ""
    current = sorted(round(g.weight, 1) for g in groups if g.weight > 0)
    proposed = sorted(round(g["weight"], 1) for g in proposal["groups"] if g["weight"] > 0)
    proposal["agrees_with_canvas"] = bool(current) and current == proposed and not proposal["cap_weight"] \
        and not any(g["keep_best"] for g in proposal["groups"])
    course.weights_proposal, course.weights_proposal_hash = json.dumps(proposal), h
    s.add(course)
    s.flush()
    return proposal


def _repair_proposal(prop: dict, corpus: str) -> None:
    """Deterministic sanity checks on the LLM's weighting scheme."""
    groups = prop["groups"]
    # keep_best only if the text really says "best N"
    for g in groups:
        n = g.get("keep_best") or 0
        if n and (n < 2 or not re.search(rf"\bbest\s+{n}\b", corpus, re.I)):
            g["keep_best"] = 0
    cap = prop.get("cap_weight") or 0
    if not cap:
        for g in groups:
            g["capped"] = False
        return
    nominal = sum(g["weight"] for g in groups)
    effective = sum(g["weight"] for g in groups if not g["capped"]) + cap
    if abs(effective - 100) <= 0.5 and sum(g["weight"] for g in groups if g["capped"]) > cap:
        return
    # find the subset of groups whose nominal sum S makes  nominal - S + cap == 100  (prefer the smallest weights)
    target = nominal - 100 + cap
    order = sorted(range(len(groups)), key=lambda i: groups[i]["weight"])
    best = None
    for mask in range(1, 1 << len(order)):
        idx = [order[b] for b in range(len(order)) if mask >> b & 1]
        if abs(sum(groups[i]["weight"] for i in idx) - target) <= 0.5 and target > cap:
            if best is None or len(idx) > len(best) or (len(idx) == len(best) and
                                                        max(groups[i]["weight"] for i in idx) < max(groups[i]["weight"] for i in best)):
                best = idx
    if best is None:
        prop["cap_weight"] = 0.0
        for g in groups:
            g["capped"] = False
        prop["note"] = (prop.get("note", "") + " (A cap was mentioned but didn't fit the weights; check manually.)").strip()
        return
    for i, g in enumerate(groups):
        g["capped"] = i in best
        if "capped at" in (g.get("notes") or "").lower():
            g["notes"] = ""


def apply_weights(s: Session, course: Course) -> bool:
    """Replace the course's weighting with the LLM proposal, re-mapping every assessment into the new groups.
    Canvas groups are kept with weight 0 so the Canvas sync won't bring their old weights back."""
    if not course.weights_proposal:
        return False
    prop = json.loads(course.weights_proposal)
    if not prop.get("found"):
        return False
    for g in s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == course.code)).all():
        if g.source == "llm" and g.canvas_group_id is None:
            s.delete(g)
        else:
            g.weight, g.source = 0.0, "llm"
            s.add(g)
    s.flush()
    new_groups = []
    for i, pg in enumerate(prop["groups"]):
        ids = set(pg.get("assessments") or [])
        keep = int(pg.get("keep_best") or 0)
        g = AssessmentGroup(course_code=course.code, name=pg["name"], weight=float(pg["weight"]), source="llm",
                            hurdle=(pg.get("notes") or "")[:300], sort=i, capped=bool(pg.get("capped")),
                            drop_lowest=max(0, len(ids) - keep) if keep else 0)
        s.add(g)
        s.flush()
        new_groups.append((g, ids))
    course.cap_weight = float(prop.get("cap_weight") or 0.0)
    for a in s.exec(select(Assessment).where(Assessment.course_code == course.code)).all():
        target = next((g for g, ids in new_groups if a.id in ids), None)
        if target is None and a.duplicate_of is None:
            best, sc = None, 0.0
            for g, _ in new_groups:
                v = name_similarity(a.name, g.name)
                if v > sc:
                    best, sc = g, v
            target = best if sc >= 0.6 else None
        a.group_id, a.group_locked = (target.id if target else None), True
        s.add(a)
    course.weights_note = f"From {', '.join(prop.get('sources') or [])[:200]} ({prop.get('model', '')}). {prop.get('note', '')}"[:500]
    course.weights_confirmed = False
    s.add(course)
    s.flush()
    return True
