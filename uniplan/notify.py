"""Push notifications: Web Push to the home-screen app, or ntfy if no device has turned that on.

Only a short title/count and a link - never full message content.
"""
from __future__ import annotations

import logging

import requests

from . import webpush
from .config import settings

log = logging.getLogger("uniplan.notify")


def push(title: str, message: str, priority: int = 3) -> bool:
    if webpush.send(title, message):
        return True
    cfg = settings()
    if not cfg.ntfy_topic:
        return False
    try:
        r = requests.post(f"{cfg.ntfy_server.rstrip('/')}/{cfg.ntfy_topic}", data=message.encode(), timeout=15,
                          headers={"Title": title.encode("utf-8").decode("latin-1", "ignore"), "Priority": str(priority),
                                   "Click": cfg.public_url})
        return r.ok
    except requests.RequestException as e:
        log.warning("ntfy failed: %s", e)
        return False
