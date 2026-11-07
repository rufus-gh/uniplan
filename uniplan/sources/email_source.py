"""ANU email. Off by default (EMAIL_SOURCE=none).

EMAIL_SOURCE=imap       read a Gmail inbox that ANU mail is forwarded to (app password)
EMAIL_SOURCE=applemail  read mail already synced by Apple Mail on this Mac (APPLEMAIL_ACCOUNT = account name)
Only mail from senders matching EMAIL_SENDER_FILTER (domains) is kept.
"""
from __future__ import annotations

import email
import imaplib
import json
import subprocess
from datetime import UTC, datetime, timedelta
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime

from ..config import Settings
from ..db import to_utc_naive
from .base import FetchResult, FItem, SourceUnavailable, chash, course_codes, html_to_text


def _allowed(sender: str, cfg: Settings) -> bool:
    domains = [d.strip().lower() for d in cfg.email_sender_filter.split(",") if d.strip()]
    s = sender.lower()
    return any(s.endswith("@" + d) or s.endswith("." + d) for d in domains)


def _item(msgid: str, sender: str, subject: str, body: str, when: datetime | None) -> FItem:
    codes = course_codes(subject) or course_codes(body[:2000])
    return FItem(id=f"email:{chash(msgid or subject + str(when))}", source="email", kind="email",
                 course_code=codes[0] if codes else None, title=subject, body=body[:12000],
                 posted_at=to_utc_naive(when), author=sender)


def _text_of(msg: email.message.Message) -> str:
    plain, html = None, None
    for part in msg.walk() if msg.is_multipart() else [msg]:
        ctype = part.get_content_type()
        if part.get_content_maintype() == "multipart" or part.get("Content-Disposition", "").startswith("attachment"):
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if ctype == "text/plain" and plain is None:
            plain = text
        elif ctype == "text/html" and html is None:
            html = text
    return plain or html_to_text(html) or ""


def fetch_imap(cfg: Settings, days: int) -> FetchResult:
    if not (cfg.gmail_address and cfg.gmail_app_password):
        raise SourceUnavailable("GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set")
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(cfg.gmail_address.strip(), cfg.gmail_app_password.replace(" ", ""))
    M.select("INBOX", readonly=True)
    since = (datetime.now(UTC) - timedelta(days=days)).strftime("%d-%b-%Y")
    _, data = M.search(None, f'(SINCE "{since}")')
    res = FetchResult()
    for num in data[0].split()[-300:]:
        _, raw = M.fetch(num, "(BODY.PEEK[])")
        msg = email.message_from_bytes(raw[0][1])
        sender = parseaddr(str(make_header(decode_header(msg.get("From", "")))))[1]
        if not _allowed(sender, cfg):
            continue
        subject = str(make_header(decode_header(msg.get("Subject", ""))))
        try:
            when = parsedate_to_datetime(msg.get("Date"))
        except Exception:  # noqa: BLE001
            when = None
        res.items.append(_item(msg.get("Message-ID", ""), sender, subject, _text_of(msg), when))
    M.logout()
    res.meta = {"emails": len(res.items)}
    return res


JXA = r"""
function run(argv) {
  const accountName = argv[0], days = parseInt(argv[1]);
  const Mail = Application('Mail');
  const cutoff = new Date(Date.now() - days * 86400000);
  const acct = Mail.accounts.byName(accountName);
  const box = acct.mailboxes.byName('Inbox');
  const msgs = box.messages.whose({dateReceived: {'>': cutoff}})();
  const out = [];
  for (const m of msgs.slice(0, 300)) {
    out.push({id: m.messageId(), from: m.sender(), subject: m.subject(),
              date: m.dateReceived().toISOString(), body: (m.content() || '').slice(0, 12000)});
  }
  return JSON.stringify(out);
}
"""


def fetch_applemail(cfg: Settings, days: int) -> FetchResult:
    if not cfg.applemail_account:
        raise SourceUnavailable("APPLEMAIL_ACCOUNT not set (the account name shown in Apple Mail)")
    p = subprocess.run(["osascript", "-l", "JavaScript", "-e", JXA, cfg.applemail_account, str(days)],
                       capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise SourceUnavailable(f"Apple Mail read failed (grant Automation permission?): {p.stderr.strip()[:200]}")
    res = FetchResult()
    for m in json.loads(p.stdout or "[]"):
        sender = parseaddr(m.get("from", ""))[1]
        if not _allowed(sender, cfg):
            continue
        when = datetime.fromisoformat(m["date"].replace("Z", "+00:00")) if m.get("date") else None
        res.items.append(_item(m.get("id", ""), sender, m.get("subject", ""), m.get("body", ""), when))
    res.meta = {"emails": len(res.items)}
    return res


def fetch(cfg: Settings, days: int = 30) -> FetchResult:
    if cfg.email_source == "imap":
        return fetch_imap(cfg, days)
    if cfg.email_source == "applemail":
        return fetch_applemail(cfg, days)
    raise SourceUnavailable("Email disabled (EMAIL_SOURCE=none)")
