"""Spike: Canvas REST API with personal token. Proves auth + every endpoint UniPlan needs."""
import requests

from common import save, secret

BASE = "https://canvas.anu.edu.au/api/v1"
s = requests.Session()
s.headers["Authorization"] = f"Bearer {secret('canvas_token')}"


def get(path, **params):
    r = s.get(f"{BASE}{path}", params={"per_page": 100, **params}, timeout=30)
    r.raise_for_status()
    return r, r.json()


r, me = get("/users/self")
print("Auth OK as user id", me["id"], "| rate-limit remaining:", r.headers.get("X-Rate-Limit-Remaining"))

_, courses = get("/courses", enrollment_state="active", **{"include[]": ["syllabus_body", "total_scores"]})
report = {"auth": "ok", "pagination_link_header": "Link" in r.headers, "courses": []}
for c in courses:
    if "name" not in c:
        continue
    cid = c["id"]
    _, groups = get(f"/courses/{cid}/assignment_groups", **{"include[]": ["assignments", "submission"]})
    _, ann = get("/announcements", **{"context_codes[]": f"course_{cid}"})
    _, front = get(f"/courses/{cid}/front_page") if c.get("default_view") == "wiki" else (None, None)
    assignments = [a for g in groups for a in g.get("assignments", [])]
    graded = [a for a in assignments if (a.get("submission") or {}).get("score") is not None]
    submitted = [a for a in assignments if (a.get("submission") or {}).get("workflow_state") in ("submitted", "graded")]
    report["courses"].append({
        "code": c.get("course_code"),
        "apply_assignment_group_weights": c.get("apply_assignment_group_weights"),
        "group_weights": {g["name"]: g.get("group_weight") for g in groups},
        "n_assignments": len(assignments),
        "n_with_due_at": sum(1 for a in assignments if a.get("due_at")),
        "n_submitted": len(submitted),
        "n_graded": len(graded),
        "n_announcements": len(ann),
        "has_syllabus_body": bool(c.get("syllabus_body")),
        "syllabus_chars": len(c.get("syllabus_body") or ""),
        "has_front_page": bool(front),
        "total_scores_visible": "enrollments" in c and any("computed_current_score" in e for e in c["enrollments"]),
    })
    print(f"  {c.get('course_code')}: {len(assignments)} assignments, {len(graded)} graded, "
          f"{len(ann)} announcements, syllabus={'yes' if c.get('syllabus_body') else 'no'}, "
          f"weights={'on' if c.get('apply_assignment_group_weights') else 'off'}")

save("canvas", report)
