"""The nightly sync: fetch every source -> store -> LLM -> overrides -> study plan -> calendar -> digest -> push."""
from __future__ import annotations

import json
import logging
import threading
import time
import traceback
from datetime import timedelta

from sqlmodel import Session, select

from . import notify
from .calendar_sync import CalDAVStore, Store, sync_calendars
from .config import settings
from .db import (Assessment, AssessmentGroup, Course, Item, Review, SyncRun, TimetableEvent, index_item, init_db,
                 session, utcnow)
from .extract import apply_weights, find_weights, name_similarity, process_items, resolve_overrides
from .planner import desired_events, hidden_codes, plan_study
from .sources import anu_courses, canvas, ed, email_source, gradescope, timetable
from .sources.base import FetchResult, SourceUnavailable, chash

log = logging.getLogger("uniplan.pipeline")
LLM_KINDS = {"announcement", "thread", "email"}
_lock = threading.Lock()
MAX_LLM_ITEMS_PER_RUN = 150


def is_running() -> bool:
    return _lock.locked()


# ---------------- upserts ----------------

def _alias_map(s: Session) -> dict[str, str]:
    m = {}
    for c in s.exec(select(Course)).all():
        for code in (c.all_codes or c.code).split("/") + [c.code]:
            if code:
                m[code] = c.code
    return m


def upsert_courses(s: Session, res: FetchResult, source: str) -> None:
    alias = _alias_map(s)
    if source == "canvas":
        seen = set()
        for fc in res.courses:
            c = s.get(Course, fc.code) or Course(code=fc.code)
            c.name, c.all_codes, c.canvas_id, c.active = fc.name, fc.all_codes, fc.canvas_id, True
            seen.add(fc.code)
            s.add(c)
        for c in s.exec(select(Course)).all():
            if c.code not in seen and c.canvas_id is not None:
                c.active = False
                s.add(c)
        s.flush()
        return
    for fc in res.courses:
        code = next((alias[x] for x in [fc.code] + fc.all_codes.split("/") if x in alias), None)
        if code is None:
            if source != "ed":
                continue  # gradescope lists past terms; only attach to known courses
            c = Course(code=fc.code, name=fc.name, all_codes=fc.all_codes)
        else:
            c = s.get(Course, code)
        if source == "ed":
            c.ed_id = fc.ed_id
        elif source == "gradescope":
            c.gradescope_id = fc.gradescope_id
        s.add(c)
    s.flush()


def upsert_items(s: Session, res: FetchResult) -> int:
    alias = _alias_map(s)
    new = 0
    for fi in res.items:
        code = alias.get(fi.course_code or "", fi.course_code)
        h = chash(fi.title, fi.body)
        it = s.get(Item, fi.id)
        if it is None:
            it = Item(id=fi.id, source=fi.source, kind=fi.kind, content_hash=h)
            new += 1
        elif it.content_hash != h:
            it.content_hash, it.last_changed = h, utcnow()
        it.course_code, it.title, it.body, it.url = code, fi.title, fi.body, fi.url
        it.posted_at, it.author, it.flags = fi.posted_at, fi.author, fi.flags
        if fi.kind not in LLM_KINDS:
            it.processed_hash, it.category = it.content_hash, it.category or fi.kind
        s.add(it)
        index_item(s, it)
    s.flush()
    return new


def upsert_groups(s: Session, res: FetchResult) -> None:
    existing = {g.canvas_group_id: g for g in s.exec(select(AssessmentGroup).where(AssessmentGroup.canvas_group_id != None)).all()}  # noqa: E711
    for fg in res.groups:
        g = existing.get(fg.canvas_group_id)
        if g is None:
            g = AssessmentGroup(course_code=fg.course_code, canvas_group_id=fg.canvas_group_id, name=fg.name,
                                weight=fg.weight, source="canvas", sort=fg.sort)
        elif g.source == "canvas":  # 'manual' means you edited it - keep yours
            g.name, g.weight, g.sort = fg.name, fg.weight, fg.sort
        s.add(g)
    s.flush()


def upsert_assessments(s: Session, res: FetchResult, run_start) -> None:
    alias = _alias_map(s)
    known = set(alias.values())
    for fa in res.assessments:
        code = alias.get(fa.course_code)
        if code is None or code not in known:
            continue
        a = s.get(Assessment, fa.id)
        if a is None:
            a = Assessment(id=fa.id, course_code=code, source=fa.source, name=fa.name, excluded=fa.excluded)
        was_graded = a.graded and a.score is not None
        a.name, a.url, a.points_possible, a.canvas_group_id = fa.name, fa.url, fa.points_possible, fa.canvas_group_id
        if not a.due_overridden:
            a.due_at = fa.due_at if fa.due_at else a.due_at
        a.score, a.graded = fa.score, fa.graded
        a.submitted = fa.submitted or a.submitted
        if a.graded and a.score is not None and not was_graded:
            a.graded_at = utcnow()
        a.updated_at = utcnow()
        s.add(a)
    s.flush()


def link_and_group(s: Session) -> None:
    """Dedupe Gradescope/LLM items against Canvas, merge fields, and put assessments into weighted groups."""
    groups = s.exec(select(AssessmentGroup)).all()
    by_canvas = {g.canvas_group_id: g for g in groups if g.canvas_group_id}
    all_a = s.exec(select(Assessment)).all()
    canon = [a for a in all_a if a.source == "canvas"]
    for a in all_a:
        if a.source == "canvas":
            if not a.group_locked and a.canvas_group_id in by_canvas:
                g = by_canvas[a.canvas_group_id]
                a.group_id = g.id
                if g.weight <= 0 and g.source == "llm":  # Canvas group replaced by class-summary weights
                    a.group_id = _guess_group(a, [x for x in groups if x.course_code == a.course_code and x.weight > 0])
            s.add(a)
            continue
        if a.duplicate_of is None or a.source == "llm":
            pool = [c for c in canon if c.course_code == a.course_code]
            if a.source == "llm":
                pool += [x for x in all_a if x.source == "gradescope" and x.course_code == a.course_code]
            best, sc = None, 0.0
            for c in pool:
                v = name_similarity(a.name, c.name)
                close = a.due_at is None or c.due_at is None or abs((a.due_at - c.due_at).total_seconds()) < 3 * 86400
                if close and v > sc:
                    best, sc = c, v
            if best and sc >= (0.75 if a.source == "gradescope" else 0.6):
                a.duplicate_of = best.id
        if a.duplicate_of:
            c = s.get(Assessment, a.duplicate_of)
            if c:
                if c.due_at is None and a.due_at:
                    c.due_at = a.due_at
                if (c.score is None or not c.graded) and a.graded and a.score is not None:
                    c.score, c.graded, c.points_possible = a.score, True, a.points_possible
                    c.graded_at = c.graded_at or a.graded_at
                c.submitted = c.submitted or a.submitted
                if a.is_exam:
                    c.is_exam, c.location, c.details = True, a.location or c.location, a.details or c.details
                s.add(c)
        elif not a.group_locked and a.group_id is None:
            cg = [g for g in groups if g.course_code == a.course_code and g.weight > 0]
            best, sc = None, 0.0
            for g in cg:
                v = name_similarity(a.name.rstrip("0123456789 "), g.name.rstrip("s"))
                if v > sc:
                    best, sc = g, v
            if best and sc >= 0.5:
                a.group_id = best.id
        s.add(a)
    s.flush()


def _guess_group(a: Assessment, groups: list[AssessmentGroup]) -> int | None:
    best, sc = None, 0.0
    for g in groups:
        v = name_similarity(a.name.rstrip("0123456789 "), g.name.rstrip("s"))
        if v > sc:
            best, sc = g, v
    return best.id if best and sc >= 0.5 else None


def ensure_class_summaries(s: Session, L) -> None:
    """Courses whose Canvas pages don't link a class summary: build the URL from the timetable class number."""
    have = {i.course_code for i in s.exec(select(Item).where(Item.kind == "class_summary")).all()}
    for c in s.exec(select(Course).where(Course.active == True, Course.hidden == False)).all():  # noqa: E712
        if c.code in have:
            continue
        ev = s.exec(select(TimetableEvent).where(TimetableEvent.course_code == c.code)).first()
        url = anu_courses.guess_url(c.code, ev.description) if ev else None
        summary = anu_courses.fetch_summary(url) if url else None
        if summary:
            it = Item(id=f"anu:classsummary:{c.code}", source="anu", kind="class_summary", course_code=c.code,
                      title=f"{c.code} class summary (Programs & Courses)", body=summary, url=url,
                      content_hash=chash(summary), processed_hash=chash(summary), category="class_summary")
            s.add(it)
            index_item(s, it)
            L(f"class summary found for {c.code} via timetable")


def replace_timetable(s: Session, res: FetchResult) -> None:
    keep = set()
    for ft in res.timetable or []:
        e = s.get(TimetableEvent, ft.key) or TimetableEvent(key=ft.key, start=ft.start, end=ft.end)
        e.course_code, e.course_name, e.activity = ft.course_code, ft.course_name, ft.activity
        e.start, e.end, e.location, e.description, e.seen_at = ft.start, ft.end, ft.location, ft.description, utcnow()
        keep.add(ft.key)
        s.add(e)
    for e in s.exec(select(TimetableEvent)).all():
        if e.key not in keep:
            s.delete(e)
    s.flush()


# ---------------- the run ----------------

def run_sync(trigger: str = "manual", store: Store | None = None) -> SyncRun | None:
    if not _lock.acquire(blocking=False):
        return None
    try:
        return _run(trigger, store)
    finally:
        _lock.release()


def _run(trigger: str, store: Store | None) -> SyncRun:
    init_db()
    cfg = settings()
    logs: list[str] = []

    def L(msg):
        log.info(msg)
        logs.append(f"{utcnow():%H:%M:%S} {msg}")

    with session() as s:
        for stale in s.exec(select(SyncRun).where(SyncRun.status == "running")).all():  # killed mid-run earlier
            stale.status, stale.finished_at = "aborted", stale.finished_at or utcnow()
            s.add(stale)
        prev = s.exec(select(SyncRun).where(SyncRun.status.in_(["ok", "partial", "failed"])).order_by(SyncRun.id.desc())).first()
        run = SyncRun(trigger=trigger)
        s.add(run)
        s.commit()
        run_start = run.started_at
        sources: dict[str, dict] = {}

        def step(name, fn, apply):
            t0 = time.time()
            try:
                res = fn()
                apply(res)
                s.commit()
                sources[name] = {"status": "ok", "meta": res.meta, "seconds": round(time.time() - t0, 1)}
                L(f"{name}: ok {res.meta}")
            except SourceUnavailable as e:
                s.rollback()
                sources[name] = {"status": "needs_action", "error": str(e)}
                L(f"{name}: needs action - {e}")
            except Exception as e:  # noqa: BLE001
                s.rollback()
                sources[name] = {"status": "error", "error": f"{type(e).__name__}: {e}"[:500]}
                L(f"{name}: ERROR {e}\n{traceback.format_exc(limit=3)}")

        step("canvas", lambda: canvas.Canvas(cfg).fetch(),
             lambda r: (upsert_courses(s, r, "canvas"), upsert_groups(s, r), upsert_assessments(s, r, run_start), upsert_items(s, r)))
        step("timetable", lambda: timetable.fetch(cfg), lambda r: replace_timetable(s, r))
        step("ed", lambda: ed.Ed(cfg).fetch(), lambda r: (upsert_courses(s, r, "ed"), upsert_items(s, r)))
        step("gradescope", lambda: gradescope.fetch(cfg), lambda r: (upsert_courses(s, r, "gradescope"), upsert_assessments(s, r, run_start)))
        if cfg.email_source != "none":
            step("email", lambda: email_source.fetch(cfg, cfg.llm_lookback_days), lambda r: upsert_items(s, r))
        else:
            sources["email"] = {"status": "disabled", "error": "EMAIL_SOURCE=none"}

        link_and_group(s)
        s.commit()

        # ---- LLM over new/changed text ----
        cutoff = utcnow() - timedelta(days=cfg.llm_lookback_days)
        hidden = hidden_codes(s)
        pending = [i for i in s.exec(select(Item).where(Item.kind.in_(LLM_KINDS))).all()
                   if i.processed_hash != i.content_hash and not i.dismissed and i.course_code not in hidden
                   and ((i.posted_at or i.first_seen) >= cutoff or i.last_changed >= cutoff)]
        stale = [i for i in s.exec(select(Item).where(Item.kind.in_(LLM_KINDS))).all()
                 if i.processed_hash != i.content_hash and i not in pending]
        for i in stale:  # too old to matter: archive without LLM (still searchable in Ask)
            i.processed_hash, i.category, i.importance = i.content_hash, i.category or "archive", i.importance or 0
            s.add(i)
        s.commit()
        pending.sort(key=lambda i: i.posted_at or i.first_seen, reverse=True)
        pending = pending[:MAX_LLM_ITEMS_PER_RUN]
        L(f"llm: {len(pending)} item(s) to read")
        llm_out = process_items(s, pending, L) if pending else {"processed": 0, "failed": 0, "deadline_notes": [], "class_changes": 0}
        sources["llm"] = {"status": "ok" if not llm_out["failed"] else ("error" if not llm_out["processed"] else "partial"),
                          "meta": {k: v for k, v in llm_out.items() if k != "deadline_notes"}}
        link_and_group(s)
        s.commit()

        cc_notes = resolve_overrides(s, cfg.tz)
        s.commit()

        # ---- weights (LLM reads the ANU class summary + Canvas pages) ----
        ensure_class_summaries(s, L)
        s.commit()
        for c in s.exec(select(Course).where(Course.active == True, Course.hidden == False)).all():  # noqa: E712
            if c.weights_confirmed:
                continue
            had = c.weights_proposal_hash
            prop = find_weights(s, c)
            if prop is None:
                continue
            if c.weights_proposal_hash != had:
                L(f"weights: read {c.code} -> {'found' if prop['found'] else 'not found'}"
                  f"{' (matches Canvas)' if prop.get('agrees_with_canvas') else ''}")
            groups = s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == c.code)).all()
            has_weights = any(g.weight > 0 for g in groups)
            current_total = sum(g.weight for g in groups if g.weight > 0 and not (g.capped and c.cap_weight > 0)) \
                + (c.cap_weight if any(g.capped for g in groups if g.weight > 0) else 0)
            proposed_total = sum(g["weight"] for g in prop.get("groups", []) if not g.get("capped")) + (prop.get("cap_weight") or 0)
            canvas_broken = has_weights and abs(current_total - 100) > 0.5 and abs(proposed_total - 100) <= 0.5
            if prop["found"] and not prop.get("provisional") and (not has_weights or canvas_broken) and apply_weights(s, c):
                L(f"weights: applied for {c.code}" + (" (Canvas weights didn't add up to 100%)" if canvas_broken else ""))
            ref = f"weights:{c.code}"
            review = s.exec(select(Review).where(Review.ref == ref, Review.status == "open")).first()
            if prop["found"] and has_weights and not prop.get("agrees_with_canvas"):
                detail = ("The ANU class summary / Canvas pages say: "
                          + ", ".join(f"{g['name']} {g['weight']:g}%" for g in prop["groups"])
                          + ". Canvas is set up differently. Open the course to compare and pick one.")
            else:
                detail = "Check the weightings on the course page so your marks are calculated correctly."
            if review is None and not s.exec(select(Review).where(Review.ref == ref)).first():
                s.add(Review(kind="weights", ref=ref, title=f"Confirm {c.code} assessment weightings", detail=detail,
                             payload=json.dumps({"course": c.code})))
            elif review is not None and review.detail != detail:
                review.detail = detail
                s.add(review)
            s.commit()
        link_and_group(s)
        s.commit()

        # ---- study + calendar ----
        try:
            n = plan_study(s, cfg.tz)
            L(f"study: {n} new block(s)")
        except Exception as e:  # noqa: BLE001
            L(f"study: ERROR {e}")
        try:
            st = store or CalDAVStore(cfg)
            stats = sync_calendars(s, st, desired_events(s, cfg.tz))
            sources["calendar"] = {"status": "ok", "meta": stats.__dict__}
            L(f"calendar: {stats.__dict__}")
        except Exception as e:  # noqa: BLE001
            s.rollback()
            sources["calendar"] = {"status": "error", "error": f"{type(e).__name__}: {e}"[:300]}
            L(f"calendar: ERROR {e}")

        # ---- digest ----
        since = prev.started_at if prev else run_start - timedelta(days=7)
        important = [i for i in s.exec(select(Item).where(Item.importance >= 2, Item.dismissed == False)).all()  # noqa: E712
                     if (i.first_seen >= since or i.last_changed >= since) and (i.posted_at or i.first_seen) >= cutoff
                     and i.course_code not in hidden]
        important.sort(key=lambda i: (-(i.importance or 0), -(i.posted_at or i.first_seen).timestamp()))
        new_asm = [a for a in s.exec(select(Assessment).where(Assessment.first_seen >= run_start, Assessment.duplicate_of == None)).all()  # noqa: E711
                   if a.due_at and a.due_at > utcnow() and a.course_code not in hidden] if prev else []
        released = [a for a in s.exec(select(Assessment).where(Assessment.graded_at >= since)).all()
                    if a.course_code not in hidden] if prev else []
        digest = {
            "important": [{"id": i.id, "course": i.course_code, "title": i.title, "summary": i.summary, "importance": i.importance,
                           "url": i.url, "source": i.source} for i in important[:30]],
            "new_assessments": [{"course": a.course_code, "name": a.name, "due": a.due_at.isoformat() if a.due_at else None} for a in new_asm],
            "marks_released": [{"course": a.course_code, "name": a.name, "score": a.score, "out_of": a.points_possible} for a in released],
            "class_changes": cc_notes,
            "deadline_notes": llm_out["deadline_notes"],
            "open_reviews": len(s.exec(select(Review).where(Review.status == "open")).all()),
            "needs_action": {k: v["error"] for k, v in sources.items() if v["status"] in ("needs_action", "error")},
        }
        run.sources, run.digest, run.log = json.dumps(sources), json.dumps(digest), "\n".join(logs)[-20000:]
        bad = [k for k, v in sources.items() if v["status"] == "error"]
        run.status = "ok" if not bad else ("failed" if len(bad) >= 4 else "partial")
        run.finished_at = utcnow()
        s.add(run)
        s.commit()

        # ---- push ----
        parts = []
        if digest["important"]:
            parts.append(f"{len(digest['important'])} important update(s)")
        if digest["marks_released"]:
            parts.append(f"{len(digest['marks_released'])} mark(s) released")
        if digest["new_assessments"]:
            parts.append(f"{len(digest['new_assessments'])} new deadline(s)")
        if cc_notes:
            parts.append(f"{len(cc_notes)} class change(s)")
        if digest["needs_action"]:
            parts.append("action needed: " + ", ".join(digest["needs_action"]))
        if parts and prev is not None:
            notify.push("UniPlan digest", "; ".join(parts) + ". Tap to open.", priority=4 if cc_notes or digest["marks_released"] else 3)
        return run
