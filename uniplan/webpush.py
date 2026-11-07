"""Web Push to the installed home-screen app.

iOS always opens an ntfy link in Safari, but a notification sent to the home-screen app itself opens that app.
Payloads are encrypted end to end, so Apple's push service relays them without being able to read them.
"""
from __future__ import annotations

import json
import logging
import os
from base64 import urlsafe_b64encode
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush
from sqlmodel import select

from .config import settings
from .db import PushSubscription, session

log = logging.getLogger("uniplan.webpush")


def _vapid() -> Vapid02:
    path = settings().data_dir / "vapid.pem"
    if path.exists():
        return Vapid02.from_file(str(path))
    v = Vapid02()
    v.generate_keys()
    v.save_key(str(path))
    os.chmod(path, 0o600)
    return v


def public_key() -> str:
    """The key the browser needs to subscribe, as unpadded base64url."""
    raw = _vapid().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return urlsafe_b64encode(raw).rstrip(b"=").decode()


def _contact() -> str:
    # Apple rejects a localhost contact, so use the tailnet address when there is one.
    url = urlparse(settings().public_url)
    return f"https://{url.hostname}" if url.scheme == "https" and url.hostname else "https://example.com"


def subscribe(endpoint: str, p256dh: str, auth: str) -> None:
    with session() as s:
        s.merge(PushSubscription(endpoint=endpoint, p256dh=p256dh, auth=auth))
        s.commit()


def unsubscribe(endpoint: str) -> None:
    with session() as s:
        row = s.get(PushSubscription, endpoint)
        if row:
            s.delete(row)
            s.commit()


def count() -> int:
    with session() as s:
        return len(s.exec(select(PushSubscription)).all())


def send(title: str, body: str, url: str = "/", requests_session=None) -> int:
    """Notify every subscribed device. Returns how many accepted it; dead subscriptions are removed."""
    with session() as s:
        subs = [(r.endpoint, r.p256dh, r.auth) for r in s.exec(select(PushSubscription)).all()]
    if not subs:
        return 0
    vapid = _vapid()
    payload = json.dumps({"title": title, "body": body, "url": url})
    sent = 0
    for endpoint, p256dh, auth in subs:
        info = {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}
        try:
            webpush(info, payload, vapid_private_key=vapid, vapid_claims={"sub": _contact()}, ttl=86400, timeout=15,
                    requests_session=requests_session)
            sent += 1
        except WebPushException as e:
            status = e.response.status_code if e.response is not None else None
            if status in (404, 410):
                log.info("removing expired push subscription")
                unsubscribe(endpoint)
            else:
                log.warning("web push failed (%s): %s", status, e)
        except Exception as e:  # noqa: BLE001 - a bad subscription must not stop the others or the sync
            log.warning("web push failed: %s", e)
    return sent
