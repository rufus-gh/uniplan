# Lemma

A keyboard-first desktop app for getting help with uni maths from Claude. It runs on **your own Claude
account** (Pro/Max), so you don't need an API key. Like Conductor, it drives the Claude Code CLI installed on this Mac.

## Setup

```bash
cd desktop
npm install
claude auth login     # once, if the CLI isn't signed in
npm run dev           # run in development
npm run dist          # build dist/mac-arm64/Lemma.app
```

## How it works

**Accounts, not API keys (same approach as Conductor)**

- **Claude:** runs through Claude Code via `@anthropic-ai/claude-agent-sdk`, using the Claude Code build bundled with
  the SDK (current, so Opus/Sonnet/Haiku 5.5 work). It reads the same keychain login as your `claude` CLI.
- **OpenAI:** runs through Codex via `@openai/codex-sdk`, using your ChatGPT login (`~/.codex/auth.json`, shared with
  the Codex app). The model list comes from Codex's model cache, so it matches what your plan offers.
- API-key variables are stripped, so replies always come from your subscription. Both providers are chat only: no
  tools, MCP servers, plugins or notify hooks.
- You can switch model mid-chat. Each provider resumes its own session, and any turns it missed are replayed as context.

**Course library (RAG)**: `src/main/rag/`

- Add PDFs, Markdown, LaTeX, TXT, DOCX and VTT/SRT lecture transcripts per course (`⌘L`, drag-and-drop or pick a
  folder). Files are copied into `~/Library/Application Support/Lemma/library/` and split into ~1,000-character passages
  that keep page numbers and transcript timestamps.
- **Numbered references** ("prop 3.12", "Theorem 2.4", "Def 1.5") are looked up exactly. Each numbered statement starts
  its own passage, and the next passage (usually the proof) comes with it.
- **Everything else** uses hybrid search: BM25 keyword ranking (with maths symbols spelled out, so "epsilon" matches
  `ε`) plus semantic embeddings, fused by reciprocal rank. Choose the embedding model in **Settings** (⌘,): local
  `bge-small` (ONNX, on-device, ~33 MB downloaded once, works offline) or **Qwen3 Embedding 8B** through Hack Club AI
  (needs internet and an API key; on a real course it found the right passage first 63% of the time versus 37%). Each
  model's vectors are stored separately, so switching never re-processes your notes.
- **Query rewriting:** Haiku rewrites the question into textbook-style search queries (adds ~3 s). Transcripts are
  down-weighted and capped unless you ask about the lectures, repeated boilerplate is dropped, and near-duplicates merge.
- **Claude can search again** with a `search_notes` tool when the automatic excerpts miss something.
- **Page images:** for cited PDF pages, the original page is rendered (cached) and attached, so the model reads formulas
  exactly instead of garbled extracted text.
- If nothing is relevant, no notes are added.

**Python (Claude):** a `run_python` tool with sympy/numpy/scipy, used to check calculations. On first use a private
environment is created with `uv` in the app's data folder. Each run is sandboxed (`sandbox-exec`): no network, no
file writes outside a temp folder, 20 s limit.
- Pick a course (or *All courses*) in the composer. The top passages go into the prompt. The tutor follows your course's
  definitions and notation, cites them as [1], [2], and shows clickable source chips.

Chats are saved as JSON in `~/Library/Application Support/Lemma/threads/`. Maths renders with KaTeX.

## Using it

| | |
|---|---|
| `⌘K` | Command menu (chats, model, mode, course, theme) |
| `⌘N` | New chat |
| `⌘L` | Library |
| `⌘\` | Toggle sidebar |
| `⌘⌥↑ / ↓` | Previous / next chat |
| `Esc` | Stop the reply |
| `⌘V` | Paste a screenshot of a problem |

**Effort (Claude):** a Low → Max thinking-effort slider in the composer.
**Usage (Claude):** hover "Claude · Pro" in the sidebar for your 5-hour and weekly plan usage.

**Modes:** *Explain* gives a full worked solution, *Hint* gives nudges only, and *Check* marks your working.

**Not yet supported:** scanned PDFs (need OCR first) and PowerPoint files.
