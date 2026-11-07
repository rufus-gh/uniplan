"""SQLite models. All datetimes are stored as naive UTC."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from pydantic import NaiveDatetime
from sqlalchemy import text
from sqlmodel import Field, Session, SQLModel, create_engine, select

from .config import settings


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def to_utc_naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


class Course(SQLModel, table=True):
    code: str = Field(primary_key=True)  # primary course code, e.g. COMP3670
    name: str = ""
    all_codes: str = ""  # "COMP3670/COMP6670"
    canvas_id: int | None = None
    ed_id: int | None = None
    gradescope_id: str | None = None
    active: bool = True
    weights_confirmed: bool = False
    weights_note: str = ""
    hidden: bool = False  # you hid it: no marks, calendar, study blocks, digest or LLM work
    weights_proposal: str = ""  # JSON from the LLM reading the Canvas course pages
    weights_proposal_hash: str = ""  # hash of the text it read, so it only re-reads when pages change
    cap_weight: float = 0.0  # if > 0: the 'capped' groups together count for at most this many % of the final grade


class Item(SQLModel, table=True):
    """Any piece of text content: announcement, Ed thread, email, page."""
    id: str = Field(primary_key=True)
    source: str
    kind: str
    course_code: str | None = Field(default=None, index=True)
    title: str = ""
    body: str = ""
    url: str = ""
    author: str = ""
    flags: str = ""
    posted_at: NaiveDatetime | None = None
    content_hash: str = ""
    first_seen: NaiveDatetime = Field(default_factory=utcnow)
    last_changed: NaiveDatetime = Field(default_factory=utcnow)
    processed_hash: str = ""
    category: str | None = None
    importance: int | None = None
    reason: str = ""
    summary: str = ""
    llm_model: str = ""
    dismissed: bool = False


class AssessmentGroup(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_code: str = Field(index=True)
    name: str
    weight: float = 0.0
    source: str = "canvas"  # canvas | llm | manual
    canvas_group_id: int | None = None
    drop_lowest: int = 0
    hurdle: str = ""
    capped: bool = False  # part of the course's combined cap (Course.cap_weight)
    sort: int = 0


class Assessment(SQLModel, table=True):
    id: str = Field(primary_key=True)  # canvas:<id> | gradescope:<id> | llm:<hash>
    course_code: str = Field(index=True)
    source: str
    name: str
    url: str = ""
    due_at: NaiveDatetime | None = None
    points_possible: float | None = None
    score: float | None = None
    submitted: bool = False
    graded: bool = False
    group_id: int | None = None
    group_locked: bool = False
    canvas_group_id: int | None = None
    is_exam: bool = False
    location: str = ""
    details: str = ""
    duplicate_of: str | None = None
    excluded: bool = False
    hidden: bool = False
    effort_hours: float | None = None
    due_overridden: bool = False
    first_seen: NaiveDatetime = Field(default_factory=utcnow)
    updated_at: NaiveDatetime = Field(default_factory=utcnow)
    graded_at: NaiveDatetime | None = None


class TimetableEvent(SQLModel, table=True):
    key: str = Field(primary_key=True)  # stable: code|activity|start
    course_code: str = ""
    course_name: str = ""
    activity: str = ""
    start: NaiveDatetime
    end: NaiveDatetime
    location: str = ""
    description: str = ""
    seen_at: NaiveDatetime = Field(default_factory=utcnow)


class Override(SQLModel, table=True):
    """A class change found in an announcement/email that the timetable feed doesn't show."""
    id: int | None = Field(default=None, primary_key=True)
    item_id: str
    course_code: str
    activity: str = ""
    original_date: str | None = None
    change: str  # cancelled | moved | room_change | online
    new_date: str | None = None
    new_start_time: str | None = None
    new_location: str | None = None
    confidence: float = 0.0
    evidence: str = ""
    status: str = "pending"  # applied | pending | rejected | resolved | unmatched
    target_key: str | None = None
    created_at: NaiveDatetime = Field(default_factory=utcnow)


class Review(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    kind: str  # conflict | class_change | deadline_change | weights
    ref: str = Field(index=True)  # dedupe key
    title: str
    detail: str = ""
    payload: str = "{}"
    status: str = "open"  # open | resolved
    resolution: str = ""
    created_at: NaiveDatetime = Field(default_factory=utcnow)

    def data(self) -> dict[str, Any]:
        return json.loads(self.payload or "{}")


class CalEvent(SQLModel, table=True):
    """Bookkeeping for events UniPlan manages on the CalDAV server."""
    uid: str = Field(primary_key=True)
    calendar: str
    source_hash: str = ""  # semantic hash of what the source wanted when we last wrote
    written_hash: str = ""  # semantic hash of what we wrote (to detect user edits)
    desired_ics: str = ""
    user_modified: bool = False
    deleted_by_user: bool = False
    in_conflict: bool = False
    updated_at: NaiveDatetime = Field(default_factory=utcnow)


class StudyBlock(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    assessment_id: str = Field(index=True)
    start: NaiveDatetime
    end: NaiveDatetime


class SyncRun(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    started_at: NaiveDatetime = Field(default_factory=utcnow)
    finished_at: NaiveDatetime | None = None
    status: str = "running"  # running | ok | partial | failed
    trigger: str = "manual"
    sources: str = "{}"
    digest: str = "{}"
    log: str = ""


class Pref(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str


class PushSubscription(SQLModel, table=True):
    """A device that turned on notifications in the home-screen app."""
    endpoint: str = Field(primary_key=True)
    p256dh: str
    auth: str


class LLMCall(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    at: NaiveDatetime = Field(default_factory=utcnow)
    provider: str
    model: str
    ok: bool
    purpose: str = ""
    error: str = ""


DEFAULT_PREFS: dict[str, str] = {
    "alarm_due_minutes": "1440,180",  # 1 day and 3 hours before
    "alarm_exam_minutes": "2880,120",
    "study_day_start": "09:00",
    "study_day_end": "21:00",
    "study_block_max_hours": "2",
    "study_daily_max_hours": "4",
    "study_horizon_days": "21",
    "effort_assignment_hours": "6",
    "effort_quiz_hours": "1",
    "effort_exam_hours": "10",
    "auto_apply_confidence": "0.8",
}

_engine = None


def engine():
    global _engine
    if _engine is None:
        _engine = create_engine(f"sqlite:///{settings().db_path}", connect_args={"check_same_thread": False})
        with _engine.connect() as c:
            c.execute(text("PRAGMA journal_mode=WAL"))
    return _engine


def _migrate() -> None:
    """Add columns that newer versions of the models define (SQLite create_all never alters tables)."""
    with engine().begin() as c:
        for table in SQLModel.metadata.sorted_tables:
            have = {row[1] for row in c.exec_driver_sql(f"PRAGMA table_info('{table.name}')")}
            if not have:
                continue
            for col in table.columns:
                if col.name in have:
                    continue
                sqltype = col.type.compile(c.dialect)
                if sqltype in ("BOOLEAN", "INTEGER", "FLOAT", "REAL") and not col.nullable:
                    default = "0"
                elif "CHAR" in sqltype or "TEXT" in sqltype:
                    default = "''"
                else:
                    default = "NULL"
                c.exec_driver_sql(f"ALTER TABLE {table.name} ADD COLUMN {col.name} {sqltype} DEFAULT {default}")


def init_db() -> None:
    SQLModel.metadata.create_all(engine())
    _migrate()
    with engine().begin() as c:
        c.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(item_id UNINDEXED, course, title, body)"))
    with session() as s:
        for k, v in DEFAULT_PREFS.items():
            if not s.get(Pref, k):
                s.add(Pref(key=k, value=v))
        s.commit()


def session() -> Session:
    return Session(engine(), expire_on_commit=False)


def pref(s: Session, key: str) -> str:
    p = s.get(Pref, key)
    return p.value if p else DEFAULT_PREFS.get(key, "")


def pref_float(s: Session, key: str) -> float:
    return float(pref(s, key))


def pref_minutes_list(s: Session, key: str) -> list[int]:
    return [int(x) for x in pref(s, key).split(",") if x.strip()]


def index_item(s: Session, item: Item) -> None:
    s.exec(text("DELETE FROM item_fts WHERE item_id = :i").bindparams(i=item.id))
    s.exec(text("INSERT INTO item_fts (item_id, course, title, body) VALUES (:i, :c, :t, :b)").bindparams(
        i=item.id, c=item.course_code or "", t=item.title, b=item.body))


__all__ = ["select", "Session"]
