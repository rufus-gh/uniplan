import { useEffect, useState } from 'react'
import type { AppSettings, EmbedderKind, LibraryState } from '../../../shared/types'
import { api } from '../lib'

/** Where the semantic-search model for course notes is chosen. */
const OPTIONS: { kind: EmbedderKind; title: string; blurb: string; tags: string[] }[] = [
  {
    kind: 'local',
    title: 'On this Mac',
    blurb: 'bge-small. Private and works offline; a small one-time download.',
    tags: ['Offline', 'Private', 'Good']
  },
  {
    kind: 'qwen',
    title: 'Qwen3 8B · Hack Club AI',
    blurb: 'Much better at finding the right passage, especially in your notes. Needs internet and a Hack Club AI key.',
    tags: ['Online', 'Most accurate']
  }
]

function status(lib: LibraryState): { text: string; tone: 'ok' | 'warn' | '' } {
  const qwen = lib.embedderKind === 'qwen'
  if (lib.embedder === 'unavailable') return { text: lib.embedError ?? 'Not available. Search is keyword-only for now.', tone: 'warn' }
  if (lib.embedder === 'loading') return { text: 'Loading the search model…', tone: '' }
  if (lib.embedder === 'idle') return { text: 'Starting…', tone: '' }
  if (qwen && lib.embedError) return { text: `${lib.embedError} Using keyword search and retrying.`, tone: 'warn' }
  if (lib.embedPending > 0) {
    return { text: `Indexing your notes… ${lib.embedPending.toLocaleString()} passages left. Search is keyword-only until it finishes.`, tone: '' }
  }
  return { text: 'Ready. All your notes are indexed.', tone: 'ok' }
}

export function SettingsModal({ lib, onClose }: { lib: LibraryState; onClose(): void }) {
  const [s, setS] = useState<AppSettings | null>(null)
  const [key, setKey] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getSettings().then(setS)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const selected = lib.embedderKind
  const needsKey = !!s && !s.hasKey
  const showKeyField = editingKey || needsKey

  async function choose(kind: EmbedderKind) {
    setResult(null)
    if (kind === selected) return
    if (kind === 'qwen' && needsKey) {
      setEditingKey(true) // nothing to switch to until there's a key
      return
    }
    setBusy(true)
    try {
      setS(await api.setEmbedder(kind))
    } finally {
      setBusy(false)
    }
  }

  async function saveKey() {
    setBusy(true)
    setResult(null)
    try {
      const r = await api.saveApiKey(key)
      setS(r.settings)
      if (!r.ok) {
        setResult({ ok: false, text: r.error ?? 'That key didn’t work.' })
        return
      }
      setKey('')
      setEditingKey(false)
      setResult({ ok: true, text: key.trim() ? `Connected${r.ms ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}.` : 'Key removed.' })
      // A working key means they want Qwen.
      if (key.trim() && selected !== 'qwen') setS(await api.setEmbedder('qwen'))
    } finally {
      setBusy(false)
    }
  }

  const st = status(lib)

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" title="Close  Esc" onClick={onClose}>
            ✕
          </button>
        </header>

        <section className="settings-sec">
          <h3>Notes search</h3>
          <p className="settings-sub">Which model reads your course notes to find the passages relevant to a question.</p>

          <div className="opts" role="radiogroup" aria-label="Notes search model">
            {OPTIONS.map((o) => (
              <button
                key={o.kind}
                role="radio"
                aria-checked={selected === o.kind}
                className={`opt ${selected === o.kind ? 'on' : ''}`}
                disabled={busy}
                onClick={() => choose(o.kind)}
              >
                <span className="radio" />
                <span className="opt-body">
                  <span className="opt-title">{o.title}</span>
                  <span className="opt-blurb">{o.blurb}</span>
                  <span className="opt-tags">
                    {o.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {(selected === 'qwen' || showKeyField) && (
            <div className="keybox">
              <div className="keybox-head">
                <span>Hack Club AI key</span>
                {s?.hasKey && !editingKey && (
                  <span className="keybox-state">
                    <span className="dot ok" /> Saved{s.keySecure ? ' (encrypted)' : ' for this session only'}
                  </span>
                )}
              </div>
              {showKeyField ? (
                <form
                  className="keybox-row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (key.trim()) void saveKey()
                  }}
                >
                  <input
                    type="password"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-hc-v1-…"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <button className="btn primary" type="submit" disabled={busy || !key.trim()}>
                    {busy ? 'Checking…' : 'Save & test'}
                  </button>
                  {s?.hasKey && (
                    <button className="btn" type="button" disabled={busy} onClick={() => (setEditingKey(false), setKey(''))}>
                      Cancel
                    </button>
                  )}
                </form>
              ) : (
                <div className="keybox-row">
                  <button className="btn" onClick={() => setEditingKey(true)}>
                    Replace key
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        const r = await api.saveApiKey('')
                        setS(r.settings)
                        setResult({ ok: true, text: 'Key removed.' })
                        if (selected === 'qwen') setS(await api.setEmbedder('local'))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
              {result && <div className={`keybox-msg ${result.ok ? 'ok' : 'bad'}`}>{result.text}</div>}
              <p className="settings-fine">
                Get a key at ai.hackclub.com. With Qwen selected, the text of your notes is sent to Hack Club AI and the
                model provider to be indexed, and so is each question you ask. Choose “On this Mac” to keep everything
                local. Each model’s index is kept, so switching back never re-processes your notes.
              </p>
            </div>
          )}

          <div className={`settings-status ${st.tone}`}>
            <span className={`dot ${st.tone}`} />
            {st.text}
          </div>
        </section>
      </div>
    </div>
  )
}
