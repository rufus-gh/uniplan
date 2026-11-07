from datetime import UTC, datetime, timedelta

import re

from fastapi.testclient import TestClient
from sqlmodel import select

from uniplan.calendar_sync import MemoryStore
from uniplan.config import settings
from uniplan.db import Assessment, AssessmentGroup, Course, Item, Override, StudyBlock, TimetableEvent, index_item
from uniplan.extract import resolve_overrides
from uniplan.planner import desired_events, plan_study


EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF]")


def seed(s, now):
    s.add(Course(code="COMP3670", name="ML", all_codes="COMP3670/COMP6670", canvas_id=1))
    s.add(AssessmentGroup(id=1, course_code="COMP3670", name="Assignments", weight=40, canvas_group_id=11))
    s.add(Assessment(id="canvas:1", course_code="COMP3670", source="canvas", name="Assignment 3", group_id=1,
                     points_possible=100, due_at=now + timedelta(days=3)))
    s.add(Assessment(id="canvas:2", course_code="COMP3670", source="canvas", name="Assignment 2", group_id=1,
                     points_possible=100, score=75, graded=True, submitted=True, due_at=now - timedelta(days=5)))
    for d in range(4):
        start = (now + timedelta(days=d)).replace(hour=0, minute=0, second=0, microsecond=0)  # 11:00 AEDT
        s.add(TimetableEvent(key=f"k{d}", course_code="COMP3670", course_name="ML", activity="LecA", start=start,
                             end=start + timedelta(hours=2), location="Hall"))
    it = Item(id="canvas:announcement:1", source="canvas", kind="announcement", course_code="COMP3670",
              title="Exam permitted materials", body="One A4 page of notes is permitted in the final exam.", importance=2,
              summary="One A4 page allowed", posted_at=now)
    s.add(it)
    index_item(s, it)
    s.commit()


def test_study_blocks_avoid_classes(s):
    now = datetime(2026, 11, 9, 0, 0)
    seed(s, now)
    n = plan_study(s, settings().tz, now)
    assert n >= 3
    blocks = s.exec(select(StudyBlock)).all()
    classes = s.exec(select(TimetableEvent)).all()
    total = sum((b.end - b.start).total_seconds() for b in blocks) / 3600
    assert total <= 6.01
    for b in blocks:
        assert b.end <= now + timedelta(days=3) - timedelta(hours=1)
        for c in classes:
            assert b.end <= c.start or b.start >= c.end
    # re-running doesn't add more
    assert plan_study(s, settings().tz, now) == 0


def test_override_applied_into_calendar(s):
    now = datetime(2026, 11, 9, 0, 0)
    seed(s, now)
    ov = Override(item_id="canvas:announcement:1", course_code="COMP3670", activity="LecA", original_date="2026-11-10",
                  change="cancelled", confidence=0.95, evidence="No lecture tomorrow")
    s.add(ov)
    s.commit()
    notes = resolve_overrides(s, settings().tz)
    s.commit()
    assert notes and s.get(Override, ov.id).status == "applied"
    evs = {e.uid: e for e in desired_events(s, settings().tz)}
    cancelled = [e for e in evs.values() if e.summary.startswith("Cancelled")]
    assert len(cancelled) == 1


def test_web_pages_render(s, monkeypatch):
    now = datetime.now(UTC).replace(tzinfo=None)
    seed(s, now)
    from uniplan.web import app as webapp

    monkeypatch.setattr(webapp, "CalDAVStore", MemoryStore)
    with TestClient(webapp.app) as c:
        assert c.get("/").status_code == 401
        c.auth = ("uniplan", "test-pw")
        for path in ["/", "/calendar", "/calendar?week=1", "/courses", "/courses/COMP3670", "/review", "/workload",
                     "/ask", "/health", "/settings", "/study"]:
            r = c.get(path)
            assert r.status_code == 200, (path, r.text[:500])
            assert not EMOJI.search(r.text), (path, EMOJI.findall(r.text))
        wl = c.get("/workload").text
        assert "Grades at stake each week" in wl and "Assignment 3" in wl and "Week by week" in wl
        assert c.get("/workload?d=2026-08-01&weeks_n=20").status_code == 200
        for q in ("?view=month", "?view=week", "?view=month&d=2026-02-01", "?view=week&d=2026-12-31", "?week=2", "?d=garbage"):
            r = c.get("/calendar" + q)
            assert r.status_code == 200 and "Month" in r.text and "Week" in r.text, q
        week = c.get("/calendar?view=week").text
        assert "Lecture" in week or "Assignment 3" in week
        r = c.post("/courses/COMP3670/whatif", data={"uniform": "80"})
        assert r.status_code == 200 and "Projected final" in r.text
        r = c.post("/courses/COMP3670/groups", data={"w_1": "40", "n_1": "Assignments", "d_1": "0", "new_name": "Final exam",
                                                     "new_weight": "60", "confirm": "1"}, follow_redirects=False)
        assert r.status_code == 303
        assert "Final exam" in c.get("/courses/COMP3670?tab=weightings").text
        for tab in ("overview", "assessments", "weightings", "whatif"):
            assert c.get(f"/courses/COMP3670?tab={tab}").status_code == 200
        assert c.get("/courses/COMP3670?tab=assessments&all=1").status_code == 200
        r = c.post("/assessments/canvas:1/edit", data={"effort_hours": "3"}, follow_redirects=False)
        assert r.status_code == 303


def test_week_lanes_side_by_side():
    from uniplan.web.app import CalItem, _lanes, _split_title
    t = datetime(2026, 11, 9, 10, 0)
    a = CalItem("a", "classes", "A", "", t, t + timedelta(hours=2), "", "", False)
    b = CalItem("b", "study", "B", "", t + timedelta(minutes=30), t + timedelta(hours=1), "", "", False)
    c = CalItem("c", "due", "C", "", t + timedelta(hours=3), t + timedelta(hours=4), "", "", False)
    _lanes([a, b, c])
    assert (a.lane, b.lane, a.lanes, b.lanes) == (0, 1, 2, 2)
    assert (c.lane, c.lanes) == (0, 1)
    assert _split_title("Study · COMP3670 Final Exam") == ("COMP3670", "Study: Final Exam")
    assert _split_title("COMP3670 · Assignment 3 due") == ("COMP3670", "Assignment 3 due")
    assert _split_title("Cancelled · MATH1116 Lecture D") == ("MATH1116", "Cancelled: Lecture D")


def test_compiled_css_is_served_without_cdn():
    from uniplan.web import app as webapp
    with TestClient(webapp.app) as c:
        r = c.get("/static/app.css")
        assert r.status_code == 200 and ".bg-brand-400" in r.text and ".badge-brand" in r.text
        c.auth = ("uniplan", "test-pw")
        page = c.get("/").text
        assert "cdn.tailwindcss.com" not in page and "/static/app.css?v=" in page
        # interactive bits (Ask, what-if, dismiss) need htmx, served locally
        assert '<script src="/static/htmx.min.js' in page
        js = c.get("/static/htmx.min.js")
        assert js.status_code == 200 and "htmx" in js.text[:2000]


def test_answer_formatting_is_safe():
    from uniplan.web.app import answer_html
    h = str(answer_html("Bring:\n* **One A4 page** [2]\n* a pen [9]\n<script>alert(1)</script>", 3))
    assert "<strong" in h and "One A4 page" in h and 'href="#src-2"' in h and "[9]" in h
    assert "<script>" not in h and "&lt;script&gt;" in h and h.count("<li") == 2


def test_pages_are_not_cached():
    from uniplan.web import app as webapp
    with TestClient(webapp.app) as c:
        c.auth = ("uniplan", "test-pw")
        assert c.get("/").headers["cache-control"] == "no-store"
        assert "no-store" not in c.get("/static/app.css").headers.get("cache-control", "")
