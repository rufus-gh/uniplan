"""Match LLM-detected class changes to timetable events and apply them as an override layer."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from .db import Override, TimetableEvent

ACT_WORDS = {
    "lecture": "lec", "lec": "lec", "tutorial": "tut", "tut": "tut", "lab": "com", "computer": "com",
    "workshop": "wor", "assessment": "asm", "seminar": "sem", "practical": "pra", "studio": "stu",
}


def activity_prefix(activity: str) -> tuple[str | None, str | None]:
    """'LecA' -> ('lec','leca'); 'Lecture' -> ('lec',None); 'Tutorial 05' -> ('tut',None)."""
    a = (activity or "").strip().lower()
    if not a:
        return None, None
    m = re.fullmatch(r"([a-z]{3})([a-z])", a)
    if m and m.group(1) in ACT_WORDS.values():
        return m.group(1), a
    for word, pre in ACT_WORDS.items():
        if re.search(rf"\b{word}", a):
            return pre, None
    return None, None


def local_date(dt_utc: datetime, tz) -> date:
    return dt_utc.replace(tzinfo=UTC).astimezone(tz).date()


def find_candidates(ov: Override, events: list[TimetableEvent], tz, course_codes: set[str]) -> list[TimetableEvent]:
    cands = [e for e in events if e.course_code in course_codes]
    if ov.original_date:
        try:
            d = date.fromisoformat(ov.original_date)
            cands = [e for e in cands if local_date(e.start, tz) == d]
        except ValueError:
            return []
    else:
        return []  # without a date we can't safely pick an occurrence
    pre, exact = activity_prefix(ov.activity)
    if exact:
        ex = [e for e in cands if e.activity.lower() == exact]
        if ex:
            return ex
    if pre:
        cands = [e for e in cands if e.activity.lower().startswith(pre)]
    return cands


@dataclass
class Applied:
    start: datetime
    end: datetime
    location: str
    prefix: str
    note: str
    cancelled: bool = False


def apply(ov: Override, ev: TimetableEvent, tz) -> Applied:
    start, end, loc = ev.start, ev.end, ev.location
    dur = end - start
    note = f"Changed by an announcement: {ov.evidence}"
    if ov.change == "cancelled":
        return Applied(start, end, loc, "Cancelled ·", note, cancelled=True)
    if ov.change == "online":
        return Applied(start, end, ov.new_location or "Online", "Online ·", note)
    if ov.change == "room_change":
        return Applied(start, end, ov.new_location or loc, "Room change ·", note)
    # moved
    local = start.replace(tzinfo=UTC).astimezone(tz)
    d = date.fromisoformat(ov.new_date) if ov.new_date else local.date()
    t = time.fromisoformat(ov.new_start_time) if ov.new_start_time else local.time()
    new_start = datetime.combine(d, t, tz).astimezone(UTC).replace(tzinfo=None)
    return Applied(new_start, new_start + dur, ov.new_location or loc, "Moved ·", note)


def already_reflected(ov: Override, ev: TimetableEvent, tz) -> bool:
    """True when the feed itself now shows the change, so the override is no longer needed."""
    if ov.change in ("room_change", "online") and ov.new_location:
        return ov.new_location.lower() in (ev.location or "").lower()
    # A feed-side move changes the event's start, hence its key: the override's target disappears and the
    # pipeline marks it resolved. Nothing to check here.
    return False


def is_past(ev: TimetableEvent, now_utc: datetime) -> bool:
    return ev.end < now_utc - timedelta(days=1)
