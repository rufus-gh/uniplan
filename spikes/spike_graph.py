"""Spike: Microsoft Graph Mail.Read via device-code login against your ANU account.

Needs an Entra app registration (public client, 'Allow public client flows' = Yes,
delegated permission Mail.Read). The key question this answers: does ANU let a student
consent to a third-party app reading their own mail, or does it demand admin approval?
"""
import msal
import requests

from common import save, secret

client_id = secret("graph_client_id")
app = msal.PublicClientApplication(client_id, authority="https://login.microsoftonline.com/organizations")
flow = app.initiate_device_flow(scopes=["Mail.Read"])
if "user_code" not in flow:
    save("graph", {"result": "device_flow_failed", "error": flow.get("error_description")})
    raise SystemExit(flow)
print(flow["message"])  # tells you the URL + code to enter in a browser
tok = app.acquire_token_by_device_flow(flow)

if "access_token" not in tok:
    err = tok.get("error_description", "")
    verdict = "admin_consent_required" if ("AADSTS65001" in err or "AADSTS90094" in err or "admin" in err.lower()) else "failed"
    save("graph", {"result": verdict, "error_code": tok.get("error_codes"), "error": err[:400]})
    raise SystemExit(f"Graph login failed: {verdict}\n{err}")

r = requests.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
                 params={"$top": 5, "$select": "subject,from,receivedDateTime"},
                 headers={"Authorization": f"Bearer {tok['access_token']}"}, timeout=30)
print("Inbox read:", r.status_code)
save("graph", {"result": "ok" if r.ok else f"http_{r.status_code}", "n_messages_read": len(r.json().get("value", [])) if r.ok else 0,
               "refresh_token_issued": "refresh_token" in tok})
