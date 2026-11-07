import json
from base64 import urlsafe_b64decode, urlsafe_b64encode
from types import SimpleNamespace

import http_ece
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from uniplan import notify, webpush
from uniplan.web import app as webapp

AUTH = ("uniplan", "test-pw")
ENDPOINT = "https://web.push.apple.com/abc"


def _b64(b: bytes) -> str:
    return urlsafe_b64encode(b).rstrip(b"=").decode()


class FakePushService:
    """Stands in for Apple's push service and keeps what it was sent."""

    def __init__(self, status=201):
        self.status, self.calls = status, []

    def post(self, url, data=None, headers=None, timeout=None):
        self.calls.append(SimpleNamespace(url=url, data=data, headers=headers))
        return SimpleNamespace(status_code=self.status, reason="", text="", content=b"", headers={})


def test_install_files_need_no_login_but_pages_still_do(s):
    with TestClient(webapp.app) as c:
        sw = c.get("/sw.js")
        assert sw.status_code == 200 and "javascript" in sw.headers["content-type"]
        assert sw.headers["cache-control"] == "no-cache"
        manifest = c.get("/manifest.webmanifest")
        assert manifest.status_code == 200 and manifest.json()["display"] == "standalone"
        assert c.get("/").status_code == 401
        assert c.get("/health").status_code == 401
        assert c.post("/push/subscribe", json={}).status_code == 401


def test_home_page_declares_the_app(s):
    with TestClient(webapp.app) as c:
        html = c.get("/", auth=AUTH).text
    assert 'rel="manifest"' in html and 'rel="apple-touch-icon"' in html


def test_subscribe_stores_and_replaces_device(s):
    body = {"endpoint": ENDPOINT, "keys": {"p256dh": "a", "auth": "b"}}
    with TestClient(webapp.app) as c:
        assert c.post("/push/subscribe", json=body, auth=AUTH).status_code == 204
        assert c.post("/push/subscribe", json=body, auth=AUTH).status_code == 204
        bad = {"endpoint": "http://127.0.0.1/x", "keys": {"p256dh": "a", "auth": "b"}}
        assert c.post("/push/subscribe", json=bad, auth=AUTH).status_code == 400
    assert webpush.count() == 1


def test_send_encrypts_for_the_device_and_signs_for_apple(s):
    device = ec.generate_private_key(ec.SECP256R1())
    secret = b"0123456789abcdef"
    point = device.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    webpush.subscribe(ENDPOINT, _b64(point), _b64(secret))

    service = FakePushService()
    assert webpush.send("Title", "Body", url="/review", requests_session=service) == 1

    call = service.calls[0]
    assert call.url == ENDPOINT
    assert b"Body" not in call.data  # the push service can't read it
    plain = http_ece.decrypt(call.data, private_key=device, auth_secret=secret, version="aes128gcm")
    assert json.loads(plain) == {"title": "Title", "body": "Body", "url": "/review"}

    token = call.headers["Authorization"].split()[1].split(",")[0]
    claims = json.loads(urlsafe_b64decode(token.split(".")[1] + "=="))
    assert claims["aud"] == "https://web.push.apple.com"
    assert "localhost" not in claims["sub"]


def test_expired_device_is_removed(s):
    device = ec.generate_private_key(ec.SECP256R1())
    point = device.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    webpush.subscribe(ENDPOINT, _b64(point), _b64(b"0123456789abcdef"))
    assert webpush.send("t", "b", requests_session=FakePushService(status=410)) == 0
    assert webpush.count() == 0


def test_notify_skips_ntfy_after_web_push(s, monkeypatch):
    posted = []
    monkeypatch.setattr(notify.webpush, "send", lambda title, body: 1)
    monkeypatch.setattr(notify.requests, "post", lambda *a, **k: posted.append(a))
    assert notify.push("t", "m") is True
    assert posted == []


def test_notify_falls_back_to_ntfy(s, monkeypatch):
    posted = []
    monkeypatch.setattr(notify.webpush, "send", lambda title, body: 0)
    monkeypatch.setattr(notify, "settings", lambda: SimpleNamespace(ntfy_topic="t", ntfy_server="https://ntfy.sh",
                                                                    public_url="https://x"))
    monkeypatch.setattr(notify.requests, "post", lambda *a, **k: posted.append(a) or SimpleNamespace(ok=True))
    assert notify.push("t", "m") is True
    assert len(posted) == 1
