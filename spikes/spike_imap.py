"""Spike: Gmail-forward fallback. Reads Gmail over IMAP with an app password and looks for mail forwarded from ANU.

Before running: in Outlook on the web (ANU) set a forwarding rule to your Gmail, then send yourself a test
email at your ANU address. If it never arrives in Gmail, ANU blocks external auto-forwarding.
"""
import email
import imaplib
from email.header import decode_header, make_header

from common import save, secret

addr, pw = secret("gmail_address"), secret("gmail_app_password")
M = imaplib.IMAP4_SSL("imap.gmail.com")
M.login(addr, pw.replace(" ", ""))
print("IMAP login OK")
M.select("INBOX", readonly=True)
typ, data = M.search(None, '(SINCE "01-Nov-2026" OR TO "anu.edu.au" HEADER X-Forwarded-For "anu.edu.au")')
ids = data[0].split()
print(f"{len(ids)} candidate forwarded messages since 1 Nov")
senders = []
for i in ids[-5:]:
    _, msg = M.fetch(i, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])")
    h = email.message_from_bytes(msg[0][1])
    senders.append(str(make_header(decode_header(h.get("From", "")))).split("<")[-1].rstrip(">"))
M.logout()
save("imap", {"auth": "ok", "n_candidates": len(ids), "recent_sender_domains": sorted({s.split("@")[-1] for s in senders})})
