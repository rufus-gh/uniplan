"""Plain data returned by every source fetcher. The pipeline turns these into DB rows."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime

from bs4 import BeautifulSoup

CODE_RE = re.compile(r"\b([A-Z]{3,5}\d{4})")


def course_codes(text: str | None) -> list[str]:
    seen: list[str] = []
    for c in CODE_RE.findall(text or ""):
        if c not in seen:
            seen.append(c)
    return seen


def html_to_text(html: str | None) -> str:
    if not html:
        return ""
    text = BeautifulSoup(html, "html.parser").get_text("\n")
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def chash(*parts) -> str:
    return hashlib.sha256("\x1f".join("" if p is None else str(p) for p in parts).encode()).hexdigest()[:20]


@dataclass
class FCourse:
    code: str
    name: str = ""
    all_codes: str = ""
    canvas_id: int | None = None
    ed_id: int | None = None
    gradescope_id: str | None = None


@dataclass
class FItem:
    id: str
    source: str
    kind: str
    course_code: str | None
    title: str
    body: str
    url: str = ""
    posted_at: datetime | None = None
    author: str = ""
    flags: str = ""
    needs_llm: bool = True


@dataclass
class FAssessment:
    id: str
    course_code: str
    source: str
    name: str
    url: str = ""
    due_at: datetime | None = None
    points_possible: float | None = None
    score: float | None = None
    submitted: bool = False
    graded: bool = False
    canvas_group_id: int | None = None
    excluded: bool = False


@dataclass
class FGroup:
    course_code: str
    canvas_group_id: int
    name: str
    weight: float
    sort: int = 0


@dataclass
class FTimetable:
    key: str
    course_code: str
    course_name: str
    activity: str
    start: datetime
    end: datetime
    location: str
    description: str


@dataclass
class FetchResult:
    courses: list[FCourse] = field(default_factory=list)
    items: list[FItem] = field(default_factory=list)
    assessments: list[FAssessment] = field(default_factory=list)
    groups: list[FGroup] = field(default_factory=list)
    timetable: list[FTimetable] | None = None
    meta: dict = field(default_factory=dict)


class SourceUnavailable(Exception):
    """Source not configured or needs user action (e.g. re-login). Not a crash."""
