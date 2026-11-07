"""Spike: send one test push via ntfy.sh to your private random topic. Subscribe in the ntfy iPhone app first."""
import requests

from common import save, secret

topic = secret("ntfy_topic")
r = requests.post(f"https://ntfy.sh/{topic}", data="UniPlan test push - if you see this, ntfy works.".encode(),
                  headers={"Title": "UniPlan", "Tags": "calendar", "Priority": "3"}, timeout=15)
print("ntfy:", r.status_code)
save("ntfy", {"status": r.status_code})
