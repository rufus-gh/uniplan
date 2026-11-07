"""Settings: read from .env first, then the macOS Keychain (service 'uniplan', lowercase key names)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
KEYCHAIN_SERVICE = "uniplan"


def _get(name: str, default: str | None = None) -> str | None:
    val = (os.environ.get(name) or "").strip()
    if val:
        return val
    if os.environ.get("UNIPLAN_NO_KEYCHAIN") != "1":
        try:
            import keyring

            val = keyring.get_password(KEYCHAIN_SERVICE, name.lower())
        except Exception:  # noqa: BLE001 - Keychain locked/unavailable
            val = None
    return val or default


@dataclass
class Settings:
    data_dir: Path
    timezone: str = "Australia/Sydney"
    nightly_sync_time: str = "02:00"
    # sources
    canvas_base: str = "https://canvas.anu.edu.au"
    canvas_token: str | None = None
    ed_base: str = "https://edstem.org/api"
    ed_web: str = "https://edstem.org/au"
    ed_token: str | None = None
    timetable_url: str | None = None
    gradescope_base: str = "https://www.gradescope.com"
    email_source: str = "none"  # none | imap | applemail
    gmail_address: str | None = None
    gmail_app_password: str | None = None
    applemail_account: str | None = None
    email_sender_filter: str = "anu.edu.au,gradescope.com,instructure.com,edstem.org"
    # llm
    gemini_api_key: str | None = None
    gemini_models: list[str] = field(default_factory=lambda: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"])
    gemini_min_interval: float = 4.5
    gemini_daily_cap: int = 400
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = "phi4-mini:latest"
    llm_lookback_days: int = 30
    # notify
    ntfy_server: str = "https://ntfy.sh"
    ntfy_topic: str | None = None
    public_url: str = "http://127.0.0.1:8765"
    # servers
    web_host: str = "127.0.0.1"
    web_port: int = 8765
    web_user: str = "uniplan"
    web_password: str | None = None
    caldav_host: str = "127.0.0.1"
    caldav_port: int = 5232
    caldav_user: str = "uniplan"
    caldav_password: str | None = None

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "uniplan.db"

    @property
    def gradescope_state(self) -> Path:
        return self.data_dir / "gradescope_state.json"

    @property
    def caldav_url(self) -> str:
        return f"http://{self.caldav_host}:{self.caldav_port}/"


def load_settings() -> Settings:
    data_dir = Path(_get("UNIPLAN_DATA_DIR") or ROOT / ".data")
    data_dir.mkdir(parents=True, exist_ok=True)
    g = _get
    models = g("GEMINI_MODELS")
    return Settings(
        data_dir=data_dir,
        timezone=g("TIMEZONE", "Australia/Sydney"),
        nightly_sync_time=g("NIGHTLY_SYNC_TIME", "02:00"),
        canvas_base=g("CANVAS_BASE", "https://canvas.anu.edu.au"),
        canvas_token=g("CANVAS_TOKEN"),
        ed_base=g("ED_BASE", "https://edstem.org/api"),
        ed_web=g("ED_WEB", "https://edstem.org/au"),
        ed_token=g("ED_TOKEN"),
        timetable_url=g("TIMETABLE_URL"),
        email_source=(g("EMAIL_SOURCE", "none") or "none").lower(),
        gmail_address=g("GMAIL_ADDRESS"),
        gmail_app_password=g("GMAIL_APP_PASSWORD"),
        applemail_account=g("APPLEMAIL_ACCOUNT"),
        email_sender_filter=g("EMAIL_SENDER_FILTER", "anu.edu.au,gradescope.com,instructure.com,edstem.org"),
        gemini_api_key=g("GEMINI_API_KEY"),
        gemini_models=[m.strip() for m in models.split(",")] if models else ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
        gemini_min_interval=float(g("GEMINI_MIN_INTERVAL", "4.5")),
        gemini_daily_cap=int(g("GEMINI_DAILY_CAP", "400")),
        ollama_host=g("OLLAMA_HOST", "http://127.0.0.1:11434"),
        ollama_model=g("OLLAMA_MODEL", "phi4-mini:latest"),
        llm_lookback_days=int(g("LLM_LOOKBACK_DAYS", "30")),
        ntfy_server=g("NTFY_SERVER", "https://ntfy.sh"),
        ntfy_topic=g("NTFY_TOPIC"),
        public_url=g("PUBLIC_URL", f"http://127.0.0.1:{g('WEB_PORT', '8765')}"),
        web_host=g("WEB_HOST", "127.0.0.1"),
        web_port=int(g("WEB_PORT", "8765")),
        web_password=g("WEB_PASSWORD"),
        caldav_host=g("CALDAV_HOST", "127.0.0.1"),
        caldav_port=int(g("CALDAV_PORT", "5232")),
        caldav_password=g("CALDAV_PASSWORD"),
    )


@lru_cache(maxsize=1)
def settings() -> Settings:
    return load_settings()
