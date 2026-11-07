"""Spike: Gradescope via a saved ANU SSO session (ANU blocks password-only access to course pages).

1) One-time login (you do this yourself, in a real Chrome window):
       uv run spike_gradescope_sso.py --login
   Click "School Credentials" -> Australian National University, finish SSO/MFA, then come back
   to the terminal and press Enter. The session is saved to ../.data/gradescope_state.json (chmod 600).

2) Headless reuse (what the nightly job will do):
       uv run spike_gradescope_sso.py
   Reports how many assignments/grades are visible, or tells you the session expired.
"""
import os
import sys
import time
from pathlib import Path

import requests
from gradescopeapi.classes.account import Account
from playwright.sync_api import sync_playwright

from common import save

BASE = "https://www.gradescope.com"
STATE = Path(__file__).parent.parent / ".data" / "gradescope_state.json"
STATE.parent.mkdir(exist_ok=True)

if "--login" in sys.argv:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=False)  # your installed Chrome, no download
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(f"{BASE}/login")
        input("Log in via School Credentials -> ANU in the Chrome window, then press Enter here... ")
        ctx.storage_state(path=str(STATE))
        os.chmod(STATE, 0o600)
        browser.close()
    print(f"Saved session to {STATE}")

if not STATE.exists():
    raise SystemExit("No saved session. Run with --login first.")

# Reuse the saved cookies in a plain requests session (no browser needed for the nightly fetch).
import json  # noqa: E402

s = requests.Session()
for c in json.loads(STATE.read_text())["cookies"]:
    if "gradescope.com" in c["domain"]:
        s.cookies.set(c["name"], c["value"], domain=c["domain"], path=c["path"])

acct = Account(s)
courses = acct.get_courses().get("student", {})
if not courses:
    save("gradescope_sso", {"result": "session_expired_or_no_courses"})
    raise SystemExit("Session expired (or no courses). Re-run with --login.")

report = {"result": "ok", "courses": []}
for cid, c in courses.items():
    time.sleep(2)  # be polite
    r = s.get(f"{BASE}/courses/{cid}", allow_redirects=False)
    if r.status_code != 200:
        report["courses"].append({"name": c.name, "term": f"{c.semester} {c.year}", "http": r.status_code})
        print(f"  {c.name}: HTTP {r.status_code} {r.text[:120]}")
        continue
    a = acct.get_assignments(cid)
    report["courses"].append({"name": c.name, "term": f"{c.semester} {c.year}", "n_assignments": len(a),
                              "n_with_due": sum(1 for x in a if x.due_date),
                              "n_graded": sum(1 for x in a if x.grade is not None)})
    print(f"  {c.name} ({c.semester} {c.year}): {len(a)} assignments, {report['courses'][-1]['n_graded']} graded")

# Record cookie expiry so Phase 1 knows how often you'll be asked to re-login.
exp = [c.get("expires", -1) for c in json.loads(STATE.read_text())["cookies"] if "gradescope.com" in c["domain"]]
report["session_cookie_expiries_days"] = sorted({round((e - time.time()) / 86400, 1) for e in exp if e and e > 0})
save("gradescope_sso", report)
