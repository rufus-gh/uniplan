# UniPlan setup

UniPlan targets macOS with Python 3.13+ and [uv](https://docs.astral.sh/uv/).

## Quick start

```bash
git clone https://github.com/rufus-gh/uniplan.git && cd uniplan
cp .env.example .env              # fill in your tokens and passwords
uv run uniplan status            # what's configured
uv run uniplan serve             # CalDAV server + web app + nightly scheduler
```

Open **http://127.0.0.1:8765**. Log in with user `uniplan` and the `WEB_PASSWORD` from `.env`. Then press **Sync now**. The first sync reads about a month of announcements and takes a few minutes.

To keep it running all the time (it starts at login and restarts if it crashes):

```bash
uv run uniplan install-service
```

Remove it with `uv run uniplan uninstall-service`. Logs are in `~/Library/Logs/uniplan/`.

## One-time setup

| What | How |
|---|---|
| Secrets | Put them in `.env` (see `.env.example`) **or** the Keychain (`cd spikes && uv run setup_secrets.py`). A filled `.env` line wins over the Keychain. |
| Gradescope | ANU forces SSO, so you log in once yourself: `uv run uniplan gradescope-login`. Chrome opens; choose School Credentials → ANU. Health shows when the session expires, and you get a push when it needs re-doing. |
| Calendar on this Mac | Calendar → Settings → Accounts → **+** → Other CalDAV Account → Manual. Server `http://127.0.0.1:5232/`, user `uniplan`, password `CALDAV_PASSWORD`. |
| Calendar on iPhone | Install **Tailscale** on the Mac and iPhone, then run `tailscale serve --bg --https=443 5232` on the Mac. On the iPhone: Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add CalDAV Account. Server `https://<mac-name>.<tailnet>.ts.net`, same user and password. |
| Web app on iPhone | `tailscale serve --bg --https=8443 8765`, then open `https://<mac-name>.<tailnet>.ts.net:8443`. Set `PUBLIC_URL` to that address so notification taps open it. |
| Push notifications | On the iPhone, open the web app in Safari and use Share → Add to Home Screen. Open UniPlan from that icon, go to Health and tap **Turn on notifications**. Taps then open the home-screen app. Health → Test notification. |
| ntfy (fallback) | Only used when no device has notifications turned on. Install the **ntfy** app and subscribe to the `NTFY_TOPIC` value from `.env`. Tapping an ntfy notification opens Safari. |
| Email (optional) | ANU blocks forwarding, so add your ANU account to **Apple Mail** (System Settings → Internet Accounts → Microsoft Exchange). Then set `EMAIL_SOURCE=applemail` and `APPLEMAIL_ACCOUNT=<name shown in Mail>` in `.env`. macOS asks once to let UniPlan control Mail. |
| Better offline LLM (optional) | `ollama pull qwen3:8b`, then set `OLLAMA_MODEL=qwen3:8b`. It's only used when Gemini is unavailable. |

## How editing works

You can change anything on your phone. UniPlan remembers what it last wrote:

- **You edited it, and the source didn't change it** → your version is kept.
- **The source changed it, and you didn't edit it** → it's updated.
- **Both changed it** → it goes into **Review** (keep mine / use new version).
- **You deleted it** → it stays deleted, unless the source later changes it. That case also goes to Review.

Class changes found in announcements, Ed or email are applied on top of the timetable mirror:

- If the LLM is confident (≥ 0.8, adjustable in Settings) and the change matches exactly one class, it's applied automatically, marked ❌ / ⚠️ / 📍 / 💻.
- Otherwise it waits in Review, where you pick which class it means.

## Marks

- Weightings come from Canvas assignment-group weights. If a course has none, the LLM proposes them from the course pages.
- **Confirm or edit them on each course page.** Until you do, a Review item reminds you.
- Gradescope items are merged with their Canvas twins. Anything left unmatched can be put in a group from the dropdown.
- The what-if box shows your projected final for any assumed score.
- Grade bands: HD ≥ 80, D ≥ 70, CR ≥ 60, P ≥ 50.
