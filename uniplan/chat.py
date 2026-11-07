"""Ask-my-courses: full-text search (SQLite FTS5, local) + LLM answer with citations."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlmodel import Session, select

from .config import settings
from .db import Assessment, Item
from .llm import get_llm

STOP = set("a an the of to in on for and or is are was be do does did what when where which who how my i me it this that with at by from about any there their".split())


@dataclass
class Answer:
    text: str
    sources: list[Item]
    model: str


def search(s: Session, query: str, limit: int = 8) -> list[Item]:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", query.lower()) if w not in STOP and len(w) > 1]
    if not words:
        return []
    fts = " OR ".join(f'"{w}"*' for w in words[:12])
    rows = s.exec(text("SELECT item_id FROM item_fts WHERE item_fts MATCH :q ORDER BY bm25(item_fts, 0, 2.0, 3.0, 1.0) LIMIT :n")
                  .bindparams(q=fts, n=limit)).all()
    ids = [r[0] for r in rows]
    items = {i.id: i for i in s.exec(select(Item).where(Item.id.in_(ids))).all()}
    return [items[i] for i in ids if i in items]


def ask(s: Session, question: str) -> Answer:
    tz = settings().tz
    hits = search(s, question)
    upcoming = s.exec(select(Assessment).where(Assessment.hidden == False, Assessment.duplicate_of == None,  # noqa: E711,E712
                                               Assessment.due_at != None).order_by(Assessment.due_at)).all()  # noqa: E711
    from .planner import hidden_codes
    hidden = hidden_codes(s)
    upcoming = [a for a in upcoming if a.course_code not in hidden]
    now = datetime.now(UTC).replace(tzinfo=None)
    deadlines = "\n".join(
        f"- {a.course_code} {a.name}: {a.due_at.replace(tzinfo=UTC).astimezone(tz):%a %d %b %H:%M}"
        f"{' (submitted)' if a.submitted else ''}{f' score {a.score:g}/{a.points_possible:g}' if a.graded and a.score is not None and a.points_possible else ''}"
        for a in upcoming if a.due_at >= now)[:4000]
    ctx = "\n\n".join(f"[{n}] {i.source} {i.kind} | {i.course_code or ''} | {i.title}\n{i.body[:2500]}" for n, i in enumerate(hits, 1))
    prompt = (f"Question: {question}\n\nKnown upcoming deadlines:\n{deadlines or '(none)'}\n\n"
              f"Course material excerpts:\n{ctx or '(no matching material found)'}")
    system = (f"You answer an ANU student's questions about their courses using ONLY the excerpts and deadlines given. "
              f"Today is {datetime.now(tz):%A %d %B %Y}. Cite excerpts like [1], [2]. If the answer isn't there, say so "
              f"plainly and suggest where to check. Be brief.")
    out, model = get_llm().generate(prompt, system, None, purpose="chat")
    return Answer(str(out).strip(), hits, model)
