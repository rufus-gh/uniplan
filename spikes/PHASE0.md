# Phase 0 — Feasibility status

Throwaway scripts that proved each integration before any app code was written. Run them from `spikes/`. Secrets come from `../.env`, which is gitignored and chmod 600. Each spike writes a summary with no personal content to `results/<name>.json`.

| # | Check | Script | Status |
|---|---|---|---|
| 1 | CalDAV server + detecting edits made on the phone | `spike_radicale.py` | ✅ **PASS**: Radicale 3.9 runs locally. A simulated phone edit is caught by both the ETag and the content hash. |
| 2 | Local LLM quality | `spike_llm.py` | ⚠️ The small installed models score **llama3.2:3b 66%** and **phi4-mini 69%** on the 8-case extraction test, which is too weak. An 8B model is needed (see step D). |
| 3 | Gemini free tier vs Ollama | `spike_llm.py` | ✅ **gemini-flash-lite-latest scored 93%** (vs phi4-mini at 69%). `gemini-flash-latest` and `gemini-3.8-flash` returned **503 overloaded** during this test, and `gemini-omni-*` has zero free quota. So the client needs a fallback chain: Flash, then Flash-Lite, then Ollama, with retries. Never auto-pick from ListModels. |
| 4 | Canvas API | `spike_canvas.py` | ✅ **PASS**. The API needs `include[]=` (with brackets). There are 5 active courses, and assignment-group weights are set in some of them (e.g. COMP3670: 21/4/4/23/55, STAT2001: 5/10/15/70). **Syllabus bodies are empty placeholders**, so weightings must come from group weights plus ANU Programs & Courses class summaries, then you confirm. Few Canvas assignments have `due_at`. |
| 5 | Gradescope | `spike_gradescope.py`, `spike_gradescope_sso.py` | ❌ Password-only access is blocked by ANU (*"can only be accessed by logging in through your LMS or Single Sign-On"*). ✅ Decided: use a **saved SSO session**. Run `spike_gradescope_sso.py --login` once in your own Chrome, then the plain run reuses the cookies. ⏳ Not yet run. |
| 6 | Ed region + API | `spike_ed.py` | ✅ **PASS**. AU tokens work on `https://edstem.org/api` (`au.edstem.org` redirects to the web app). There is 1 active Ed course (COMP3670). Pinned, announcement and staff-answered flags and thread detail are all available. |
| 7 | Timetable feed + UID stability | `spike_timetable.py` | ✅ The first run fetched 177 events (text/calendar). **Run it again tomorrow** to check UID stability. |
| 8 | Outlook via Graph | — | ❌ ANU denies Entra app registrations. Dropped in favour of the Gmail forward. |
| 9 | Gmail-forward fallback | `spike_imap.py` | ⚠️ Superseded: mail is now read from Apple Mail, because ANU blocks external forwarding. |
| 10 | ntfy push | `spike_ntfy.py` | ⏳ Needs the topic and the iPhone app. |
| 11 | Tailscale HTTPS to iPhone | manual | ⏳ Tailscale isn't installed yet. |
