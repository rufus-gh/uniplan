"""Spike: ANU timetable iCal feed. Parses it and checks whether event UIDs are stable between fetches.

Run it twice (ideally a day apart): the second run compares UIDs against the saved snapshot.
"""
import collections
import hashlib
import json

import requests
from icalendar import Calendar

from common import RESULTS, save, secret

url = secret("timetable_url").replace("webcal://", "https://")
r = requests.get(url, timeout=30)
r.raise_for_status()
cal = Calendar.from_ical(r.content)
events = list(cal.walk("VEVENT"))
print(f"Fetched {len(events)} events, content-type={r.headers.get('content-type')}")

uids = {str(e.get("UID")): f"{e.get('SUMMARY')}|{e.decoded('DTSTART')}" for e in events}
snap = RESULTS / "timetable_uids_snapshot.json"
stability = None
if snap.exists():
    prev = json.loads(snap.read_text())
    same = set(prev) & set(uids)
    stability = {"previous": len(prev), "now": len(uids), "uids_in_both": len(same),
                 "same_uid_same_event": sum(1 for u in same if prev[u] == uids[u])}
    print("UID stability vs previous run:", stability)
snap.write_text(json.dumps(uids))

props = collections.Counter(k for e in events for k in e.keys())
sample = events[0] if events else None
save("timetable", {
    "n_events": len(events),
    "has_rrule": any("RRULE" in e for e in events),
    "property_counts": dict(props),
    "x_wr_calname": str(cal.get("X-WR-CALNAME")),
    "sample_summary_shape": str(sample.get("SUMMARY")) if sample else None,
    "sample_location_shape": str(sample.get("LOCATION")) if sample else None,
    "feed_hash": hashlib.sha256(r.content).hexdigest()[:12],
    "uid_stability": stability,
})
