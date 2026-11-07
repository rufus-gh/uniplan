"""Spike: Ed Discussion unofficial API. Finds which regional base URL accepts the token."""
import requests

from common import save, secret

token = secret("ed_token")
# Verified 2026-11-05: AU tokens work on https://edstem.org/api (au.edstem.org 302-redirects to the web app).
CANDIDATES = ["https://edstem.org/api", "https://eu.edstem.org/api"]

base = None
for url in CANDIDATES:
    r = requests.get(f"{url}/user", headers={"Authorization": f"Bearer {token}"}, timeout=20, allow_redirects=False)
    print(f"{url}/user -> {r.status_code}")
    if r.ok and "json" in r.headers.get("content-type", ""):
        base, user = url, r.json()
        break
if not base:
    save("ed", {"auth": "failed", "tried": CANDIDATES})
    raise SystemExit("No Ed base URL accepted the token")

s = requests.Session()
s.headers["Authorization"] = f"Bearer {token}"
courses = [c["course"] for c in user.get("courses", []) if c["course"].get("status") == "active"]
report = {"auth": "ok", "base_url": base, "courses": []}
for c in courses:
    r = s.get(f"{base}/courses/{c['id']}/threads", params={"limit": 30, "sort": "new"}, timeout=20)
    r.raise_for_status()
    threads = r.json().get("threads", [])
    sample_keys = sorted(threads[0].keys()) if threads else []
    detail_ok = None
    if threads:
        d = s.get(f"{base}/threads/{threads[0]['id']}", timeout=20)
        detail_ok = d.ok and "thread" in d.json()
    report["courses"].append({
        "code": c.get("code"), "n_recent_threads": len(threads),
        "n_pinned": sum(1 for t in threads if t.get("is_pinned")),
        "n_announcements": sum(1 for t in threads if t.get("type") == "announcement"),
        "n_staff_answered": sum(1 for t in threads if t.get("is_staff_answered")),
        "thread_detail_ok": detail_ok, "thread_fields": sample_keys,
    })
    print(f"  {c.get('code')}: {len(threads)} recent threads, detail fetch ok={detail_ok}")

save("ed", report)
