"""Ed Discussion via its (unofficial) JSON API and a personal API token."""
from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import requests
from dateutil.parser import isoparse

from ..config import Settings
from ..db import to_utc_naive
from .base import FCourse, FetchResult, FItem, SourceUnavailable, course_codes


class Ed:
    def __init__(self, cfg: Settings):
        if not cfg.ed_token:
            raise SourceUnavailable("ED_TOKEN not set")
        self.base, self.web = cfg.ed_base.rstrip("/"), cfg.ed_web.rstrip("/")
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {cfg.ed_token}"

    def get(self, path: str, **params):
        r = self.s.get(f"{self.base}{path}", params=params, timeout=30, allow_redirects=False)
        if r.status_code in (401, 403):
            raise SourceUnavailable(f"Ed token rejected ({r.status_code}) - create a new one")
        r.raise_for_status()
        if "json" not in r.headers.get("content-type", ""):
            raise RuntimeError(f"Ed returned non-JSON from {path} - API URL may have changed")
        return r.json()

    def fetch(self, lookback_days: int = 60) -> FetchResult:
        res = FetchResult()
        user = self.get("/user")
        cutoff = datetime.now(UTC) - timedelta(days=lookback_days)
        for entry in user.get("courses", []):
            c = entry.get("course", {})
            if c.get("status") != "active":
                continue
            codes = course_codes(c.get("code")) or course_codes(c.get("name"))
            code = codes[0] if codes else (c.get("code") or str(c["id"]))
            res.courses.append(FCourse(code=code, name=c.get("name", ""), all_codes="/".join(codes), ed_id=c["id"]))
            threads = self.get(f"/courses/{c['id']}/threads", limit=100, sort="new").get("threads", [])
            for t in threads:
                updated = isoparse(t.get("updated_at") or t["created_at"])
                if updated < cutoff and not t.get("is_pinned"):
                    continue
                body = t.get("document") or ""
                flags = [f for f in ("is_pinned", "is_staff_answered", "is_endorsed", "is_megathread") if t.get(f)]
                if t.get("type") == "announcement":
                    flags.append("announcement")
                answers = ""
                if t.get("is_staff_answered") or t.get("type") == "announcement" or t.get("is_pinned"):
                    answers = self._staff_replies(t["id"])
                    time.sleep(0.5)
                res.items.append(FItem(
                    id=f"ed:thread:{t['id']}", source="ed", kind="thread", course_code=code,
                    title=t.get("title", ""), body=(body + ("\n\n--- Staff replies ---\n" + answers if answers else ""))[:12000],
                    url=f"{self.web}/courses/{c['id']}/discussion/{t['id']}",
                    posted_at=to_utc_naive(isoparse(t["created_at"])), flags=",".join(flags),
                ))
        res.meta = {"courses": len(res.courses), "threads": len(res.items)}
        return res

    def _staff_replies(self, thread_id: int) -> str:
        try:
            d = self.get(f"/threads/{thread_id}")
        except Exception:  # noqa: BLE001
            return ""
        staff = {u["id"] for u in d.get("users", []) if u.get("course_role") in ("staff", "admin", "mentor", "tutor")}
        out: list[str] = []

        def walk(nodes):
            for n in nodes or []:
                if n.get("user_id") in staff or n.get("is_endorsed"):
                    out.append((n.get("document") or "").strip())
                walk(n.get("comments"))

        th = d.get("thread", {})
        walk(th.get("answers"))
        walk(th.get("comments"))
        return "\n---\n".join(x for x in out if x)[:6000]
