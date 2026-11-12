import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import type { Course, Effort, ImageAttachment, ModelOption, Provider, ProviderStatus, TutorMode } from '../../../shared/types'
import { ALL_PROVIDERS, EFFORTS, MODES, PROVIDERS, mod, plainTitle, providerOf, readImage } from '../lib'
import { ArrowUp, Book, Check, Chevron, EffortBars, ImageIcon, ProviderLogo, Square, X } from './Icons'

export interface ComposerHandle {
  focus(): void
  setText(t: string): void
}

interface Props {
  models: ModelOption[]
  statuses: ProviderStatus[]
  model: string
  mode: TutorMode
  effort: Effort
  courseId: string
  courses: Course[]
  streaming: boolean
  disabled: boolean
  /** Selected text being replied to. */
  quote: string | null
  onClearQuote(): void
  onModel(id: string): void
  onMode(m: TutorMode): void
  onEffort(e: Effort): void
  onCourse(id: string): void
  onLogin(p: Provider): void
  onOpenLibrary(): void
  onSend(text: string, images: ImageAttachment[]): void
  onStop(): void
}

/** A pill button that opens a popover menu above the composer. */
function Picker({ label, children, wide }: { label: ReactNode; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    // Close on a press outside the picker (not on 'click', which can be the opening click itself).
    const outside = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="menu-anchor" ref={anchor}>
      <button className={`pill ${open ? 'open' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
        <Chevron size={13} />
      </button>
      {open && <div className={`menu ${wide ? 'wide' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(p, ref) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [modelExpanded, setModelExpanded] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => {
        ta.current?.focus()
        ta.current?.setSelectionRange(t.length, t.length)
      })
    }
  }))

  useEffect(() => {
    if (p.quote) ta.current?.focus()
  }, [p.quote])

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`
  }, [text])

  async function addFiles(files: Iterable<File>) {
    const added: ImageAttachment[] = []
    for (const f of files) {
      const dataUrl = await readImage(f)
      if (dataUrl) added.push({ dataUrl, name: f.name })
    }
    if (added.length) setImages((prev) => [...prev, ...added].slice(0, 6))
  }

  const canSend = !p.disabled && !p.streaming && (text.trim().length > 0 || images.length > 0)

  function submit() {
    if (!canSend) return
    p.onSend(text.trim(), images)
    setText('')
    setImages([])
  }

  const current = p.models.find((m) => m.id === p.model)
  const provider = providerOf(p.model)
  const courseLabel = p.courseId === 'all' ? 'All courses' : (p.courses.find((c) => c.id === p.courseId)?.name ?? 'No notes')
  const status = (prov: Provider) => p.statuses.find((s) => s.provider === prov)

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
      >
        {p.quote && (
          <div className="quote-chip">
            <span className="quote-bar" />
            <span className="quote-text">{plainTitle(p.quote).slice(0, 220)}</span>
            <button className="icon-btn sm" title="Remove quote" onClick={p.onClearQuote}>
              <X size={12} />
            </button>
          </div>
        )}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <div className="attachment" key={i}>
                <img src={img.dataUrl} alt={img.name ?? 'attachment'} />
                <button title="Remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={
            p.mode === 'hint'
              ? 'Paste a problem — you’ll get a nudge, not the answer…'
              : p.mode === 'check'
                ? 'Paste the problem and your working…'
                : p.quote
                  ? 'Ask about the selected text…'
                  : 'Ask about a problem, or paste a screenshot of one…'
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape' && p.streaming) {
              p.onStop()
            }
          }}
        />
        <div className="composer-bar">
          <Picker
            wide
            label={
              <>
                <ProviderLogo provider={provider} size={13} />
                {current?.label ?? p.model.split(':').pop()}
              </>
            }
          >
            {(close) =>
              ALL_PROVIDERS.map((prov) => {
                const st = status(prov)
                const list = p.models.filter((m) => m.provider === prov)
                if (!list.length && !st?.canLogin) return null
                const visible = modelExpanded ? list : list.slice(0, 3)
                const hidden = list.length - visible.length
                return (
                  <div key={prov} className="menu-group">
                    <div className="menu-head">
                      <ProviderLogo provider={prov} size={12} />
                      <span className="grow">{PROVIDERS[prov].name}</span>
                      {st?.ok ? (
                        <span className="menu-plan">
                          {PROVIDERS[prov].account}
                          {st.plan ? ` · ${st.plan}` : ''}
                        </span>
                      ) : st?.canLogin ? (
                        <button
                          className="link"
                          onClick={() => {
                            close()
                            p.onLogin(prov)
                          }}
                        >
                          Sign in
                        </button>
                      ) : (
                        <span className="menu-plan">Unavailable</span>
                      )}
                    </div>
                    {visible.map((m) => (
                      <button
                        key={m.id}
                        className={`menu-item ${st && !st.ok ? 'dim' : ''}`}
                        onClick={() => {
                          p.onModel(m.id)
                          close()
                        }}
                      >
                        <ProviderLogo provider={prov} size={15} />
                        <span className="label">
                          {m.label}
                          {m.desc && <div className="desc">{m.desc}</div>}
                        </span>
                        {p.model === m.id && <Check className="check" />}
                      </button>
                    ))}
                    {hidden > 0 && (
                      <div className="menu-item-group">
                        {modelExpanded ? (
                          <button
                            className="menu-item more"
                            onClick={() => setModelExpanded(false)}
                            title={`Hide ${hidden} more models`}
                          >
                            Show less
                          </button>
                        ) : (
                          <button
                            className="menu-item more"
                            onClick={() => setModelExpanded(true)}
                            title={`Show ${hidden} more models`}
                          >
                            Show {hidden} more
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            }
          </Picker>

          {provider === 'claude' && (
            <button
              className="pill"
              title={`Thinking effort: ${EFFORTS.find((e) => e.id === p.effort)?.label}. ${EFFORTS.find((e) => e.id === p.effort)?.desc} Click to change.`}
              onClick={() => p.onEffort(EFFORTS[(EFFORTS.findIndex((e) => e.id === p.effort) + 1) % EFFORTS.length].id)}
            >
              <EffortBars level={EFFORTS.findIndex((e) => e.id === p.effort) + 1} />
              {EFFORTS.find((e) => e.id === p.effort)?.label}
            </button>
          )}

          <Picker label={MODES.find((m) => m.id === p.mode)?.label}>
            {(close) => (
              <>
                <div className="menu-head">
                  <span className="grow">Tutor mode</span>
                </div>
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className="menu-item"
                    onClick={() => {
                      p.onMode(m.id)
                      close()
                    }}
                  >
                    <span className="label">
                      {m.label}
                      <div className="desc">{m.desc}</div>
                    </span>
                    {p.mode === m.id && <Check className="check" />}
                  </button>
                ))}
              </>
            )}
          </Picker>

          {p.courses.length > 0 && (
          <Picker
            label={
              <>
                <Book size={14} />
                <span className="pill-text">{courseLabel}</span>
              </>
            }
          >
            {(close) => (
              <>
                <div className="menu-head">
                  <span className="grow">Course materials</span>
                </div>
                {[
                  { id: '', name: 'No notes', desc: 'Answer from general knowledge' },
                  ...(p.courses.length > 1 ? [{ id: 'all', name: 'All courses', desc: 'Search every course' }] : []),
                  ...p.courses.map((c) => ({ id: c.id, name: c.name, desc: '' }))
                ].map((c) => (
                  <button
                    key={c.id || 'none'}
                    className="menu-item"
                    onClick={() => {
                      p.onCourse(c.id)
                      close()
                    }}
                  >
                    <span className="label">
                      {c.name}
                      {c.desc && <div className="desc">{c.desc}</div>}
                    </span>
                    {p.courseId === c.id && <Check className="check" />}
                  </button>
                ))}
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    close()
                    p.onOpenLibrary()
                  }}
                >
                  <span className="label">{p.courses.length ? 'Manage library…' : 'Add lecture notes…'}</span>
                  <kbd>{mod}L</kbd>
                </button>
              </>
            )}
          </Picker>
          )}

          <span className="spacer" />
          <button className="icon-btn" title="Attach image" onClick={() => file.current?.click()}>
            <ImageIcon />
          </button>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          {p.streaming ? (
            <button className="send stop" title="Stop  Esc" onClick={p.onStop}>
              <Square size={14} />
            </button>
          ) : (
            <button className="send" title="Send  ↵" disabled={!canSend} onClick={submit}>
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
