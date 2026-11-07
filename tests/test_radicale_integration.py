"""End-to-end against a real Radicale server: create calendars, write, detect a 'phone' edit, keep it."""
import socket
import time
from dataclasses import replace
from datetime import datetime, timedelta

import caldav
import pytest

from uniplan.calendar_sync import CalDAVStore, DesiredEvent, start_radicale, sync_calendars
from uniplan.config import settings


@pytest.fixture()
def radicale():
    cfg = replace(settings(), caldav_port=5299)
    proc = start_radicale(cfg)
    for _ in range(40):
        with socket.socket() as sk:
            if sk.connect_ex(("127.0.0.1", 5299)) == 0:
                break
        time.sleep(0.25)
    yield cfg
    proc.terminate()
    proc.wait()


def test_roundtrip_with_phone_edit(s, radicale):
    cfg = radicale
    t0 = datetime(2026, 11, 20, 2, 0)
    d = DesiredEvent(uid="asm-x@uniplan", calendar="due", summary="COMP3670: A3 due", start=t0, end=t0 + timedelta(minutes=30),
                     alarms=[60])
    st = sync_calendars(s, CalDAVStore(cfg), [d])
    assert st.created == 1

    phone = caldav.DAVClient(cfg.caldav_url, username=cfg.caldav_user, password=cfg.caldav_password)
    cals = {c.name: c for c in phone.principal().calendars()}
    assert {"Classes", "Due Dates", "Exams", "Study Blocks", "Personal"} <= set(cals)
    e = cals["Due Dates"].event_by_uid("asm-x@uniplan")
    e.icalendar_component["summary"] = "A3 – do Q1 first"
    e.save()

    st = sync_calendars(s, CalDAVStore(cfg), [d])
    assert st.kept_user_edits == 1 and st.updated == 0
    st = sync_calendars(s, CalDAVStore(cfg), [replace(d, start=t0 + timedelta(days=1), end=t0 + timedelta(days=1, minutes=30))])
    assert st.conflicts == 1
