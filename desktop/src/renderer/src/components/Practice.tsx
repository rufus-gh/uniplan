import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Effort,
  ImageAttachment,
  LibraryState,
  PracticeAttempt,
  PracticeLevel,
  PracticeStyle
} from '../../../shared/types'
import { api, errorText, readImage } from '../lib'
import { Markdown } from './Markdown'
import { Sources } from './Messages'
import { Book, ImageIcon, Plus, Trash, X } from './Icons'

interface Props {
  lib: LibraryState
  /** Current model + effort from the chat composer's defaults. */
  model: string
  effort: Effort
  onToast(text: string): void
  onOpenLibrary(): void
}

interface Settings {
  courseId: string
  topic: string
  style: PracticeStyle
  level: PracticeLevel
}

const STYLES: { id: PracticeStyle; label: string }[] = [
  { id: 'mixed', label: 'Mixed' },
  { id: 'computation', label: 'Computation' },
  { id: 'proof', label: 'Proof' }
]
const LEVELS: { id: PracticeLevel; label: string }[] = [
  { id: 'easier', label: 'Easier' },
  { id: 'standard', label: 'Exam level' },
  { id: 'harder', label: 'Harder' }
]

function loadSettings(): Settings {
  try {
    return { courseId: '', topic: '', style: 'mixed', level: 'standard', ...JSON.parse(localStorage.getItem('practice') ?? '{}') }
  } catch {
    return { courseId: '', topic: '', style: 'mixed', level: 'standard' }
  }
}

/** One-line label for the history list: the topic, else the question text with maths collapsed to "…". */
function snippet(a: PracticeAttempt) {
  const text = a.question
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '…')
    .replace(/(…\s*[,.;:]?\s*){2,}/g, '… ')
    .replace(/\s+/g, ' ')
    .trim()
  return (a.topic ? `${a.topic}: ` : '') + text.slice(0, 90)
}

function Verdict({ a }: { a: PracticeAttempt }) {
  if (a.status !== 'marked' || a.score === undefined) return null
  const frac = a.score / a.marks
  return (
    <div className={`verdict ${frac >= 0.8 ? 'good' : frac >= 0.5 ? 'mid' : 'low'}`}>
      <span className="verdict-score">
        {a.score}
        <span className="verdict-of">/{a.marks}</span>
      </span>
      <span className="verdict-label">{frac >= 0.8 ? 'Strong' : frac >= 0.5 ? 'Partly there' : 'Needs work'}</span>
    </div>
  )
}

export function Practice({ lib, model, effort, onToast, onOpenLibrary }: Props) {
  const [s, setS] = useState<Settings>(loadSettings)
  const [items, setItems] = useState<PracticeAttempt[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'generating' | 'marking'>(null)
  const [answer, setAnswer] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [showHint, setShowHint] = useState(false)

  const set = (patch: Partial<Settings>) =>
    setS((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem('practice', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })

  // A deleted or missing course falls back to the first one.
  useEffect(() => {
    if (lib.courses.length && !lib.courses.some((c) => c.id === s.courseId)) set({ courseId: lib.courses[0].id })
  }, [lib.courses, s.courseId])

  const refresh = useCallback(async () => {
    if (!s.courseId) return setItems([])
    setItems(await api.practiceList(s.courseId))
  }, [s.courseId])

  useEffect(() => {
    refresh().then(() => setCurrentId(null))
  }, [s.courseId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resume an unanswered question if there is one.
  const current = useMemo(
    () => items.find((a) => a.id === currentId) ?? (currentId === null ? items.find((a) => a.status === 'open') : undefined) ?? null,
    [items, currentId]
  )

  useEffect(() => {
    setAnswer('')
    setImages([])
    setShowHint(false)
  }, [current?.id])

  const stats = useMemo(() => {
    const done = items.filter((a) => a.status === 'marked' && a.score !== undefined)
    if (!done.length) return null
    const got = done.reduce((n, a) => n + (a.score ?? 0), 0)
    const out = done.reduce((n, a) => n + a.marks, 0)
    return { count: done.length, pct: Math.round((got / out) * 100) }
  }, [items])

  async function next() {
    setBusy('generating')
    try {
      const a = await api.practiceGenerate({ ...s, model, effort })
      setCurrentId(a.id)
      await refresh()
    } catch (e) {
      onToast(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function submit() {
    if (!current) return
    setBusy('marking')
    try {
      const a = await api.practiceMark({ id: current.id, answer, images, model, effort })
      setItems((prev) => prev.map((x) => (x.id === a.id ? a : x)))
    } catch (e) {
      onToast(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function reveal() {
    if (!current) return
    const a = await api.practiceReveal(current.id)
    setItems((prev) => prev.map((x) => (x.id === a.id ? a : x)))
  }

  async function addImages(files: Iterable<File>) {
    const added: ImageAttachment[] = []
    for (const f of files) {
      const dataUrl = await readImage(f)
      if (dataUrl) added.push({ dataUrl, name: f.name })
    }
    if (added.length) setImages((prev) => [...prev, ...added].slice(0, 4))
  }

  if (!lib.courses.length) {
    return (
      <div className="lib-empty">
        <Book size={22} />
        <h1>Practice</h1>
        <p>Add a course to the Library first. Lemma will write exam-style questions from your own notes, then mark your working.</p>
        <button className="btn primary" onClick={onOpenLibrary}>
          Open Library
        </button>
      </div>
    )
  }

  return (
    <div className="practice">
      <div className="practice-bar">
        <select className="pselect" value={s.courseId} onChange={(e) => set({ courseId: e.target.value })} aria-label="Course">
          {lib.courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className="topic"
          placeholder="Topic, e.g. line integrals, Prop 3.12 (blank = surprise me)"
          value={s.topic}
          onChange={(e) => set({ topic: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && !busy && next()}
        />
        <select className="pselect" value={s.style} onChange={(e) => set({ style: e.target.value as PracticeStyle })} aria-label="Type">
          {STYLES.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select className="pselect" value={s.level} onChange={(e) => set({ level: e.target.value as PracticeLevel })} aria-label="Level">
          {LEVELS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!!busy} onClick={next}>
          <Plus size={13} /> New question
        </button>
      </div>

      {stats && (
        <div className="practice-stats">
          {stats.count} marked · average {stats.pct}%
        </div>
      )}

      {busy === 'generating' && (
        <div className="practice-card">
          <div className="thinking">
            <span className="shimmer">Writing a question from your notes…</span>
          </div>
        </div>
      )}

      {!busy && !current && (
        <div className="practice-empty">
          <h2>Ready when you are</h2>
          <p>Pick a topic (or leave it blank) and press New question. Lemma writes an exam-style question from your notes and lecture clips, then marks your answer.</p>
        </div>
      )}

      {current && busy !== 'generating' && (
        <div className="practice-card">
          <div className="practice-qhead">
            <span className="marks-badge">{current.marks} marks</span>
            {current.topic && <span className="practice-topic">{current.topic}</span>}
            <span className="spacer" />
            {current.status === 'marked' && <Verdict a={current} />}
          </div>
          <div className="practice-question assistant-body">
            <Markdown source={current.question} />
          </div>
          {current.sources.length > 0 && <Sources sources={current.sources} />}

          {current.status === 'open' && (
            <>
              {showHint && current.hint && (
                <div className="practice-hint">
                  <Markdown source={`**Hint:** ${current.hint}`} />
                </div>
              )}
              <div className="practice-answer">
                {images.length > 0 && (
                  <div className="attachments" style={{ padding: '10px 12px 0' }}>
                    {images.map((img, i) => (
                      <div className="attachment" key={i}>
                        <img src={img.dataUrl} alt={img.name ?? 'working'} />
                        <button title="Remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  placeholder="Write your working here. LaTeX is fine. Paste a photo of handwritten work with ⌘V."
                  value={answer}
                  rows={7}
                  onChange={(e) => setAnswer(e.target.value)}
                  onPaste={(e) => {
                    const files = [...e.clipboardData.files]
                    if (files.length) {
                      e.preventDefault()
                      addImages(files)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) submit()
                  }}
                />
                <div className="practice-actions">
                  {current.hint && !showHint && (
                    <button className="btn sm" onClick={() => setShowHint(true)}>
                      Hint
                    </button>
                  )}
                  <button className="btn sm" onClick={reveal} disabled={!!busy}>
                    Show solution
                  </button>
                  <span className="spacer" />
                  <label className="icon-btn" title="Attach a photo of your working">
                    <ImageIcon />
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => e.target.files && addImages(e.target.files)} />
                  </label>
                  <button className="btn primary" disabled={!!busy || (!answer.trim() && !images.length)} onClick={submit}>
                    {busy === 'marking' ? 'Marking…' : 'Mark my answer'} <kbd className="inline-kbd">⌘↵</kbd>
                  </button>
                </div>
              </div>
            </>
          )}

          {current.status === 'marked' && (
            <>
              {current.answer && (
                <details className="practice-yours">
                  <summary>Your answer{current.hadImages ? ' (+ photo)' : ''}</summary>
                  <div className="assistant-body">
                    <Markdown source={current.answer} />
                  </div>
                </details>
              )}
              <div className="practice-feedback assistant-body">
                <Markdown source={current.feedback ?? ''} />
              </div>
            </>
          )}

          {current.status !== 'open' && current.solution && (
            <details className="practice-solution" open={current.status === 'revealed'}>
              <summary>Model solution</summary>
              <div className="assistant-body">
                <Markdown source={current.solution} />
              </div>
              {current.markscheme && (
                <div className="practice-scheme">
                  <div className="practice-scheme-title">Mark scheme</div>
                  <div className="assistant-body">
                    <Markdown source={current.markscheme} />
                  </div>
                </div>
              )}
            </details>
          )}

          {current.status !== 'open' && (
            <div className="practice-actions">
              <span className="spacer" />
              <button className="btn primary" disabled={!!busy} onClick={next}>
                <Plus size={13} /> Next question
              </button>
            </div>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="practice-history">
          <div className="lib-label">Previous questions</div>
          {items.slice(0, 15).map((a) => (
            <div key={a.id} className={`phist ${a.id === current?.id ? 'active' : ''}`}>
              <button className="phist-main" onClick={() => setCurrentId(a.id)}>
                <span className="phist-q">{snippet(a)}</span>
                <span className={`phist-score ${a.status}`}>
                  {a.status === 'marked' ? `${a.score}/${a.marks}` : a.status === 'revealed' ? 'solution viewed' : 'unanswered'}
                </span>
              </button>
              <button
                className="icon-btn sm del"
                title="Delete"
                onClick={async () => {
                  await api.practiceDelete(a.id)
                  if (a.id === current?.id) setCurrentId(null)
                  refresh()
                }}
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
