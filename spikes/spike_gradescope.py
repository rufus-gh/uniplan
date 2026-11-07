"""Spike: Gradescope via direct email/password using the open-source gradescopeapi package."""
import time

from gradescopeapi.classes.connection import GSConnection

from common import save, secret

conn = GSConnection()
conn.login(secret("gradescope_email"), secret("gradescope_password"))
print("Login OK")

courses = conn.account.get_courses()
student = courses.get("student", {})
print(f"{len(student)} student courses (instructor: {len(courses.get('instructor', {}))})")

report = {"auth": "ok", "courses": []}
for cid, c in student.items():
    time.sleep(2)  # be polite
    assignments = conn.account.get_assignments(cid)
    report["courses"].append({
        "name": c.name, "semester": f"{c.semester} {c.year}",
        "n_assignments": len(assignments),
        "n_with_due": sum(1 for a in assignments if a.due_date),
        "n_graded": sum(1 for a in assignments if a.grade is not None),
        "statuses": sorted({str(a.submissions_status) for a in assignments}),
    })
    print(f"  {c.name} ({c.semester} {c.year}): {len(assignments)} assignments, "
          f"{report['courses'][-1]['n_graded']} graded")

save("gradescope", report)
