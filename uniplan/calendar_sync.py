"""Two-way sync between UniPlan's desired events and the CalDAV server your phone edits.

For every managed event we remember two hashes:
  source_hash  - what the sources wanted the last time we wrote (incl. alarms + calendar)
  written_hash - semantic hash (title/time/location/notes) of what we wrote
Then on each sync:
  server == written, source unchanged  -> nothing
  server == written, source changed    -> overwrite with the new source version
  server != written, source unchanged  -> you edited it on your phone: keep yours
  server != written, source changed    -> CONFLICT -> review queue (keep mine / take source)
"""
from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Protocol

import bcrypt
from icalendar import Alarm, Calendar, Event
from sqlmodel import Session, select

from .config import Settings, settings
from .db import CalEvent, Review, utcnow

log = logging.getLogger("uniplan.caldav")

CALENDARS = {
    "classes": ("Classes", "#3B82F6"),
    "due": ("Due Dates", "#EF4444"),
    "exams": ("Exams", "#A855F7"),
    "study": ("Study Blocks", "#10B981"),
    "personal": ("Personal", "#F59E0B"),
}
MANAGED = ["classes", "due", "exams", "study"]


@dataclass
class DesiredEvent:
    uid: str
    calendar: str
    summary: str
    start: datetime | date  # naive UTC datetime, or date for all-day
    end: datetime | date
    location: str = ""
    description: str = ""
    url: str = ""
    alarms: list[int] = field(default_factory=list)  # minutes before
    transparent: bool = False


def _fmt_dt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        if v.tzinfo is not None:
            v = v.astimezone(UTC).replace(tzinfo=None)
        return v.strftime("%Y%m%dT%H%M%SZ")
    return v.isoformat()


def _norm(s) -> str:
    return " ".join(str(s or "").split())


def semantic_hash(comp) -> str:
    """Hash of the fields a person can see/edit. Ignores DTSTAMP, SEQUENCE, X- props, alarms."""
    start = comp.decoded("DTSTART") if comp.get("DTSTART") else None
    if comp.get("DTEND"):
        end = comp.decoded("DTEND")
    elif comp.get("DURATION") and start is not None:
        end = start + comp.decoded("DURATION")
    else:
        end = start
    parts = [_norm(comp.get("SUMMARY")), _fmt_dt(start), _fmt_dt(end), _norm(comp.get("LOCATION")), _norm(comp.get("DESCRIPTION"))]
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:24]


def first_event(ics: str):
    for comp in Calendar.from_ical(ics).walk("VEVENT"):
        return comp
    return None


def to_ics(ev: DesiredEvent) -> str:
    cal = Calendar()
    cal.add("prodid", "-//UniPlan//EN")
    cal.add("version", "2.0")
    e = Event()
    e.add("uid", ev.uid)
    e.add("dtstamp", datetime.now(UTC))
    for key, val in (("dtstart", ev.start), ("dtend", ev.end)):
        e.add(key, val.replace(tzinfo=UTC) if isinstance(val, datetime) else val)
    e.add("summary", ev.summary)
    if ev.location:
        e.add("location", ev.location)
    if ev.description:
        e.add("description", ev.description)
    if ev.url:
        e.add("url", ev.url)
    if ev.transparent:
        e.add("transp", "TRANSPARENT")
    for m in ev.alarms:
        a = Alarm()
        a.add("action", "DISPLAY")
        a.add("description", ev.summary)
        a.add("trigger", timedelta(minutes=-m))
        e.add_component(a)
    cal.add_component(e)
    return cal.to_ical().decode()


def desired_hashes(ev: DesiredEvent) -> tuple[str, str, str]:
    ics = to_ics(ev)
    written = semantic_hash(first_event(ics))
    source = hashlib.sha256(f"{written}|{ev.calendar}|{sorted(ev.alarms)}|{ev.url}|{ev.transparent}".encode()).hexdigest()[:24]
    return ics, source, written


# ---------------- stores ----------------

class Store(Protocol):
    def list(self, cal: str) -> dict[str, str]: ...
    def put(self, cal: str, uid: str, ics: str) -> None: ...
    def delete(self, cal: str, uid: str) -> None: ...


class MemoryStore:
    def __init__(self):
        self.cals: dict[str, dict[str, str]] = {k: {} for k in CALENDARS}

    def list(self, cal):
        return dict(self.cals[cal])

    def put(self, cal, uid, ics):
        self.cals[cal][uid] = ics

    def delete(self, cal, uid):
        self.cals[cal].pop(uid, None)


class CalDAVStore:
    def __init__(self, cfg: Settings | None = None):
        import caldav

        cfg = cfg or settings()
        self.client = caldav.DAVClient(cfg.caldav_url, username=cfg.caldav_user, password=cfg.caldav_password)
        self.principal = self.client.principal()
        existing = {c.url.path.rstrip("/").split("/")[-1]: c for c in self.principal.calendars()}
        self.cals = {}
        for key, (name, color) in CALENDARS.items():
            cal = existing.get(key)
            if cal is None:
                cal = self.principal.make_calendar(name=name, cal_id=key)
                try:
                    from caldav.elements import ical
                    cal.set_properties([ical.CalendarColor(color)])
                except Exception:  # noqa: BLE001
                    pass
            self.cals[key] = cal
        self._objs: dict[tuple[str, str], object] = {}

    def list(self, cal):
        out = {}
        for obj in self.cals[cal].events():
            comp = first_event(obj.data)
            if comp is None:
                continue
            uid = str(comp.get("UID"))
            out[uid] = obj.data
            self._objs[(cal, uid)] = obj
        return out

    def put(self, cal, uid, ics):
        obj = self._objs.get((cal, uid))
        if obj is not None:
            obj.data = ics
            obj.save()
        else:
            self._objs[(cal, uid)] = self.cals[cal].save_event(ics)

    def delete(self, cal, uid):
        obj = self._objs.pop((cal, uid), None)
        if obj is None:
            try:
                obj = self.cals[cal].event_by_uid(uid)
            except Exception:  # noqa: BLE001
                return
        obj.delete()


# ---------------- engine ----------------

@dataclass
class SyncStats:
    created: int = 0
    updated: int = 0
    kept_user_edits: int = 0
    conflicts: int = 0
    deleted: int = 0
    user_deleted: int = 0


def _open_conflict(s: Session, rec: CalEvent, desired_ics: str, server_ics: str | None, source_hash: str, summary: str):
    ref = f"conflict:{rec.uid}:{source_hash}"
    if s.exec(select(Review).where(Review.ref == ref)).first():
        return False
    for old in s.exec(select(Review).where(Review.ref.startswith(f"conflict:{rec.uid}:"), Review.status == "open")).all():
        old.status, old.resolution = "resolved", "superseded"
        s.add(old)
    what = "you deleted it" if server_ics is None else "you edited it"
    s.add(Review(kind="conflict", ref=ref, title=f"Calendar conflict: {summary}",
                 detail=f"The source changed this event after {what} on your device.",
                 payload=json.dumps({"uid": rec.uid, "calendar": rec.calendar, "desired_ics": desired_ics,
                                     "server_ics": server_ics, "source_hash": source_hash})))
    return True


def sync_calendars(s: Session, store: Store, desired: list[DesiredEvent]) -> SyncStats:
    st = SyncStats()
    records = {r.uid: r for r in s.exec(select(CalEvent)).all()}
    server: dict[str, tuple[str, str]] = {}
    for cal in MANAGED:
        for uid, ics in store.list(cal).items():
            server[uid] = (cal, ics)
    seen = set()
    for d in desired:
        seen.add(d.uid)
        ics, src_h, wr_h = desired_hashes(d)
        rec = records.get(d.uid)
        srv = server.get(d.uid)
        if rec is None:
            if srv and semantic_hash(first_event(srv[1])) == wr_h and srv[0] == d.calendar:
                rec = CalEvent(uid=d.uid, calendar=d.calendar, source_hash=src_h, written_hash=wr_h, desired_ics=ics)
            else:
                if srv and srv[0] != d.calendar:
                    store.delete(srv[0], d.uid)
                store.put(d.calendar, d.uid, ics)
                rec = CalEvent(uid=d.uid, calendar=d.calendar, source_hash=src_h, written_hash=wr_h, desired_ics=ics)
                st.created += 1
            s.add(rec)
            continue
        source_changed = src_h != rec.source_hash
        if srv is None:
            if not rec.deleted_by_user:
                rec.deleted_by_user = True
                st.user_deleted += 1
            if source_changed and _open_conflict(s, rec, ics, None, src_h, d.summary):
                rec.in_conflict = True
                st.conflicts += 1
            rec.desired_ics = ics
            s.add(rec)
            continue
        user_changed = semantic_hash(first_event(srv[1])) != rec.written_hash
        if not source_changed:
            if user_changed and not rec.user_modified:
                rec.user_modified = True
                st.kept_user_edits += 1
        elif not user_changed:
            if srv[0] != d.calendar:
                store.delete(srv[0], d.uid)
            store.put(d.calendar, d.uid, ics)
            rec.calendar, rec.source_hash, rec.written_hash = d.calendar, src_h, wr_h
            rec.user_modified = rec.in_conflict = False
            st.updated += 1
        else:
            if _open_conflict(s, rec, ics, srv[1], src_h, d.summary):
                st.conflicts += 1
            rec.in_conflict = True
        rec.desired_ics, rec.updated_at = ics, utcnow()
        s.add(rec)
    for uid, rec in records.items():
        if uid in seen:
            continue
        srv = server.get(uid)
        if srv is not None and semantic_hash(first_event(srv[1])) == rec.written_hash:
            store.delete(srv[0], uid)
            st.deleted += 1
        # if the user edited it, leave it on their calendar as their own event
        s.delete(rec)
    s.commit()
    return st


def resolve_conflict(s: Session, store: Store, review: Review, choice: str) -> None:
    """choice: 'source' (take the new source version) or 'mine' (keep the device version)."""
    data = review.data()
    rec = s.get(CalEvent, data["uid"])
    if rec is None:
        review.status, review.resolution = "resolved", "event gone"
    else:
        if choice == "source":
            store.list(rec.calendar)
            store.put(rec.calendar, rec.uid, data["desired_ics"])
            rec.written_hash = semantic_hash(first_event(data["desired_ics"]))
            rec.deleted_by_user = rec.user_modified = False
        else:
            current = store.list(rec.calendar).get(rec.uid)
            if current is not None:
                rec.written_hash = semantic_hash(first_event(current))
                rec.user_modified = True
        rec.source_hash = data["source_hash"]
        rec.in_conflict = False
        s.add(rec)
        review.status, review.resolution = "resolved", choice
    s.add(review)
    s.commit()


# ---------------- radicale ----------------

def write_radicale_config(cfg: Settings | None = None):
    cfg = cfg or settings()
    if not cfg.caldav_password:
        raise SystemExit("CALDAV_PASSWORD is not set in .env")
    root = cfg.data_dir / "radicale"
    root.mkdir(exist_ok=True)
    users = root / "users"
    existing = users.read_text().strip() if users.exists() else ""
    if not (existing.startswith(cfg.caldav_user + ":") and bcrypt.checkpw(cfg.caldav_password.encode(), existing.split(":", 1)[1].encode())):
        users.write_text(f"{cfg.caldav_user}:{bcrypt.hashpw(cfg.caldav_password.encode(), bcrypt.gensalt()).decode()}\n")
        users.chmod(0o600)
    conf = root / "config"
    conf.write_text(f"""[server]
hosts = {cfg.caldav_host}:{cfg.caldav_port}
[auth]
type = htpasswd
htpasswd_filename = {users}
htpasswd_encryption = bcrypt
[storage]
filesystem_folder = {root / 'collections'}
[rights]
type = owner_only
[logging]
level = warning
""")
    return conf


def start_radicale(cfg: Settings | None = None) -> subprocess.Popen:
    conf = write_radicale_config(cfg)
    return subprocess.Popen([sys.executable, "-m", "radicale", "--config", str(conf)])


def ensure_local_cert(cfg: Settings | None = None) -> tuple:
    """Self-signed certificate for this Mac only (127.0.0.1 / localhost), used by the HTTPS CalDAV listener."""
    cfg = cfg or settings()
    root = cfg.data_dir / "radicale"
    root.mkdir(exist_ok=True)
    cert, key = root / "local-cert.pem", root / "local-key.pem"
    if not cert.exists():
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "800",
                        "-keyout", str(key), "-out", str(cert), "-subj", "/CN=UniPlan Local Calendar",
                        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
                        "-addext", "extendedKeyUsage=serverAuth"], check=True, capture_output=True)
        key.chmod(0o600)
    return cert, key


def start_radicale_tls(cfg: Settings | None = None, port: int = 5233) -> subprocess.Popen:
    """Same calendars over HTTPS: macOS Calendar won't send a password over plain HTTP."""
    cfg = cfg or settings()
    plain = write_radicale_config(cfg)
    cert, key = ensure_local_cert(cfg)
    conf = plain.with_name("config-tls")
    conf.write_text(plain.read_text().replace(f"hosts = {cfg.caldav_host}:{cfg.caldav_port}",
                                              f"hosts = {cfg.caldav_host}:{port}\nssl = True\ncertificate = {cert}\nkey = {key}"))
    return subprocess.Popen([sys.executable, "-m", "radicale", "--config", str(conf)])
