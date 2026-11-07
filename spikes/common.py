"""Shared helpers for Phase 0 spikes.

Secrets come from ../.env (project root) first, then the macOS Keychain (service 'uniplan',
filled by setup_secrets.py). Use whichever you prefer.
"""
import json
import os
import sys
from pathlib import Path

import keyring
from dotenv import load_dotenv

ENV_FILE = Path(__file__).parent.parent / ".env"
load_dotenv(ENV_FILE)
SERVICE = "uniplan"

RESULTS = Path(__file__).parent / "results"
RESULTS.mkdir(exist_ok=True)

SECRETS = {
    "canvas_token": "Canvas access token (canvas.anu.edu.au -> Account -> Settings -> + New Access Token)",
    "gradescope_email": "Gradescope login email",
    "gradescope_password": "Gradescope password",
    "ed_token": "Ed API token (https://edstem.org/au/settings/api-tokens)",
    "timetable_url": "ANU timetable iCal subscription URL",
    "gemini_api_key": "Gemini API key (https://aistudio.google.com/apikey)",
    "graph_client_id": "Microsoft Entra app (client) ID - Enter to skip",
    "gmail_address": "Gmail address for the forwarding fallback - Enter to skip",
    "gmail_app_password": "Gmail app password - Enter to skip",
}


def secret(name: str, required: bool = True) -> str | None:
    """secret('canvas_token') -> CANVAS_TOKEN from .env, else Keychain entry 'canvas_token'."""
    val = (os.environ.get(name.upper()) or "").strip() or None
    if not val:
        try:
            val = keyring.get_password(SERVICE, name)
        except Exception:  # noqa: BLE001 - Keychain unavailable/locked
            val = None
    if required and not val:
        print(f"SKIP: {name.upper()} not set in {ENV_FILE} or Keychain")
        sys.exit(2)
    return val


def save(name: str, data) -> None:
    """Save a redacted result summary for the Phase 0 report."""
    (RESULTS / f"{name}.json").write_text(json.dumps(data, indent=2, default=str))
    print(f"-> saved results/{name}.json")
