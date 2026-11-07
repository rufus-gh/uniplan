from datetime import datetime, timedelta

from sqlmodel import select

from uniplan.calendar_sync import (DesiredEvent, MemoryStore, first_event, resolve_conflict, semantic_hash,
                                   sync_calendars, to_ics)
from uniplan.db import CalEvent, Review

T0 = datetime(2026, 11, 20, 2, 0)


def ev(summary="COMP3670 A3 due", start=T0, uid="asm-1@uniplan", cal="due", alarms=(60,)):
    return DesiredEvent(uid=uid, calendar=cal, summary=summary, start=start, end=start + timedelta(minutes=30), alarms=list(alarms))


def phone_edit(store, cal, uid, **changes):
    comp_cal = __import__("icalendar").Calendar.from_ical(store.cals[cal][uid])
    for comp in comp_cal.walk("VEVENT"):
        for k, v in changes.items():
            comp[k] = v
        comp["X-APPLE-TRAVEL"] = "noise"  # devices add props; must not count as an edit
    store.cals[cal][uid] = comp_cal.to_ical().decode()


def test_create_then_idempotent(s):
    store = MemoryStore()
    st = sync_calendars(s, store, [ev()])
    assert st.created == 1 and "asm-1@uniplan" in store.cals["due"]
    st = sync_calendars(s, store, [ev()])
    assert (st.created, st.updated, st.conflicts) == (0, 0, 0)


def test_device_noise_is_not_an_edit(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    phone_edit(store, "due", "asm-1@uniplan")
    st = sync_calendars(s, store, [ev()])
    assert st.kept_user_edits == 0


def test_source_change_updates(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    st = sync_calendars(s, store, [ev(start=T0 + timedelta(days=1))])
    assert st.updated == 1
    assert "20261121" in store.cals["due"]["asm-1@uniplan"]


def test_user_edit_is_kept(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    phone_edit(store, "due", "asm-1@uniplan", SUMMARY="A3 - start early!")
    st = sync_calendars(s, store, [ev()])
    assert st.kept_user_edits == 1
    assert "start early" in store.cals["due"]["asm-1@uniplan"]
    assert s.get(CalEvent, "asm-1@uniplan").user_modified


def test_conflict_and_resolution(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    phone_edit(store, "due", "asm-1@uniplan", SUMMARY="mine")
    st = sync_calendars(s, store, [ev(start=T0 + timedelta(days=2))])
    assert st.conflicts == 1
    assert "mine" in store.cals["due"]["asm-1@uniplan"]  # untouched until you decide
    r = s.exec(select(Review).where(Review.kind == "conflict")).one()
    # a second sync must not duplicate the review
    sync_calendars(s, store, [ev(start=T0 + timedelta(days=2))])
    assert len(s.exec(select(Review).where(Review.kind == "conflict")).all()) == 1
    resolve_conflict(s, store, r, "source")
    assert "20261122" in store.cals["due"]["asm-1@uniplan"]
    st = sync_calendars(s, store, [ev(start=T0 + timedelta(days=2))])
    assert (st.updated, st.conflicts, st.kept_user_edits) == (0, 0, 0)


def test_keep_mine_resolution(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    phone_edit(store, "due", "asm-1@uniplan", SUMMARY="mine")
    sync_calendars(s, store, [ev(start=T0 + timedelta(days=2))])
    r = s.exec(select(Review).where(Review.kind == "conflict")).one()
    resolve_conflict(s, store, r, "mine")
    st = sync_calendars(s, store, [ev(start=T0 + timedelta(days=2))])
    assert st.conflicts == 0 and "mine" in store.cals["due"]["asm-1@uniplan"]


def test_user_delete_respected(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    del store.cals["due"]["asm-1@uniplan"]
    st = sync_calendars(s, store, [ev()])
    assert st.user_deleted == 1 and "asm-1@uniplan" not in store.cals["due"]
    st = sync_calendars(s, store, [ev()])
    assert st.created == 0 and "asm-1@uniplan" not in store.cals["due"]


def test_removed_from_source_deleted_unless_edited(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev(), ev(uid="asm-2@uniplan", summary="other")])
    phone_edit(store, "due", "asm-2@uniplan", LOCATION="my notes")
    st = sync_calendars(s, store, [])
    assert st.deleted == 1
    assert "asm-1@uniplan" not in store.cals["due"] and "asm-2@uniplan" in store.cals["due"]


def test_calendar_move(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev()])
    sync_calendars(s, store, [ev(cal="exams")])
    assert "asm-1@uniplan" in store.cals["exams"] and "asm-1@uniplan" not in store.cals["due"]


def test_alarm_change_rewrites(s):
    store = MemoryStore()
    sync_calendars(s, store, [ev(alarms=(60,))])
    st = sync_calendars(s, store, [ev(alarms=(60, 1440))])
    assert st.updated == 1 and store.cals["due"]["asm-1@uniplan"].count("BEGIN:VALARM") == 2


def test_semantic_hash_stable_across_roundtrip():
    ics = to_ics(ev())
    assert semantic_hash(first_event(ics)) == semantic_hash(first_event(first_event(ics).to_ical().decode().join(
        ["BEGIN:VCALENDAR\nVERSION:2.0\n", "END:VCALENDAR\n"])))
