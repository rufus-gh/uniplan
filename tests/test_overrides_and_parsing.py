from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from uniplan.db import Override, TimetableEvent
from uniplan.extract import name_similarity, norm_name, to_utc
from uniplan.overrides import activity_prefix, apply, find_candidates
from uniplan.sources.timetable import activity_label, parse_feed

TZ = ZoneInfo("Australia/Sydney")

FEED = b"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:uid0
DTSTAMP:20261101T000000Z
DTSTART;TZID=Australia/Melbourne:20261113T100000
DTEND;TZID=Australia/Melbourne:20261113T110000
SUMMARY:Intro to Machine Learning (Class: 8688), LecA
LOCATION:Melville Hall_Bldg 12_Rm G01
DESCRIPTION:COMP3670_S2_1_8688, LecA, 01\\nIntro to Machine Learning (Class: 8688)\\nStaff: -
END:VEVENT
BEGIN:VEVENT
UID:uid1
DTSTAMP:20261101T000000Z
DTSTART;TZID=Australia/Melbourne:20261113T140000
DTEND;TZID=Australia/Melbourne:20261113T150000
SUMMARY:Intro to Machine Learning (Class: 8688), TutA
LOCATION:Room 2
DESCRIPTION:COMP3670_S2_1_8688, TutA, 03\\nIntro to Machine Learning (Class: 8688)
END:VEVENT
END:VCALENDAR
"""


def events():
    return [TimetableEvent(key=f.key, course_code=f.course_code, course_name=f.course_name, activity=f.activity,
                           start=f.start, end=f.end, location=f.location) for f in parse_feed(FEED, TZ)]


def test_parse_feed_stable_keys():
    a, b = parse_feed(FEED, TZ), parse_feed(FEED, TZ)
    assert [e.key for e in a] == [e.key for e in b]
    e = a[0]
    assert (e.course_code, e.activity, e.course_name) == ("COMP3670", "LecA", "Intro to Machine Learning")
    assert e.start == datetime(2026, 11, 12, 23, 0)  # 10:00 AEDT = 23:00 UTC prev day


def test_activity_helpers():
    assert activity_prefix("LecA") == ("lec", "leca")
    assert activity_prefix("Lecture")[0] == "lec"
    assert activity_prefix("Tutorial 03")[0] == "tut"
    assert activity_label("ComA") == "Computer Lab A"


def test_match_and_apply_move():
    evs = events()
    ov = Override(item_id="x", course_code="COMP3670", activity="Lecture", original_date="2026-11-13", change="moved",
                  new_date="2026-11-16", new_start_time="14:00", confidence=0.9, evidence="moved to Monday 2pm")
    c = find_candidates(ov, evs, TZ, {"COMP3670"})
    assert len(c) == 1 and c[0].activity == "LecA"
    applied = apply(ov, c[0], TZ)
    assert applied.start.replace(tzinfo=UTC).astimezone(TZ).strftime("%Y-%m-%d %H:%M") == "2026-11-16 14:00"
    assert applied.end - applied.start == c[0].end - c[0].start


def test_no_date_no_match_and_cancel():
    evs = events()
    ov = Override(item_id="x", course_code="COMP3670", activity="Lecture", original_date=None, change="cancelled")
    assert find_candidates(ov, evs, TZ, {"COMP3670"}) == []
    ov.original_date = "2026-11-13"
    ev = find_candidates(ov, evs, TZ, {"COMP3670"})[0]
    assert apply(ov, ev, TZ).cancelled


def test_name_similarity():
    assert name_similarity("Assignment 3", "A3") > 0.9
    assert name_similarity("Assignment 2", "Assignment 3") < 0.5
    assert name_similarity("Mid-semester Test", "Midsem test") > 0.6
    assert norm_name("Ass 2: Neural nets") == "assignment 2 neural nets"


def test_to_utc_default_time():
    assert to_utc("2026-11-12", None, TZ) == datetime(2026, 11, 12, 12, 59)
