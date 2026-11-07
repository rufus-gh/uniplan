"""UniPlan web UI (server-rendered Jinja2 + HTMX). Protected by HTTP Basic auth (user 'uniplan', WEB_PASSWORD)."""
from __future__ import annotations

import json
import logging
import secrets
import shutil
import threading
from collections import defaultdict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlmodel import select

from .. import notify, webpush
from ..calendar_sync import CALENDARS, CalDAVStore, resolve_conflict, sync_calendars
from ..config import settings
from ..db import (Assessment, AssessmentGroup, CalEvent, Course, Item, LLMCall, Override, Pref, Review, StudyBlock,
                  SyncRun, TimetableEvent, init_db, session, utcnow)
from ..marks import BANDS, band, compute
from ..pipeline import is_running, run_sync
from ..planner import class_events, desired_events, hidden_codes, plan_study, visible_assessments, workload
from ..sources import gradescope as gs_source

log = logging.getLogger("uniplan.web")
HERE = Path(__file__).parent
templates = Jinja2Templates(directory=str(HERE / "templates"))
security = HTTPBasic()
scheduler = BackgroundScheduler(timezone=settings().timezone)


def auth(creds: HTTPBasicCredentials = Depends(security)):
    cfg = settings()
    ok = secrets.compare_digest(creds.username.encode(), cfg.web_user.encode()) and \
        secrets.compare_digest(creds.password.encode(), (cfg.web_password or "").encode())
    if not ok:
        raise HTTPException(401, "Unauthorized", headers={"WWW-Authenticate": "Basic"})


def _nightly():
    log.info("nightly sync starting")
    run_sync("nightly")
    _backup_db()


def _backup_db():
    cfg = settings()
    bdir = cfg.data_dir / "backups"
    bdir.mkdir(exist_ok=True)
    shutil.copy2(cfg.db_path, bdir / f"uniplan-{date.today():%Y%m%d}.db")
    for old in sorted(bdir.glob("uniplan-*.db"))[:-14]:
        old.unlink()


@asynccontextmanager
async def lifespan(_app):
    init_db()
    h, m = settings().nightly_sync_time.split(":")
    scheduler.add_job(_nightly, CronTrigger(hour=int(h), minute=int(m)), id="nightly", replace_existing=True,
                      misfire_grace_time=3 * 3600, coalesce=True)
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(lifespan=lifespan, dependencies=[Depends(auth)], docs_url=None, redoc_url=None)
@app.middleware("http")
async def no_stale_pages(request, call_next):
    """Pages are never cached or restored from the back/forward cache, so you always see current data and styles."""
    response = await call_next(request)
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Cache-Control"] = "no-store"
    return response


# compiled Tailwind stylesheet (npm run css). Served without auth: it's only styling.
app.mount("/static", StaticFiles(directory=str(HERE / "static")), name="static")
_css = HERE / "static" / "app.css"
templates.env.globals["css_version"] = int(_css.stat().st_mtime) if _css.exists() else 0


# iOS fetches these without the login, so add_route keeps them outside the app-wide auth. Neither contains personal data.
async def _service_worker(_request):
    return FileResponse(HERE / "static" / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


async def _manifest(_request):
    return JSONResponse({
        "id": "/", "name": "UniPlan", "short_name": "UniPlan", "start_url": "/", "scope": "/", "display": "standalone",
        "background_color": "#05071c", "theme_color": "#05071c",
        "icons": [{"src": f"/static/icon-{n}.png", "sizes": f"{n}x{n}", "type": "image/png"} for n in (192, 512)],
    }, media_type="application/manifest+json")


app.add_route("/sw.js", _service_worker)
app.add_route("/manifest.webmanifest", _manifest)


# ---------------- helpers ----------------

def tz():
    return settings().tz


def loc(dt: datetime | None, fmt: str = "%a %d %b %H:%M") -> str:
    if dt is None:
        return "–"
    return dt.replace(tzinfo=UTC).astimezone(tz()).strftime(fmt)


def rel(dt: datetime | None) -> str:
    if dt is None:
        return ""
    d = dt - utcnow()
    secs = d.total_seconds()
    if secs < 0:
        return "overdue" if secs > -86400 else f"{int(-secs // 86400)}d ago"
    if secs < 3600:
        return f"in {int(secs // 60)}m"
    if secs < 86400:
        return f"in {int(secs // 3600)}h"
    return f"in {int(secs // 86400)}d"


templates.env.filters["loc"] = loc
templates.env.filters["rel"] = rel


def short_title(t: str) -> str:
    for long, short in (("Computer Lab", "Lab"), ("Lecture", "Lec"), ("Tutorial", "Tut"), ("Workshop", "Wkshp"),
                        ("Assessment", "Assess"), (" due", "")):
        t = t.replace(long, short)
    return t


templates.env.filters["short"] = short_title


def answer_html(text: str, n_sources: int = 0) -> str:
    """Tiny, safe markdown for AI answers: escapes everything, then bold, bullet lists and [n] citations."""
    import re
    from markupsafe import Markup, escape

    out, in_list = [], False
    for raw in (text or "").strip().splitlines():
        line = str(escape(raw.strip()))
        line = re.sub(r"\*\*(.+?)\*\*", r'<strong class="text-white font-medium">\1</strong>', line)
        line = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", line)
        line = re.sub(r"\[(\d+)\]", lambda m: (f'<a href="#src-{m.group(1)}" class="align-super text-[10px] text-brand-300 hover:underline">{m.group(1)}</a>'
                                              if 0 < int(m.group(1)) <= n_sources else m.group(0)), line)
        bullet = re.match(r"^(?:[*\-•]|\d+[.)])\s+(.*)", line)
        if bullet:
            if not in_list:
                out.append('<ul class="space-y-1.5 my-2">')
                in_list = True
            out.append(f'<li class="flex gap-2"><span class="mt-2 w-1 h-1 rounded-full bg-zinc-500 shrink-0"></span><span>{bullet.group(1)}</span></li>')
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        out.append(f'<p class="my-2">{line}</p>' if line else "")
    if in_list:
        out.append("</ul>")
    return Markup("".join(out))


templates.env.globals["answer_html"] = answer_html
templates.env.globals["band"] = band
templates.env.globals["timedelta"] = timedelta
templates.env.globals["CALENDARS"] = CALENDARS


def render(request: Request, name: str, **ctx):
    with session() as s:
        ctx.setdefault("open_reviews", len(s.exec(select(Review).where(Review.status == "open")).all()))
        ctx.setdefault("nav_courses", s.exec(select(Course).where(Course.active == True, Course.hidden == False)  # noqa: E712
                                             .order_by(Course.code)).all())
    ctx["syncing"] = is_running()
    ctx["request"] = request
    return templates.TemplateResponse(request, name, ctx)


def refresh_calendar_async():
    def job():
        try:
            with session() as s:
                plan_study(s, tz())
                sync_calendars(s, CalDAVStore(), desired_events(s, tz()))
        except Exception as e:  # noqa: BLE001
            log.warning("calendar refresh failed: %s", e)
    if not is_running():
        threading.Thread(target=job, daemon=True).start()


def course_marks(s, code: str, whatif: dict | None = None):
    groups = s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == code)).all()
    asm = s.exec(select(Assessment).where(Assessment.course_code == code)).all()
    c = s.get(Course, code)
    return compute(groups, asm, whatif, cap=c.cap_weight if c else 0.0)


# ---------------- pages ----------------

@dataclass
class Row:
    """One line in the Today list: a deadline/exam or a class."""
    kind: str  # due | exam | class | study
    title: str
    course: str
    when: datetime  # local
    end: datetime | None = None
    url: str = ""
    location: str = ""
    weight: float = 0.0
    done: bool = False
    note: str = ""  # e.g. 'Cancelled', 'Moved'


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    from ..planner import assessment_weight

    z = tz()
    now_l = datetime.now(z)
    today = now_l.date()
    week_end = today + timedelta(days=6 - today.weekday())
    next_week_end = week_end + timedelta(days=7)
    with session() as s:
        run = s.exec(select(SyncRun).where(SyncRun.status.in_(["ok", "partial", "failed"])).order_by(SyncRun.id.desc())).first()
        digest = json.loads(run.digest) if run else {}
        now = utcnow()
        groups: dict[str, list[Row]] = {"overdue": [], "today": [], "week": [], "next": [], "later": []}
        for a in visible_assessments(s):
            if not a.due_at:
                continue
            due = a.due_at.replace(tzinfo=UTC).astimezone(z)
            d = due.date()
            if a.due_at < now and (a.submitted or a.due_at < now - timedelta(days=7)) and d != today:
                continue
            row = Row("exam" if a.is_exam else "due", a.name, a.course_code, due, url=a.url, location=a.location,
                      weight=assessment_weight(s, a), done=a.submitted)
            if a.due_at < now and not a.submitted and d != today:
                groups["overdue"].append(row)
            elif d == today:
                groups["today"].append(row)
            elif d <= week_end:
                groups["week"].append(row)
            elif d <= next_week_end:
                groups["next"].append(row)
            elif d <= today + timedelta(days=28):
                groups["later"].append(row)
        for _, ev in class_events(s, z):
            if not isinstance(ev.start, datetime):
                continue
            st = ev.start.replace(tzinfo=UTC).astimezone(z)
            if st.date() == today:
                course, title = _split_title(ev.summary)
                note = title.split(":")[0] if ":" in title else ""
                groups["today"].append(Row("class", title.split(": ", 1)[-1], course, st,
                                           ev.end.replace(tzinfo=UTC).astimezone(z), location=ev.location, note=note,
                                           done=ev.end.replace(tzinfo=UTC).astimezone(z) < now_l))
        for g in groups.values():
            g.sort(key=lambda r: r.when)
        unread = s.exec(select(Item).where(Item.importance >= 2, Item.dismissed == False)  # noqa: E712
                        .order_by(Item.posted_at.desc())).all()
        hidden = hidden_codes(s)
        unread = [i for i in unread if (i.posted_at or i.first_seen) >= now - timedelta(days=21) and i.course_code not in hidden][:8]
        courses = s.exec(select(Course).where(Course.active == True, Course.hidden == False).order_by(Course.code)).all()  # noqa: E712
        marks = {c.code: course_marks(s, c.code) for c in courses}
        colours = course_colours(s)
    open_due = [r for k in ("overdue", "today", "week") for r in groups[k] if r.kind != "class" and not r.done]
    return render(request, "dashboard.html", now=now_l, groups=groups, run=run, digest=digest, unread=unread,
                  courses=courses, marks=marks, colours=colours, open_due=open_due,
                  classes_today=[r for r in groups["today"] if r.kind == "class"])


@app.post("/sync")
def sync_now():
    if not is_running():
        threading.Thread(target=run_sync, args=("manual",), daemon=True).start()
    return RedirectResponse("/health?started=1", status_code=303)


@app.post("/items/{item_id:path}/dismiss")
def dismiss(item_id: str):
    with session() as s:
        it = s.get(Item, item_id)
        if it:
            it.dismissed = True
            s.add(it)
            s.commit()
    return HTMLResponse("")


@dataclass
class CalItem:
    uid: str
    calendar: str
    title: str
    course: str
    start: datetime  # local, tz-aware
    end: datetime
    location: str
    description: str
    edited: bool
    lane: int = 0
    lanes: int = 1


def _split_title(summary: str) -> tuple[str, str]:
    """'COMP3670 · Assignment 3 due' -> ('COMP3670', 'Assignment 3 due'); 'Study · COMP3670 X' -> ('COMP3670', 'Study: X')."""
    import re as _re
    m = _re.match(r"^(Cancelled|Moved|Online|Room change|Study) · ([A-Z]{3,5}\d{4}) (.*)$", summary)
    if m:
        return m.group(2), f"{m.group(1)}: {m.group(3)}"
    m = _re.match(r"^([A-Z]{3,5}\d{4})(?: · | )(.*)$", summary)
    if m:
        return m.group(1), m.group(2)
    return "", summary


def _lanes(items: list[CalItem]) -> None:
    """Side-by-side columns for overlapping events within one day (week view)."""
    items.sort(key=lambda i: (i.start, i.end))
    cluster: list[CalItem] = []
    lane_ends: list[datetime] = []
    cluster_end = None

    def close():
        for it in cluster:
            it.lanes = max(1, len(lane_ends))
    for it in items:
        if cluster_end is not None and it.start >= cluster_end:
            close()
            cluster, lane_ends = [], []
        for n, e in enumerate(lane_ends):
            if e <= it.start:
                it.lane, lane_ends[n] = n, it.end
                break
        else:
            it.lane = len(lane_ends)
            lane_ends.append(it.end)
        cluster.append(it)
        cluster_end = max(cluster_end or it.end, it.end)
    close()


@app.get("/calendar", response_class=HTMLResponse)
def calendar_view(request: Request, view: str = "month", d: str = "", week: int | None = None):
    z = tz()
    today = datetime.now(z).date()
    view = "week" if view == "week" else "month"
    try:
        anchor = date.fromisoformat(d) if d else today
    except ValueError:
        anchor = today
    if week is not None:  # old links
        view, anchor = "week", today + timedelta(weeks=week)
    if view == "week":
        first = anchor - timedelta(days=anchor.weekday())
        last = first + timedelta(days=6)
        prev_d, next_d = first - timedelta(days=7), first + timedelta(days=7)
    else:
        month_start = anchor.replace(day=1)
        first = month_start - timedelta(days=month_start.weekday())
        next_month = (month_start + timedelta(days=32)).replace(day=1)
        last_day = next_month - timedelta(days=1)
        last = last_day + timedelta(days=6 - last_day.weekday())
        prev_d, next_d = (month_start - timedelta(days=1)).replace(day=1), next_month
    days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    by_day: dict[date, list[CalItem]] = defaultdict(list)
    with session() as s:
        edited = {r.uid for r in s.exec(select(CalEvent).where((CalEvent.user_modified == True) | (CalEvent.in_conflict == True))).all()}  # noqa: E712
        for ev in desired_events(s, z):
            if not isinstance(ev.start, datetime):
                continue
            st, en = ev.start.replace(tzinfo=UTC).astimezone(z), ev.end.replace(tzinfo=UTC).astimezone(z)
            if first <= st.date() <= last:
                course, title = _split_title(ev.summary)
                by_day[st.date()].append(CalItem(ev.uid, ev.calendar, title, course, st, en, ev.location,
                                                 ev.description, ev.uid in edited))
    rank = {"exams": 0, "due": 1}
    for v in by_day.values():  # month view has limited room: exams and deadlines first
        v.sort(key=lambda i: (rank.get(i.calendar, 2), i.start) if view == "month" else (0, i.start))
    hours = (8, 20)
    if view == "week":
        for v in by_day.values():
            _lanes(v)
        times = [i for v in by_day.values() for i in v]
        if times:
            hours = (min(8, min(i.start.hour for i in times)),
                     max(20, max(i.end.hour + (1 if i.end.minute else 0) for i in times)))
            hours = (max(0, hours[0]), min(24, hours[1]))
        if first <= today <= last:  # always include the current time so the now-line shows
            nh = datetime.now(z).hour
            hours = (min(hours[0], nh), max(hours[1], min(24, nh + 1)))
    title = (f"{first:%-d %b} – {last:%-d %b %Y}" if view == "week" else f"{anchor:%B %Y}")
    return render(request, "calendar.html", view=view, days=days, by_day=by_day, today=today, anchor=anchor,
                  first=first, last=last, prev_d=prev_d, next_d=next_d, hours=hours, cal_title=title,
                  month=anchor.month)


@app.get("/courses", response_class=HTMLResponse)
def courses_page(request: Request):
    with session() as s:
        all_courses = s.exec(select(Course).order_by(Course.active.desc(), Course.code)).all()
        marks = {c.code: course_marks(s, c.code) for c in all_courses}
        colours = course_colours(s)
    shown = [c for c in all_courses if not c.hidden]
    graded = [marks[c.code].current_avg for c in shown if marks[c.code].current_avg is not None]
    return render(request, "courses.html", courses=shown, hidden=[c for c in all_courses if c.hidden], marks=marks,
                  colours=colours, overall=sum(graded) / len(graded) if graded else None)


@app.get("/courses/{code}", response_class=HTMLResponse)
def course_page(request: Request, code: str, tab: str = "overview", all: int = 0):  # noqa: A002
    if tab not in ("overview", "assessments", "weightings", "whatif"):
        tab = "overview"
    with session() as s:
        c = s.get(Course, code)
        if not c:
            raise HTTPException(404)
        groups = s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == code).order_by(AssessmentGroup.sort)).all()
        asm = s.exec(select(Assessment).where(Assessment.course_code == code)).all()
        asm.sort(key=lambda a: (a.duplicate_of is not None, a.hidden, a.due_at or datetime.max))
        m = compute(groups, asm, cap=c.cap_weight)
        items = s.exec(select(Item).where(Item.course_code == code, Item.importance >= 1).order_by(Item.posted_at.desc())).all()[:15]
        proposal = json.loads(c.weights_proposal) if c.weights_proposal else None
        names = {a.id: a.name for a in asm}
        in_use = bool(proposal and proposal.get("found")) and \
            sorted((g.name, round(g.weight, 1), bool(g.capped)) for g in groups if g.weight > 0) == \
            sorted((g["name"], round(g["weight"], 1), bool(g.get("capped"))) for g in proposal["groups"])
        now = utcnow()
        live = [a for a in asm if not a.hidden and a.duplicate_of is None]
        coming = sorted([a for a in live if a.due_at and a.due_at >= now - timedelta(hours=6) and not a.submitted],
                        key=lambda a: a.due_at)[:4]
        shown = asm if all else live
        by_group = [(g, [a for a in shown if a.group_id == g.id]) for g in groups if g.weight > 0]
        ungrouped = [a for a in shown if a.group_id not in {g.id for g in groups if g.weight > 0}]
        return render(request, "course.html", c=c, groups=groups, asm=asm, m=m, items=items, BANDS=BANDS,
                      proposal=proposal, names=names, in_use=in_use, msg=request.query_params.get("msg"),
                      tab=tab, show_all=bool(all), coming=coming, by_group=by_group, ungrouped=ungrouped,
                      n_extra=len(asm) - len(live))


@app.post("/courses/{code}/hide")
def hide_course(code: str, hidden: str = Form("1"), next: str = Form("")):  # noqa: A002
    with session() as s:
        c = s.get(Course, code)
        if not c:
            raise HTTPException(404)
        c.hidden = hidden == "1"
        s.add(c)
        if c.hidden:
            for r in s.exec(select(Review).where(Review.ref == f"weights:{code}", Review.status == "open")).all():
                r.status, r.resolution = "resolved", "course hidden"
                s.add(r)
        s.commit()
    refresh_calendar_async()
    if next.startswith("/") and not next.startswith("//"):
        return RedirectResponse(next, status_code=303)
    return RedirectResponse("/courses" if hidden == "1" else f"/courses/{code}", status_code=303)


@app.post("/courses/{code}/weights/recheck")
def recheck_weights(code: str):
    from ..extract import find_weights
    with session() as s:
        c = s.get(Course, code)
        if not c:
            raise HTTPException(404)
        prop = find_weights(s, c, force=True)
        s.commit()
    msg = "No weightings found in the class summary or Canvas pages." if not prop or not prop.get("found") else "Weightings re-read."
    return RedirectResponse(f"/courses/{code}?tab=weightings&msg={msg}", status_code=303)


@app.post("/courses/{code}/weights/apply")
def apply_weights_route(code: str):
    from ..extract import apply_weights
    with session() as s:
        c = s.get(Course, code)
        if not c or not apply_weights(s, c):
            raise HTTPException(400, "No weightings proposal to apply")
        s.commit()
    refresh_calendar_async()
    return RedirectResponse(f"/courses/{code}?tab=weightings&msg=Applied. Check the groups, then confirm.", status_code=303)


@app.post("/courses/{code}/groups")
async def save_groups(request: Request, code: str):
    form = await request.form()
    with session() as s:
        for g in s.exec(select(AssessmentGroup).where(AssessmentGroup.course_code == code)).all():
            if form.get(f"del_{g.id}"):
                for a in s.exec(select(Assessment).where(Assessment.group_id == g.id)).all():
                    a.group_id, a.group_locked = None, False
                    s.add(a)
                s.delete(g)
                continue
            w = float(form.get(f"w_{g.id}") or 0)
            name = (form.get(f"n_{g.id}") or g.name).strip()
            drop = int(form.get(f"d_{g.id}") or 0)
            hurdle = (form.get(f"h_{g.id}") or "").strip()
            capped = bool(form.get(f"c_{g.id}"))
            if (w, name, drop, hurdle, capped) != (g.weight, g.name, g.drop_lowest, g.hurdle, g.capped):
                g.weight, g.name, g.drop_lowest, g.hurdle, g.capped, g.source = w, name, drop, hurdle, capped, "manual"
                s.add(g)
        c = s.get(Course, code)
        try:
            c.cap_weight = float(form.get("cap_weight") or 0)
        except ValueError:
            pass
        s.add(c)
        if (form.get("new_name") or "").strip():
            s.add(AssessmentGroup(course_code=code, name=form["new_name"].strip(), weight=float(form.get("new_weight") or 0),
                                  source="manual", sort=999))
        if form.get("confirm"):
            c = s.get(Course, code)
            c.weights_confirmed = True
            s.add(c)
            for r in s.exec(select(Review).where(Review.ref == f"weights:{code}", Review.status == "open")).all():
                r.status, r.resolution = "resolved", "confirmed"
                s.add(r)
        s.commit()
    return RedirectResponse(f"/courses/{code}?tab=weightings&msg=Saved.", status_code=303)


@app.post("/assessments/{aid:path}/edit")
async def edit_assessment(request: Request, aid: str):
    form = await request.form()
    with session() as s:
        a = s.get(Assessment, aid)
        if not a:
            raise HTTPException(404)
        if "group_id" in form:
            gid = form.get("group_id")
            a.group_id = int(gid) if gid else None
            a.group_locked = True
        if "effort_hours" in form:
            a.effort_hours = float(form["effort_hours"]) if form["effort_hours"] else None
        for flag in ("hidden", "excluded", "is_exam", "submitted"):
            if f"set_{flag}" in form:
                setattr(a, flag, form.get(flag) == "1")
        if form.get("due_local"):
            a.due_at = datetime.fromisoformat(form["due_local"]).replace(tzinfo=tz()).astimezone(UTC).replace(tzinfo=None)
            a.due_overridden = True
        if "location" in form:
            a.location = form["location"]
        if form.get("unlink"):
            a.duplicate_of = None
            if a.source == "llm":
                a.hidden = False
        s.add(a)
        s.commit()
        code = a.course_code
    refresh_calendar_async()
    return RedirectResponse(request.headers.get("referer") or f"/courses/{code}", status_code=303)


@app.post("/courses/{code}/assessments")
async def add_assessment(code: str, name: str = Form(...), due_local: str = Form(""), is_exam: str = Form(""),
                         points: str = Form(""), score: str = Form("")):
    with session() as s:
        due = datetime.fromisoformat(due_local).replace(tzinfo=tz()).astimezone(UTC).replace(tzinfo=None) if due_local else None
        a = Assessment(id=f"manual:{secrets.token_hex(6)}", course_code=code, source="manual", name=name, due_at=due,
                       is_exam=is_exam == "1", points_possible=float(points) if points else None,
                       score=float(score) if score else None, graded=bool(score), due_overridden=True)
        s.add(a)
        s.commit()
    refresh_calendar_async()
    return RedirectResponse(f"/courses/{code}?tab=assessments", status_code=303)


@app.post("/courses/{code}/whatif", response_class=HTMLResponse)
async def whatif(request: Request, code: str):
    form = await request.form()
    per_item = {k[3:]: float(v) for k, v in form.items() if k.startswith("wi_") and v not in ("", None)}
    uniform = float(form.get("uniform") or 0)
    with session() as s:
        base = course_marks(s, code)
        m = course_marks(s, code, per_item)
        projected = m.projected(uniform)
    return templates.TemplateResponse(request, "_whatif.html", {"m": m, "base": base, "uniform": uniform,
                                                                "projected": projected, "band": band})


@app.get("/review", response_class=HTMLResponse)
def review_page(request: Request):
    with session() as s:
        open_ = s.exec(select(Review).where(Review.status == "open").order_by(Review.created_at.desc())).all()
        done = s.exec(select(Review).where(Review.status == "resolved").order_by(Review.created_at.desc())).all()[:20]
    return render(request, "review.html", items=open_, done=done, json=json)


@app.post("/review/{rid}")
async def review_action(request: Request, rid: int):
    form = await request.form()
    action = form.get("action")
    with session() as s:
        r = s.get(Review, rid)
        if not r:
            raise HTTPException(404)
        data = r.data()
        if r.kind == "conflict":
            resolve_conflict(s, CalDAVStore(), r, "source" if action == "source" else "mine")
        elif r.kind == "class_change":
            ov = s.get(Override, data["override_id"])
            if action == "apply" and ov and form.get("key"):
                ov.status, ov.target_key = "applied", form["key"]
                r.resolution = "applied"
            else:
                if ov:
                    ov.status = "rejected"
                r.resolution = "rejected"
            if ov:
                s.add(ov)
            r.status = "resolved"
        elif r.kind == "deadline_change":
            if action == "accept":
                a = s.get(Assessment, data["assessment_id"])
                if a:
                    a.due_at, a.due_overridden = datetime.fromisoformat(data["new_due"]), True
                    s.add(a)
            r.status, r.resolution = "resolved", action or "dismissed"
        else:
            r.status, r.resolution = "resolved", action or "dismissed"
        s.add(r)
        s.commit()
    refresh_calendar_async()
    return RedirectResponse("/review", status_code=303)


COURSE_COLOURS = ["bg-brand-400", "bg-sky-400", "bg-emerald-400", "bg-rose-400", "bg-teal-300", "bg-orange-400"]


def course_colours(s) -> dict[str, str]:
    codes = [c.code for c in s.exec(select(Course).where(Course.hidden == False).order_by(Course.code)).all()]  # noqa: E712
    return {code: COURSE_COLOURS[i % len(COURSE_COLOURS)] for i, code in enumerate(codes)}


@app.get("/workload", response_class=HTMLResponse)
def workload_page(request: Request, weeks_n: int = 12, d: str = ""):
    try:
        start = date.fromisoformat(d) if d else None
    except ValueError:
        start = None
    with session() as s:
        weeks = workload(s, tz(), weeks=max(4, min(26, weeks_n)), start=start)
        colours = course_colours(s)
    busiest = max(weeks, key=lambda w: (sum(e.weight for e in w.open_entries), len(w.open_entries)))
    soon = [e for w in weeks[:4] for e in w.open_entries]
    scale = max([w.load for w in weeks] + [10])
    active = sorted({e.a.course_code for w in weeks for e in w.entries})
    return render(request, "workload.html", weeks=weeks, colours=colours, busiest=busiest if busiest.open_entries else None,
                  soon=soon, soon_weight=sum(e.weight for e in soon), free=sum(1 for w in weeks if not w.open_entries),
                  scale=scale, active=active)


@app.get("/ask", response_class=HTMLResponse)
def ask_page(request: Request):
    return render(request, "ask.html")


@app.post("/ask", response_class=HTMLResponse)
def ask_post(request: Request, q: str = Form(...)):
    from ..chat import ask

    with session() as s:
        try:
            ans = ask(s, q)
            ctx = {"q": q, "answer": ans.text, "sources": ans.sources, "model": ans.model, "error": None}
        except Exception as e:  # noqa: BLE001
            ctx = {"q": q, "answer": None, "sources": [], "model": "", "error": str(e)}
    return templates.TemplateResponse(request, "_answer.html", ctx)


@app.get("/health", response_class=HTMLResponse)
def health_page(request: Request, started: int = 0):
    import shutil as sh

    from ..llm import get_llm

    cfg = settings()
    with session() as s:
        runs = s.exec(select(SyncRun).order_by(SyncRun.id.desc())).all()[:10]
        last = next((r for r in runs if r.status != "running"), None)
        sources = json.loads(last.sources) if last else {}
        since = utcnow() - timedelta(hours=24)
        calls = s.exec(select(LLMCall).where(LLMCall.at >= since)).all()
        llm_stats = defaultdict(lambda: [0, 0])
        for c in calls:
            llm_stats[f"{c.provider}:{c.model}"][0 if c.ok else 1] += 1
        counts = {"courses": len(s.exec(select(Course)).all()), "items": len(s.exec(select(Item)).all()),
                  "assessments": len(s.exec(select(Assessment)).all()), "classes": len(s.exec(select(TimetableEvent)).all()),
                  "calendar events": len(s.exec(select(CalEvent)).all()), "study blocks": len(s.exec(select(StudyBlock)).all())}
    import socket
    with socket.socket() as sk:
        sk.settimeout(0.5)
        caldav_up = sk.connect_ex((cfg.caldav_host, cfg.caldav_port)) == 0
    checks = [
        ("CalDAV server", caldav_up, cfg.caldav_url),
        ("Gemini key", bool(cfg.gemini_api_key), f"{get_llm().gemini_calls_today()} calls in 24h (cap {cfg.gemini_daily_cap})"),
        ("Ollama fallback", get_llm().ollama_ok(), cfg.ollama_model),
        ("Gradescope session", cfg.gradescope_state.exists(),
         f"expires {gs_source.session_expiry(cfg):%d %b %Y}" if gs_source.session_expiry(cfg) else "run: uv run uniplan gradescope-login"),
        ("App notifications", webpush.count() > 0, f"{webpush.count()} device(s) on; tap to open the home-screen app"),
        ("ntfy topic", bool(cfg.ntfy_topic), "used only when no device has app notifications on"),
        ("Tailscale", bool(sh.which("tailscale")) or Path("/Applications/Tailscale.app").exists(), "needed for iPhone access away from this Mac"),
        ("Email", cfg.email_source != "none", f"EMAIL_SOURCE={cfg.email_source}"),
    ]
    nightly = scheduler.get_job("nightly")
    return render(request, "health.html", runs=runs, last=last, sources=sources, llm_stats=dict(llm_stats), checks=checks,
                  counts=counts, started=started, next_run=nightly.next_run_time if nightly else None, cfg=cfg,
                  push_key=webpush.public_key())


@app.post("/health/test-push")
def test_push():
    ok = notify.push("UniPlan test", "If you can read this, push notifications work.")
    return HTMLResponse(f"<span class='text-xs {'text-emerald-400' if ok else 'text-rose-400'}'>{'Sent' if ok else 'Failed. Turn on notifications or set NTFY_TOPIC.'}</span>")


@app.post("/push/subscribe", status_code=204)
async def push_subscribe(request: Request):
    body = await request.json()
    try:
        endpoint, keys = body["endpoint"], body["keys"]
        p256dh, secret = keys["p256dh"], keys["auth"]
    except (KeyError, TypeError) as e:
        raise HTTPException(400, "Invalid subscription") from e
    if not endpoint.startswith("https://"):
        raise HTTPException(400, "Invalid subscription")
    webpush.subscribe(endpoint, p256dh, secret)
    return Response(status_code=204)


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    cfg = settings()
    with session() as s:
        prefs = {p.key: p.value for p in s.exec(select(Pref)).all()}
        hidden = s.exec(select(Course).where(Course.hidden == True).order_by(Course.code)).all()  # noqa: E712
    return render(request, "settings.html", prefs=prefs, cfg=cfg, hidden=hidden)


@app.post("/settings")
async def save_settings(request: Request):
    form = await request.form()
    with session() as s:
        for k, v in form.items():
            p = s.get(Pref, k)
            if p is not None:
                p.value = str(v).strip()
                s.add(p)
        s.commit()
    refresh_calendar_async()
    return RedirectResponse("/settings?saved=1", status_code=303)


@app.get("/study", response_class=HTMLResponse)
def study_page(request: Request):
    with session() as s:
        now = utcnow()
        blocks = s.exec(select(StudyBlock).where(StudyBlock.end >= now).order_by(StudyBlock.start)).all()
        names = {a.id: a for a in s.exec(select(Assessment)).all()}
        todo = sorted([a for a in visible_assessments(s) if a.due_at and a.due_at > now and not a.submitted],
                      key=lambda a: a.due_at)
        from ..planner import default_effort
        efforts = {a.id: default_effort(s, a) for a in todo}
        hours_used = defaultdict(float)
        for b in s.exec(select(StudyBlock)).all():
            hours_used[b.assessment_id] += (b.end - b.start).total_seconds() / 3600
    return render(request, "study.html", blocks=blocks, names=names, todo=todo, efforts=efforts, hours_used=hours_used)


@app.post("/study/{bid}/delete")
def delete_block(bid: int):
    with session() as s:
        b = s.get(StudyBlock, bid)
        if b:
            s.delete(b)
            s.commit()
    refresh_calendar_async()
    return RedirectResponse("/study", status_code=303)
