"""ANU Programs & Courses class summaries (public pages) - the official assessment table for a class."""
from __future__ import annotations

import re
from datetime import datetime

import requests

from .base import html_to_text

PC_LINK = re.compile(r"https?://programsandcourses\.anu\.edu\.au/(?:\d{4}/)?course/[A-Z]{4}\d{4}/[^\"'<>\s]+", re.I)
SEMESTERS = {"S1": "First Semester", "S2": "Second Semester", "SU": "Summer Session", "WI": "Winter Session"}


def find_links(html: str | None) -> list[str]:
    seen: list[str] = []
    for u in PC_LINK.findall(html or ""):
        u = u.rstrip(".,)")
        if u not in seen:
            seen.append(u)
    return seen


def pick_link(links: list[str], codes: list[str]) -> str | None:
    for code in codes:  # prefer the primary (undergrad) code
        for u in links:
            if f"/course/{code}/".lower() in u.lower():
                return u
    return links[0] if links else None


def guess_url(code: str, timetable_desc: str, year: int | None = None) -> str | None:
    """From a timetable description line like 'COMP3670_S2_1_8688, LecA, 01'."""
    m = re.search(rf"{code}_(S1|S2|SU|WI)\w*?_(\d{{4}})\b", timetable_desc or "")
    if not m:
        return None
    sem = SEMESTERS[m.group(1)].replace(" ", "%20")
    return f"https://programsandcourses.anu.edu.au/{year or datetime.now().year}/course/{code}/{sem}/{m.group(2)}"


def normalise(url: str) -> str:
    if re.search(r"anu\.edu\.au/course/", url):
        return url.replace("anu.edu.au/course/", f"anu.edu.au/{datetime.now().year}/course/", 1)
    return url


def fetch_summary(url: str) -> str | None:
    """Returns the 'Assessment Summary' section (plus the assessment details that follow), or None.
    Year-less links (…/course/CODE/…) don't show class details, so the current year is added."""
    url = normalise(url)
    try:
        r = requests.get(url, timeout=30, headers={"User-Agent": "UniPlan personal planner"})
    except requests.RequestException:
        return None
    if not r.ok:
        return None
    text = html_to_text(r.text)
    i = text.lower().find("assessment summary")
    if i < 0:
        return None
    end = text.lower().find("\npolicies", i)
    section = text[i: end if end > 0 else i + 4000]
    details = ""
    j = text.lower().find("assessment task 1", end if end > 0 else i)
    if j > 0:
        details = "\n\nAssessment details:\n" + text[j: j + 5000]
    return re.sub(r"\n\s*\n+", "\n", section + details).strip()[:9000]
