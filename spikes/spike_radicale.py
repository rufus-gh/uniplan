"""Spike: local Radicale CalDAV server + the two-way sync primitive UniPlan depends on.

Starts Radicale on 127.0.0.1:5232 with a throwaway test user, creates the 'Due Dates' calendar,
writes an event, simulates a phone edit, and checks we can detect it via ETag + content hash.
Use --serve to keep the server running so you can subscribe from iPhone/Mac over Tailscale.
"""
import hashlib
import subprocess
import sys
import time
from pathlib import Path

import bcrypt
import caldav

from common import secret

ROOT = Path(__file__).parent / "radicale_data"
ROOT.mkdir(exist_ok=True)
user = "uniplan"
pw = secret("caldav_password")
(ROOT / "users").write_text(f"{user}:{bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()}\n")
(ROOT / "config").write_text(f"""[server]
hosts = 127.0.0.1:5232
[auth]
type = htpasswd
htpasswd_filename = {ROOT / 'users'}
htpasswd_encryption = bcrypt
[storage]
filesystem_folder = {ROOT / 'collections'}
[rights]
type = owner_only
""")

proc = subprocess.Popen([sys.executable, "-m", "radicale", "--config", str(ROOT / "config")])
time.sleep(2)
try:
    client = caldav.DAVClient("http://127.0.0.1:5232/", username=user, password=pw)
    principal = client.principal()
    names = {c.name: c for c in principal.calendars()}
    cal = names.get("Due Dates") or principal.make_calendar(name="Due Dates")

    def h(s: str) -> str:
        return hashlib.sha256(s.encode()).hexdigest()[:16]

    ics = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//UniPlan//spike//EN
BEGIN:VEVENT
UID:uniplan-spike-1@uniplan
DTSTAMP:20261105T000000Z
DTSTART;TZID=Australia/Sydney:20261112T235900
DURATION:PT0M
SUMMARY:MATH1014 Assignment 4 due
END:VEVENT
END:VCALENDAR
"""
    ev = cal.save_event(ics)
    ev.load()
    written_hash, written_etag = h(ev.data), ev.props.get("{DAV:}getetag") or client.request(str(ev.url), "HEAD").headers.get("etag")
    print("Wrote event. etag:", written_etag)

    # Simulate the iPhone editing the event title
    other = caldav.DAVClient("http://127.0.0.1:5232/", username=user, password=pw)
    e2 = other.principal().calendar(name="Due Dates").event_by_uid("uniplan-spike-1@uniplan")
    e2.icalendar_component["summary"] = "MATH1014 A4 due (start Mon!)"
    e2.save()

    cur = cal.event_by_uid("uniplan-spike-1@uniplan")
    cur_etag = client.request(str(cur.url), "HEAD").headers.get("etag")
    user_edited = h(cur.data) != written_hash
    print("Phone edit detected via hash:", user_edited, "| etag changed:", cur_etag != written_etag)
    print("PASS" if user_edited else "FAIL")
    if "--serve" in sys.argv:
        print(f"\nServing at http://127.0.0.1:5232  user={user}  password = CALDAV_PASSWORD in .env. Ctrl-C to stop.")
        proc.wait()
finally:
    proc.terminate()
