"""uniplan command line.

  uniplan serve               run the CalDAV server + web app + nightly scheduler (what launchd runs)
  uniplan sync                run one full sync now (starts a temporary CalDAV server if needed)
  uniplan gradescope-login    log in to Gradescope via ANU SSO in Chrome (session is reused nightly)
  uniplan install-service     install + start the launchd agent so UniPlan runs at login and stays up
  uniplan uninstall-service   stop + remove the launchd agent
  uniplan status              show config + last sync
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import plistlib
import socket
import subprocess
import sys
import time
from pathlib import Path

from .config import ROOT, settings

LABEL = "au.uniplan.server"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
LOG_DIR = Path.home() / "Library/Logs/uniplan"


def _port_open(host: str, port: int) -> bool:
    with socket.socket() as sk:
        sk.settimeout(0.5)
        return sk.connect_ex((host, port)) == 0


def ensure_radicale():
    from .calendar_sync import start_radicale

    cfg = settings()
    if _port_open(cfg.caldav_host, cfg.caldav_port):
        return None
    proc = start_radicale(cfg)
    for _ in range(40):
        if _port_open(cfg.caldav_host, cfg.caldav_port):
            return proc
        time.sleep(0.25)
    raise SystemExit("CalDAV server (Radicale) did not start")


def setup_logging():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    from logging.handlers import RotatingFileHandler

    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = RotatingFileHandler(LOG_DIR / "uniplan.log", maxBytes=2_000_000, backupCount=5)
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [fh, sh]
    for noisy in ("httpx", "urllib3", "caldav", "google_genai", "apscheduler.executors.default"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def cmd_serve(_):
    import uvicorn

    from .db import init_db

    setup_logging()
    init_db()
    cfg = settings()
    if not cfg.web_password:
        raise SystemExit("WEB_PASSWORD is not set in .env")
    proc = ensure_radicale()
    from .calendar_sync import start_radicale_tls
    tls = None if _port_open(cfg.caldav_host, 5233) else start_radicale_tls(cfg)
    try:
        uvicorn.run("uniplan.web.app:app", host=cfg.web_host, port=cfg.web_port, log_level="warning")
    finally:
        for p in (proc, tls):
            if p:
                p.terminate()


def cmd_sync(_):
    from .db import init_db
    from .pipeline import run_sync

    setup_logging()
    init_db()
    proc = ensure_radicale()
    try:
        run = run_sync("cli")
        if run is None:
            print("A sync is already running.")
            return
        print(run.log)
        print(f"\nstatus: {run.status}")
        print(json.dumps(json.loads(run.digest), indent=2)[:4000])
    finally:
        if proc:
            proc.terminate()


def cmd_gradescope_login(_):
    from .sources.gradescope import login_interactive

    login_interactive(settings())


def cmd_install_service(_):
    uv = subprocess.run(["which", "uv"], capture_output=True, text=True).stdout.strip() or str(Path.home() / ".local/bin/uv")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": LABEL,
        "ProgramArguments": [uv, "run", "--project", str(ROOT), "uniplan", "serve"],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(LOG_DIR / "launchd.out.log"),
        "StandardErrorPath": str(LOG_DIR / "launchd.err.log"),
        "EnvironmentVariables": {"PATH": f"{Path(uv).parent}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
    }
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    PLIST.write_bytes(plistlib.dumps(plist))
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr)
        raise SystemExit("launchctl bootstrap failed")
    cfg = settings()
    print(f"Installed {PLIST}\nUniPlan will start at login and restart if it crashes.\nOpen http://{cfg.web_host}:{cfg.web_port}")


def cmd_uninstall_service(_):
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("Removed launchd agent.")


def cmd_status(_):
    from sqlmodel import select

    from .db import SyncRun, init_db, session

    init_db()
    cfg = settings()
    for k in ("canvas_token", "ed_token", "timetable_url", "gemini_api_key", "ntfy_topic", "caldav_password", "web_password"):
        print(f"{k:18} {'set' if getattr(cfg, k) else 'MISSING'}")
    print(f"{'gradescope':18} {'session saved' if cfg.gradescope_state.exists() else 'not logged in'}")
    print(f"{'email':18} {cfg.email_source}")
    print(f"{'web':18} http://{cfg.web_host}:{cfg.web_port}  {'(running)' if _port_open(cfg.web_host, cfg.web_port) else '(not running)'}")
    print(f"{'caldav':18} {cfg.caldav_url}  {'(running)' if _port_open(cfg.caldav_host, cfg.caldav_port) else '(not running)'}")
    with session() as s:
        run = s.exec(select(SyncRun).order_by(SyncRun.id.desc())).first()
        print(f"{'last sync':18} {run.started_at if run else 'never'} {run.status if run else ''}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="uniplan", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in [("serve", cmd_serve), ("sync", cmd_sync), ("gradescope-login", cmd_gradescope_login),
                     ("install-service", cmd_install_service), ("uninstall-service", cmd_uninstall_service),
                     ("status", cmd_status)]:
        sub.add_parser(name).set_defaults(fn=fn)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
