"""Gradescope via a saved ANU SSO session.

ANU forces SSO for course pages, so password login is useless. You log in once yourself in a real
Chrome window (`uniplan gradescope-login`); the nightly sync reuses those cookies with plain requests.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime

import requests

from ..config import Settings
from ..db import to_utc_naive
from .base import FAssessment, FCourse, FetchResult, SourceUnavailable, course_codes


def login_interactive(cfg: Settings, timeout_s: int = 600) -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=False)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(f"{cfg.gradescope_base}/login")
        print("A Chrome window opened. Click 'School Credentials' -> Australian National University and log in.")
        print("This window closes by itself once you reach your Gradescope dashboard.")
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            url = page.url
            if "gradescope.com" in url and "/login" not in url and "saml" not in url and "/auth" not in url:
                if any(c["name"].startswith("signed_token") or c["name"] == "_gradescope_session"
                       for c in ctx.cookies()) and ("/account" in url or "/courses" in url or url.rstrip("/").endswith("gradescope.com")):
                    break
            time.sleep(1)
        else:
            browser.close()
            raise SystemExit("Timed out waiting for Gradescope login.")
        time.sleep(2)
        ctx.storage_state(path=str(cfg.gradescope_state))
        os.chmod(cfg.gradescope_state, 0o600)
        browser.close()
    print(f"Saved Gradescope session to {cfg.gradescope_state}")


def _session(cfg: Settings) -> requests.Session:
    if not cfg.gradescope_state.exists():
        raise SourceUnavailable("Not logged in - run: uv run uniplan gradescope-login")
    s = requests.Session()
    for c in json.loads(cfg.gradescope_state.read_text()).get("cookies", []):
        if "gradescope.com" in c.get("domain", ""):
            s.cookies.set(c["name"], c["value"], domain=c["domain"], path=c.get("path", "/"))
    return s


def session_expiry(cfg: Settings) -> datetime | None:
    if not cfg.gradescope_state.exists():
        return None
    exps = [c["expires"] for c in json.loads(cfg.gradescope_state.read_text()).get("cookies", [])
            if "gradescope.com" in c.get("domain", "") and c.get("expires", -1) > 0]
    return datetime.fromtimestamp(min(exps)) if exps else None


def _dt(v):
    if v is None:
        return None
    if isinstance(v, str):
        from dateutil.parser import parse
        v = parse(v)
    return to_utc_naive(v)


def fetch(cfg: Settings) -> FetchResult:
    from gradescopeapi.classes.account import Account

    s = _session(cfg)
    r = s.get(f"{cfg.gradescope_base}/account", allow_redirects=False, timeout=30)
    if r.status_code != 200:
        raise SourceUnavailable("Gradescope session expired - run: uv run uniplan gradescope-login")
    acct = Account(s, cfg.gradescope_base)
    res = FetchResult()
    blocked = 0
    for cid, c in acct.get_courses().get("student", {}).items():
        codes = course_codes(c.name) or course_codes(c.full_name)
        if not codes:
            continue
        time.sleep(1.5)
        page = s.get(f"{cfg.gradescope_base}/courses/{cid}", allow_redirects=False, timeout=30)
        if page.status_code != 200:
            blocked += 1
            continue
        res.courses.append(FCourse(code=codes[0], name=c.full_name or c.name, all_codes="/".join(codes), gradescope_id=str(cid)))
        for a in acct.get_assignments(cid):
            status = (a.submissions_status or "").lower()
            grade = float(a.grade) if a.grade not in (None, "") else None
            maxg = float(a.max_grade) if a.max_grade not in (None, "") else None
            res.assessments.append(FAssessment(
                id=f"gradescope:{a.assignment_id}", course_code=codes[0], source="gradescope", name=a.name,
                url=f"{cfg.gradescope_base}/courses/{cid}/assignments/{a.assignment_id}",
                due_at=_dt(a.due_date), points_possible=maxg, score=grade,
                submitted=grade is not None or (bool(status) and "no submission" not in status and "missing" not in status),
                graded=grade is not None,
            ))
    if blocked and not res.courses:
        raise SourceUnavailable("Gradescope session no longer accepted by course pages - run: uv run uniplan gradescope-login")
    res.meta = {"courses": len(res.courses), "assessments": len(res.assessments), "blocked_courses": blocked}
    return res
