"""Canvas LMS via the official REST API and a personal access token."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import requests
from dateutil.parser import isoparse

from ..config import Settings
from ..db import to_utc_naive
from . import anu_courses
from .base import FAssessment, FCourse, FetchResult, FGroup, FItem, SourceUnavailable, course_codes, html_to_text


PAGE_HINT = re.compile(r"assess|outline|overview|syllabus|course info|class summary|grad(e|ing)|marks|weight|"
                       r"exam|welcome|about", re.I)
MODULE_HINT = re.compile(r"course info|assess|overview|about|getting started", re.I)
PAGE_SKIP = re.compile(r"\bweek\s*\d|lecture|tutorial|workshop|solution|past exam|slides|formula", re.I)


def _dt(v):
    return to_utc_naive(isoparse(v)) if v else None


class Canvas:
    def __init__(self, cfg: Settings):
        if not cfg.canvas_token:
            raise SourceUnavailable("CANVAS_TOKEN not set")
        self.base = cfg.canvas_base.rstrip("/") + "/api/v1"
        self.web = cfg.canvas_base.rstrip("/")
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {cfg.canvas_token}"
        self._pc_links: list[str] = []

    def get_all(self, path: str, params: dict | None = None) -> list:
        url, params, out = f"{self.base}{path}", {"per_page": 100, **(params or {})}, []
        while url:
            r = self.s.get(url, params=params, timeout=40)
            if r.status_code == 401:
                raise SourceUnavailable("Canvas token rejected (401) - generate a new one")
            r.raise_for_status()
            data = r.json()
            out.extend(data if isinstance(data, list) else [data])
            url, params = r.links.get("next", {}).get("url"), None
        return out

    def get_one(self, path: str):
        r = self.s.get(f"{self.base}{path}", timeout=40)
        return r.json() if r.ok else None

    def _assessment_pages(self, cid: int, code: str, skip: str | None, limit: int = 8) -> list[FItem]:
        """Course pages likely to describe the assessment scheme (used by the LLM weightings finder and Ask).

        ANU disables the Pages list, so pages are found through Modules (e.g. 'Class summary',
        'Course assessment information'), falling back to the Pages list where it is enabled."""
        cands: list[tuple[str, str]] = []  # (page_url, title)
        r = self.s.get(f"{self.base}/courses/{cid}/modules", params={"per_page": 100, "include[]": "items"}, timeout=40)
        if r.ok:
            for m in r.json():
                info_module = bool(MODULE_HINT.search(m.get("name") or ""))
                for it in m.get("items", []):
                    title = it.get("title") or ""
                    if it.get("type") != "Page" or not it.get("page_url") or PAGE_SKIP.search(title):
                        continue
                    if PAGE_HINT.search(title) or (info_module and not re.search(r"contact", title, re.I)):
                        cands.append((it["page_url"], title))
        if not cands:
            r = self.s.get(f"{self.base}/courses/{cid}/pages", params={"per_page": 100}, timeout=40)
            if r.ok:
                cands = [(p["url"], p.get("title") or "") for p in r.json() if PAGE_HINT.search(p.get("title") or "")]
        out, seen = [], {skip}
        for url, title in cands:
            if url in seen or len(out) >= limit:
                continue
            seen.add(url)
            page = self.get_one(f"/courses/{cid}/pages/{url}")
            self._pc_links += anu_courses.find_links((page or {}).get("body"))
            body = html_to_text((page or {}).get("body"))
            if body:
                out.append(FItem(f"canvas:page:{cid}:{url}", "canvas", "page", code, page.get("title") or title, body,
                                 page.get("html_url", ""), _dt(page.get("updated_at")), needs_llm=False))
        return out

    def fetch(self) -> FetchResult:
        res = FetchResult()
        courses = self.get_all("/courses", {"enrollment_state": "active", "include[]": ["syllabus_body"]})
        since = (datetime.now(UTC) - timedelta(days=120)).strftime("%Y-%m-%d")
        for c in courses:
            if "name" not in c or c.get("access_restricted_by_date"):
                continue
            codes = course_codes(c.get("course_code")) or course_codes(c.get("name"))
            code = codes[0] if codes else (c.get("course_code") or str(c["id"])).replace(" ", "")
            cid = c["id"]
            res.courses.append(FCourse(code=code, name=c.get("name", ""), all_codes="/".join(codes) or code, canvas_id=cid))
            weighted = bool(c.get("apply_assignment_group_weights"))
            groups = self.get_all(f"/courses/{cid}/assignment_groups", {"include[]": ["assignments", "submission"]})
            for i, g in enumerate(groups):
                res.groups.append(FGroup(code, g["id"], g["name"], float(g.get("group_weight") or 0) if weighted else 0.0, i))
                for a in g.get("assignments", []):
                    sub = a.get("submission") or {}
                    score = sub.get("score")
                    state = sub.get("workflow_state")
                    res.assessments.append(FAssessment(
                        id=f"canvas:{a['id']}", course_code=code, source="canvas", name=a["name"],
                        url=a.get("html_url", ""), due_at=_dt(a.get("due_at")),
                        points_possible=a.get("points_possible"), score=score,
                        submitted=bool(sub.get("submitted_at")) or state in ("submitted", "graded", "pending_review"),
                        graded=score is not None and state == "graded",
                        canvas_group_id=g["id"], excluded=bool(a.get("omit_from_final_grade")),
                    ))
                    desc = html_to_text(a.get("description"))
                    if desc:
                        res.items.append(FItem(f"canvas:assignment:{a['id']}", "canvas", "assignment_desc", code,
                                               a["name"], desc, a.get("html_url", ""), _dt(a.get("created_at")),
                                               needs_llm=False))
            for an in self.get_all("/announcements", {"context_codes[]": f"course_{cid}", "start_date": since}):
                res.items.append(FItem(
                    id=f"canvas:announcement:{an['id']}", source="canvas", kind="announcement", course_code=code,
                    title=an.get("title", ""), body=html_to_text(an.get("message")), url=an.get("html_url", ""),
                    posted_at=_dt(an.get("posted_at") or an.get("created_at")),
                    author=(an.get("author") or {}).get("display_name", ""),
                ))
            syl = html_to_text(c.get("syllabus_body"))
            if len(syl) > 200:
                res.items.append(FItem(f"canvas:syllabus:{cid}", "canvas", "syllabus", code, f"{code} syllabus", syl,
                                       f"{self.web}/courses/{cid}/assignments/syllabus", needs_llm=False))
            front = self.get_one(f"/courses/{cid}/front_page")
            if front and front.get("body"):
                res.items.append(FItem(f"canvas:front:{cid}", "canvas", "page", code, front.get("title") or f"{code} home",
                                       html_to_text(front["body"]), front.get("html_url", ""), needs_llm=False))
            self._pc_links = anu_courses.find_links((front or {}).get("body")) + anu_courses.find_links(c.get("syllabus_body"))
            res.items.extend(self._assessment_pages(cid, code, skip=(front or {}).get("url")))
            link = anu_courses.pick_link(self._pc_links, codes or [code])
            summary = anu_courses.fetch_summary(link) if link else None
            if summary:
                res.items.append(FItem(f"anu:classsummary:{code}", "anu", "class_summary", code,
                                       f"{code} class summary (Programs & Courses)", summary,
                                       anu_courses.normalise(link), needs_llm=False))
        res.meta = {"courses": len(res.courses), "assessments": len(res.assessments), "items": len(res.items)}
        return res
