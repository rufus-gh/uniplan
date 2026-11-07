import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlmodel import select

from uniplan import extract
from uniplan.calendar_sync import MemoryStore
from uniplan.config import settings
from uniplan.db import Assessment, AssessmentGroup, Course, Item, TimetableEvent
from uniplan.marks import compute
from uniplan.planner import desired_events, visible_assessments
from uniplan.sources import anu_courses

SUMMARY = """Assessment Summary
Assessment task
Value
Weekly Assignments
30 %
Continuous Assessment 1
20 %
Continuous Assessment 2
20 %
End of Semester Examination
30 %"""


def seed(s):
    s.add(Course(code="MATH1116", name="Adv Maths", all_codes="MATH1116", canvas_id=1))
    s.add(AssessmentGroup(id=1, course_code="MATH1116", name="Continuous Assessment", weight=40, canvas_group_id=10))
    s.add(AssessmentGroup(id=2, course_code="MATH1116", name="Assignments", weight=60, canvas_group_id=11))
    for i, (name, gid, score) in enumerate([("CA1", 1, 18), ("CA2", 1, 16), ("Assignment 1", 2, 9), ("Assignment 2", 2, 10)]):
        s.add(Assessment(id=f"canvas:{i}", course_code="MATH1116", source="canvas", name=name, group_id=gid,
                         canvas_group_id=10 + gid - 1, points_possible=20 if "CA" in name else 10, score=score, graded=True))
    s.add(Item(id="anu:classsummary:MATH1116", source="anu", kind="class_summary", course_code="MATH1116",
               title="MATH1116 class summary", body=SUMMARY))
    s.commit()


class FakeLLM:
    def __init__(self, result):
        self.result, self.calls = result, 0

    def generate(self, prompt, system, schema, purpose=""):
        self.calls += 1
        assert "Weekly Assignments" in prompt and "- CA1" in prompt
        return self.result, "fake:model"


def proposal():
    G = extract.ProposedGroup
    return extract.ProposedWeights(found=True, note="", cap_weight=0, groups=[
        G(name="Weekly Assignments", weight=30, assessments=["Assignment 1", "Assignment 2"], keep_best=0, capped=False, notes=""),
        G(name="Continuous Assessment 1", weight=20, assessments=["CA1"], keep_best=0, capped=False, notes=""),
        G(name="Continuous Assessment 2", weight=20, assessments=["CA2"], keep_best=0, capped=False, notes=""),
        G(name="End of Semester Examination", weight=30, assessments=[], keep_best=0, capped=False, notes="hurdle: 40%"),
    ])


def test_find_and_apply_weights(s, monkeypatch):
    seed(s)
    llm = FakeLLM(proposal())
    monkeypatch.setattr(extract, "get_llm", lambda: llm)
    c = s.get(Course, "MATH1116")
    prop = extract.find_weights(s, c)
    assert prop["found"] and not prop["agrees_with_canvas"]
    assert prop["groups"][1]["assessments"] == ["canvas:0"]
    extract.find_weights(s, c)  # unchanged text -> no second LLM call
    assert llm.calls == 1

    assert extract.apply_weights(s, c)
    s.commit()
    groups = s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == "MATH1116")).all()
    assert sorted(g.weight for g in groups if g.weight > 0) == [20, 20, 30, 30]
    assert all(g.weight == 0 for g in groups if g.canvas_group_id)  # old Canvas groups neutralised
    m = compute(groups, s.exec(select(Assessment)).all())
    # CA1 18/20 (20%) + CA2 16/20 (20%) + assignments 19/20 (30%) -> 70% graded, exam outstanding
    assert m.graded_weight == 70
    assert round(m.contribution, 2) == round(0.9 * 20 + 0.8 * 20 + 0.95 * 30, 2)


def test_guess_and_normalise_urls():
    assert anu_courses.guess_url("COMP3670", "COMP3670_S2_1_8688, LecA, 01", 2026) == \
        "https://programsandcourses.anu.edu.au/2026/course/COMP3670/Second%20Semester/8688"
    links = anu_courses.find_links('<a href="https://programsandcourses.anu.edu.au/course/STAT6013/Second%20Semester/7566">x</a>'
                                   '<a href="https://programsandcourses.anu.edu.au/course/STAT2001/Second%20Semester/8362">y</a>')
    assert anu_courses.pick_link(links, ["STAT2001", "STAT6013"]).endswith("/STAT2001/Second%20Semester/8362")
    assert "/2" in anu_courses.normalise(links[0]).split("anu.edu.au")[1][:3]


def test_hidden_course_disappears_everywhere(s, monkeypatch):
    seed(s)
    now = datetime.now(UTC).replace(tzinfo=None)
    s.add(Course(code="CSS0001", name="CSS Community", all_codes="CSS0001", canvas_id=2))
    s.add(Assessment(id="canvas:css", course_code="CSS0001", source="canvas", name="Grant EOI", due_at=now + timedelta(days=5)))
    s.add(TimetableEvent(key="t1", course_code="CSS0001", activity="WorA", start=now + timedelta(days=1),
                         end=now + timedelta(days=1, hours=1)))
    s.commit()
    assert any(a.id == "canvas:css" for a in visible_assessments(s))

    from uniplan.web import app as webapp
    monkeypatch.setattr(webapp, "CalDAVStore", MemoryStore)
    with TestClient(webapp.app) as cl:
        cl.auth = ("uniplan", "test-pw")
        r = cl.post("/courses/CSS0001/hide", data={"hidden": "1"}, follow_redirects=False)
        assert r.status_code == 303
        assert "CSS0001" not in cl.get("/courses").text
        page = cl.get("/settings").text
        assert "Hidden courses" in page and "Unhide" in page and "CSS0001" in page
        assert "CSS0001" not in cl.get("/").text
        assert "Hide course" in cl.get("/courses/MATH1116").text
    s.expire_all()
    assert s.get(Course, "CSS0001").hidden
    assert not any(a.course_code == "CSS0001" for a in visible_assessments(s))
    assert not any("CSS0001" in e.summary for e in desired_events(s, settings().tz))


def test_proposal_panel_renders(s, monkeypatch):
    seed(s)
    monkeypatch.setattr(extract, "get_llm", lambda: FakeLLM(proposal()))
    extract.find_weights(s, s.get(Course, "MATH1116"))
    s.commit()
    from uniplan.web import app as webapp
    monkeypatch.setattr(webapp, "CalDAVStore", MemoryStore)
    with TestClient(webapp.app) as cl:
        cl.auth = ("uniplan", "test-pw")
        page = cl.get("/courses/MATH1116?tab=weightings").text
        assert "Use these weightings" in page and "End of Semester Examination" in page and "hurdle: 40%" in page
        r = cl.post("/courses/MATH1116/weights/apply", follow_redirects=False)
        assert r.status_code == 303
        assert json.loads(s.get(Course, "MATH1116").weights_proposal)["found"]


def test_apply_cap_and_keep_best(s, monkeypatch):
    seed(s)
    G = extract.ProposedGroup
    res = extract.ProposedWeights(found=True, note="", cap_weight=22, groups=[
        G(name="Weekly Assignments", weight=25, assessments=["Assignment 1", "Assignment 2"], keep_best=1, capped=True, notes=""),
        G(name="Continuous Assessment 1", weight=4, assessments=["CA1"], keep_best=0, capped=True, notes=""),
        G(name="Continuous Assessment 2", weight=23, assessments=["CA2"], keep_best=0, capped=False, notes=""),
        G(name="Exam", weight=55, assessments=[], keep_best=0, capped=False, notes=""),
    ])
    monkeypatch.setattr(extract, "get_llm", lambda: FakeLLM(res))
    c = s.get(Course, "MATH1116")
    prop = extract.find_weights(s, c)
    assert prop["cap_weight"] == 22 and not prop["agrees_with_canvas"]
    assert extract.apply_weights(s, c)
    s.commit()
    assert s.get(Course, "MATH1116").cap_weight == 22
    groups = {g.name: g for g in s.exec(select(AssessmentGroup).where(AssessmentGroup.weight > 0)).all()}
    # "best 1" isn't stated in the course text, so the repair step drops it
    assert groups["Weekly Assignments"].capped and groups["Weekly Assignments"].drop_lowest == 0
    m = compute(list(groups.values()), s.exec(select(Assessment)).all(), cap=22)
    assert m.total_weight == 100


def test_repair_fixes_sloppy_cap_answer():
    groups = [{"name": n, "weight": w, "capped": True, "keep_best": k, "notes": "capped at 22%", "assessments": []}
              for n, w, k in [("Assignments", 21, 1), ("Quizzes", 4, 14), ("Labs", 4, 8), ("Mid", 23, 1), ("Final", 55, 1)]]
    p = {"cap_weight": 22, "note": "", "groups": groups}
    extract._repair_proposal(p, "Only your best 14 quizzes count. Only your best 8 exercises count. Capped at 22%.")
    assert [(g["capped"], g["keep_best"]) for g in p["groups"]] == [(True, 0), (True, 14), (True, 8), (False, 0), (False, 0)]


def test_repair_drops_impossible_cap():
    p = {"cap_weight": 50, "note": "", "groups": [{"name": "A", "weight": 40, "capped": True, "keep_best": 0, "notes": ""},
                                                   {"name": "B", "weight": 60, "capped": False, "keep_best": 0, "notes": ""}]}
    extract._repair_proposal(p, "")
    assert p["cap_weight"] == 0 and not any(g["capped"] for g in p["groups"])


def test_migration_backfills_new_numeric_columns(s):
    from uniplan import db
    with db.engine().begin() as c:
        c.exec_driver_sql("DROP TABLE course")
        c.exec_driver_sql("CREATE TABLE course (code VARCHAR PRIMARY KEY, name VARCHAR, all_codes VARCHAR, canvas_id INTEGER,"
                          " ed_id INTEGER, gradescope_id VARCHAR, active BOOLEAN, weights_confirmed BOOLEAN, weights_note VARCHAR)")
        c.exec_driver_sql("INSERT INTO course VALUES ('X1234', 'x', 'X1234', 1, NULL, NULL, 1, 0, '')")
    db.init_db()
    with db.session() as s2:
        c = s2.get(Course, "X1234")
        assert c.cap_weight == 0 and c.hidden is False and c.weights_proposal == ""


def test_unhide_from_settings_returns_to_settings(s, monkeypatch):
    seed(s)
    s.add(Course(code="CSS0001", name="CSS Community", all_codes="CSS0001", hidden=True))
    s.commit()
    from uniplan.web import app as webapp
    monkeypatch.setattr(webapp, "CalDAVStore", MemoryStore)
    with TestClient(webapp.app) as cl:
        cl.auth = ("uniplan", "test-pw")
        r = cl.post("/courses/CSS0001/hide", data={"hidden": "0", "next": "/settings?saved=unhidden"}, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/settings?saved=unhidden"
        assert "Course unhidden" in cl.get("/settings?saved=unhidden").text
        assert "CSS0001" in cl.get("/courses").text
        r = cl.post("/courses/CSS0001/hide", data={"hidden": "1", "next": "//evil.example"}, follow_redirects=False)
        assert r.headers["location"] == "/courses"
