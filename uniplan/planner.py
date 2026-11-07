"""Builds the desired calendar, schedules study blocks and computes workload."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from sqlmodel import Session, select

from .calendar_sync import DesiredEvent
from .db import (Assessment, Course, Override, StudyBlock, TimetableEvent, pref, pref_float, pref_minutes_list, utcnow)
from .overrides import apply as apply_override
from .sources.base import chash
from .sources.timetable import activity_label


def local(dt: datetime, tz) -> datetime:
    return dt.replace(tzinfo=UTC).astimezone(tz)


def hidden_codes(s: Session) -> set[str]:
    """Every course code (incl. cross-listed aliases) of courses you've hidden."""
    out: set[str] = set()
    for c in s.exec(select(Course).where(Course.hidden == True)).all():  # noqa: E712
        out |= {c.code, *[x for x in (c.all_codes or "").split("/") if x]}
    return out


def visible_assessments(s: Session) -> list[Assessment]:
    hidden = hidden_codes(s)
    return [a for a in s.exec(select(Assessment).where(Assessment.hidden == False, Assessment.duplicate_of == None)).all()  # noqa: E711,E712
            if a.course_code not in hidden]


def class_events(s: Session, tz) -> list[tuple[TimetableEvent, DesiredEvent]]:
    applied = {o.target_key: o for o in s.exec(select(Override).where(Override.status == "applied")).all()}
    out = []
    hidden = hidden_codes(s)
    for e in s.exec(select(TimetableEvent)).all():
        if e.course_code in hidden:
            continue
        summary = f"{e.course_code} {activity_label(e.activity)}".strip()
        desc = f"{e.course_name}\n{e.description}".strip()
        start, end, loc = e.start, e.end, e.location
        ov = applied.get(e.key)
        if ov:
            a = apply_override(ov, e, tz)
            start, end, loc = a.start, a.end, a.location
            summary = f"{a.prefix} {summary}"
            desc = f"{a.note}\n\n{desc}"
        out.append((e, DesiredEvent(uid=f"tt-{e.key}@uniplan", calendar="classes", summary=summary, start=start, end=end,
                                    location=loc, description=desc, transparent=bool(ov and ov.change == "cancelled"))))
    return out


def exam_duration(a: Assessment) -> timedelta:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:hours|hrs|hour|hr|h)\b", a.details or "", re.I)
    hours = float(m.group(1)) if m else 3.0
    m2 = re.search(r"(\d+)\s*min(?:ute)?s?\s*reading", a.details or "", re.I)
    return timedelta(hours=hours, minutes=int(m2.group(1)) if m2 else 0)


def assessment_events(s: Session, tz) -> list[DesiredEvent]:
    due_alarms, exam_alarms = pref_minutes_list(s, "alarm_due_minutes"), pref_minutes_list(s, "alarm_exam_minutes")
    out = []
    for a in visible_assessments(s):
        if a.due_at is None:
            continue
        done = " (submitted)" if a.submitted else ""
        lines = []
        if a.is_exam:
            if a.location:
                lines.append(f"Location: {a.location}")
            if a.details:
                lines.append(a.details)
        else:
            lines.append(f"Due {local(a.due_at, tz):%a %d %b %H:%M}")
        if a.points_possible:
            lines.append(f"Worth {a.points_possible:g} pts" + (f" · score {a.score:g}" if a.graded and a.score is not None else ""))
        lines.append(f"Source: {a.source}")
        if a.is_exam:
            out.append(DesiredEvent(uid=f"asm-{chash(a.id)}@uniplan", calendar="exams",
                                    summary=f"{a.course_code} · {a.name}{done}", start=a.due_at, end=a.due_at + exam_duration(a),
                                    location=a.location, description="\n".join(lines), url=a.url,
                                    alarms=[] if a.submitted else exam_alarms))
        else:
            out.append(DesiredEvent(uid=f"asm-{chash(a.id)}@uniplan", calendar="due",
                                    summary=f"{a.course_code} · {a.name} due{done}", start=a.due_at - timedelta(minutes=30),
                                    end=a.due_at, description="\n".join(lines), url=a.url,
                                    alarms=[] if a.submitted else due_alarms))
    return out


def study_events(s: Session) -> list[DesiredEvent]:
    names = {a.id: a for a in s.exec(select(Assessment)).all()}
    out = []
    for b in s.exec(select(StudyBlock)).all():
        a = names.get(b.assessment_id)
        if not a:
            continue
        out.append(DesiredEvent(uid=f"study-{b.id}@uniplan", calendar="study", summary=f"Study · {a.course_code} {a.name}",
                                start=b.start, end=b.end, description="Study time planned by UniPlan. Move or delete it freely.",
                                url=a.url))
    return out


def desired_events(s: Session, tz) -> list[DesiredEvent]:
    return [d for _, d in class_events(s, tz)] + assessment_events(s, tz) + study_events(s)


# ---------------- study blocks ----------------

def default_effort(s: Session, a: Assessment) -> float:
    if a.effort_hours is not None:
        return a.effort_hours
    n = a.name.lower()
    if a.is_exam or "exam" in n or "test" in n:
        return pref_float(s, "effort_exam_hours")
    if "quiz" in n:
        return pref_float(s, "effort_quiz_hours")
    return pref_float(s, "effort_assignment_hours")


def _merge(intervals):
    out = []
    for a, b in sorted([list(i) for i in intervals]):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def plan_study(s: Session, tz, now: datetime | None = None) -> int:
    """Adds study blocks for upcoming unsubmitted work. Existing blocks are never moved (you may have edited them)."""
    now = now or utcnow()
    horizon = now + timedelta(days=int(pref_float(s, "study_horizon_days")))
    day_start, day_end = time.fromisoformat(pref(s, "study_day_start")), time.fromisoformat(pref(s, "study_day_end"))
    block_max = timedelta(hours=pref_float(s, "study_block_max_hours"))
    daily_max = timedelta(hours=pref_float(s, "study_daily_max_hours"))
    min_block = timedelta(minutes=45)

    assessments = {a.id: a for a in visible_assessments(s)}
    blocks = s.exec(select(StudyBlock)).all()
    # drop future blocks for work that's submitted / gone / past due
    for b in blocks:
        a = assessments.get(b.assessment_id)
        if b.start > now and (a is None or a.submitted or a.due_at is None or a.due_at < now):
            s.delete(b)
    s.flush()
    blocks = s.exec(select(StudyBlock)).all()

    busy: list[list[datetime]] = []
    for _, d in class_events(s, tz):
        if isinstance(d.start, datetime) and d.end > now and not d.transparent:
            busy.append([d.start, d.end])
    for a in assessments.values():
        if a.is_exam and a.due_at and a.due_at > now:
            busy.append([a.due_at, a.due_at + exam_duration(a)])
    busy += [[b.start, b.end] for b in blocks]
    busy = _merge(busy)

    per_day: dict[date, timedelta] = defaultdict(timedelta)
    done: dict[str, timedelta] = defaultdict(timedelta)
    days_used: dict[str, set[date]] = defaultdict(set)
    for b in blocks:
        per_day[local(b.start, tz).date()] += b.end - b.start
        done[b.assessment_id] += b.end - b.start
        days_used[b.assessment_id].add(local(b.start, tz).date())

    todo = sorted((a for a in assessments.values()
                   if a.due_at and now < a.due_at <= horizon and not a.submitted and not (a.graded and a.score is not None)),
                  key=lambda a: a.due_at)
    created = 0
    for a in todo:
        remaining = timedelta(hours=default_effort(s, a)) - done[a.id]
        day = local(now, tz).date()
        last_day = local(a.due_at, tz).date()
        while remaining >= min_block and day <= last_day:
            if day in days_used[a.id]:
                day += timedelta(days=1)
                continue
            ws = datetime.combine(day, day_start, tz).astimezone(UTC).replace(tzinfo=None)
            we = datetime.combine(day, day_end, tz).astimezone(UTC).replace(tzinfo=None)
            ws = max(ws, now + timedelta(hours=1))
            we = min(we, a.due_at - timedelta(hours=1))
            budget = daily_max - per_day[day]
            cursor = ws
            for bs, be in busy + [[we, we]]:
                if be <= cursor:
                    continue
                gap_end = min(bs, we)
                length = min(gap_end - cursor, block_max, remaining, budget)
                if length >= min_block:
                    length = timedelta(minutes=int(length.total_seconds() // 60 // 15 * 15))
                    blk = StudyBlock(assessment_id=a.id, start=cursor, end=cursor + length)
                    s.add(blk)
                    busy = _merge(busy + [[blk.start, blk.end]])
                    per_day[day] += length
                    remaining -= length
                    days_used[a.id].add(day)
                    created += 1
                    break
                cursor = max(cursor, be)
                if cursor >= we:
                    break
            day += timedelta(days=1)
    s.commit()
    return created


# ---------------- workload ----------------

@dataclass
class WorkItem:
    a: Assessment
    weight: float  # % of the final grade (0 if unweighted)
    due: datetime  # local time


@dataclass
class WeekLoad:
    start: date
    entries: list[WorkItem]

    @property
    def items(self) -> list[Assessment]:
        return [e.a for e in self.entries]

    @property
    def weight(self) -> float:
        return sum(e.weight for e in self.entries)

    @property
    def open_entries(self) -> list[WorkItem]:
        return [e for e in self.entries if not e.a.submitted]

    @property
    def load(self) -> float:
        """Chart height: % of grades at stake, with a small floor per item so unweighted work still shows."""
        return sum(max(e.weight, 1.5) for e in self.entries)

    def by_course(self) -> list[tuple[str, float]]:
        out: dict[str, float] = {}
        for e in self.entries:
            out[e.a.course_code] = out.get(e.a.course_code, 0) + max(e.weight, 1.5)
        return sorted(out.items())

    @property
    def level(self) -> int:
        n = len(self.open_entries)
        w = sum(e.weight for e in self.open_entries)
        if w >= 40 or n >= 5:
            return 4
        if w >= 25 or n >= 3:
            return 3
        if w >= 10 or n >= 2:
            return 2
        return 1 if n else 0

    @property
    def level_name(self) -> str:
        return ["Free", "Light", "Moderate", "Busy", "Heavy"][self.level]


def assessment_weight(s: Session, a: Assessment) -> float:
    from .db import AssessmentGroup
    from .marks import compute
    if a.group_id is None:
        return 0.0
    g = s.get(AssessmentGroup, a.group_id)
    if not g or g.weight <= 0:
        return 0.0
    members = [x for x in s.exec(select(Assessment).where(Assessment.group_id == g.id)).all()]
    res = compute([g], members)
    scale = 1.0
    course = s.get(Course, a.course_code)
    if g.capped and course and course.cap_weight > 0:
        nominal = sum(x.weight for x in s.exec(select(AssessmentGroup).where(
            AssessmentGroup.course_code == a.course_code, AssessmentGroup.capped == True)).all())  # noqa: E712
        scale = min(1.0, course.cap_weight / nominal) if nominal else 1.0
    for gr in res.groups:
        for it in gr.items:
            if it.assessment.id == a.id:
                return it.weight * scale
    return 0.0


def workload(s: Session, tz, weeks: int = 12, start: date | None = None) -> list[WeekLoad]:
    today = start or datetime.now(tz).date()
    monday = today - timedelta(days=today.weekday())
    out = [WeekLoad(monday + timedelta(weeks=i), []) for i in range(weeks)]
    for a in visible_assessments(s):
        if not a.due_at:
            continue
        due = local(a.due_at, tz)
        idx = (due.date() - monday).days // 7
        if 0 <= idx < weeks:
            out[idx].entries.append(WorkItem(a, assessment_weight(s, a), due))
    for w in out:
        w.entries.sort(key=lambda e: e.due)
    return out


def courses_by_code(s: Session) -> dict[str, Course]:
    return {c.code: c for c in s.exec(select(Course)).all()}
