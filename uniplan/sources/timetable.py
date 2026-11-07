"""ANU timetable iCal feed. Feed UIDs are positional (uid0, uid1...) so we build our own stable key."""
from __future__ import annotations

import re
from datetime import date, datetime, time

import requests
from icalendar import Calendar

from ..config import Settings
from ..db import to_utc_naive
from .base import FetchResult, FTimetable, SourceUnavailable, chash, course_codes

ACTIVITY_NAMES = {
    "Lec": "Lecture", "Tut": "Tutorial", "Com": "Computer Lab", "Wor": "Workshop", "Asm": "Assessment",
    "Lab": "Lab", "Sem": "Seminar", "Pra": "Practical", "Drp": "Drop-in", "Stu": "Studio", "Exa": "Exam",
}


def activity_label(code: str) -> str:
    m = re.match(r"([A-Za-z]{3})", code or "")
    return f"{ACTIVITY_NAMES.get(m.group(1), m.group(1))} {code[3:]}".strip() if m else code


def parse_feed(content: bytes, tz) -> list[FTimetable]:
    cal = Calendar.from_ical(content)
    out: list[FTimetable] = []
    for e in cal.walk("VEVENT"):
        start, end = e.decoded("DTSTART"), e.decoded("DTEND") if e.get("DTEND") else None
        if isinstance(start, date) and not isinstance(start, datetime):
            start = datetime.combine(start, time(0), tz)
        if end is None:
            end = start
        elif isinstance(end, date) and not isinstance(end, datetime):
            end = datetime.combine(end, time(0), tz)
        if start.tzinfo is None:
            start, end = start.replace(tzinfo=tz), end.replace(tzinfo=tz)
        summary = str(e.get("SUMMARY", ""))
        desc = str(e.get("DESCRIPTION", ""))
        # Description first line looks like "COMP3670_S2_1_8688, AsmA, 01"
        first = desc.splitlines()[0] if desc else ""
        codes = course_codes(first) or course_codes(summary)
        code = codes[0] if codes else ""
        parts = [p.strip() for p in first.split(",")]
        activity = parts[1] if len(parts) > 1 else (summary.rsplit(",", 1)[-1].strip() if "," in summary else "")
        name = re.sub(r"\s*\(Class:.*?\)", "", summary.split(",")[0]).strip()
        s_utc, e_utc = to_utc_naive(start), to_utc_naive(end)
        out.append(FTimetable(
            key=chash(code or name, activity, s_utc.isoformat()), course_code=code, course_name=name,
            activity=activity, start=s_utc, end=e_utc, location=str(e.get("LOCATION", "")), description=desc,
        ))
    return out


def fetch(cfg: Settings) -> FetchResult:
    if not cfg.timetable_url:
        raise SourceUnavailable("TIMETABLE_URL not set")
    r = requests.get(cfg.timetable_url.replace("webcal://", "https://"), timeout=40)
    r.raise_for_status()
    events = parse_feed(r.content, cfg.tz)
    return FetchResult(timetable=events, meta={"events": len(events)})
