import { memo, useState } from 'react'
import type { ChatMessage, Provider, ProviderStatus, Source } from '../../../shared/types'
import { Markdown } from './Markdown'
import { Alert, Book, Check, Chevron, Copy, ProviderLogo, Retry, Terminal } from './Icons'
import { api, PROVIDERS } from '../lib'

export interface LiveReply {
  messageId: string
  text: string
  thinking: boolean
  sources?: Source[]
  /** e.g. "Searching your notes for “…”" */
  status?: string
}

/** Collapsed "N sources" pill; hovering (or focusing) it reveals the excerpts used. */
function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="sources" tabIndex={0}>
      <span className="sources-trigger">
        <Book size={12} />
        {sources.length} source{sources.length === 1 ? '' : 's'}
        <Chevron size={11} className="chev" />
      </span>
      <div className="sources-pop">
        <div className="sources-card" role="list">
          {sources.map((s) => (
            <button key={s.n} role="listitem" className="source" onClick={() => api.openFile(s.fileId)} title="Open file">
              <div className="source-head">
                <span className="n">{s.n}</span>
                <span className="name">{s.fileName}</span>
                {s.location && <span className="loc">{s.location}</span>}
              </div>
              <div className="source-excerpt">{s.excerpt}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="icon-btn sm"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

const UserMessage = memo(function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className="msg user">
      {m.images && m.images.length > 0 && (
        <div className="msg-images">
          {m.images.map((img, i) => (
            <img key={i} src={img.dataUrl} alt={img.name ?? 'attachment'} />
          ))}
        </div>
      )}
      {m.content && (
        <div className="bubble">
          {/* Keep the user's line breaks; render their maths. */}
          <Markdown source={m.content.replace(/\n/g, '  \n')} />
        </div>
      )}
    </div>
  )
})

const isAuthError = (e?: string) => !!e && /not logged in|please run \/login|log ?in again|credential|401|oauth|unauthori[sz]ed/i.test(e)

const AssistantMessage = memo(function AssistantMessage({
  m,
  isLast,
  onRetry
}: {
  m: ChatMessage
  isLast: boolean
  onRetry(): void
}) {
  const provider: Provider = m.provider ?? 'claude'
  return (
    <div className="msg assistant">
      {m.content && (
        <div className="assistant-body">
          <Markdown source={m.content} />
        </div>
      )}
      {m.error && (
        <div className="notice">
          <Alert className="ico" />
          <div className="body">
            {isAuthError(m.error)
              ? `${PROVIDERS[provider].account} isn’t signed in on this Mac. Sign in, then retry.`
              : m.error}
            {isLast && (
              <div className="actions">
                {isAuthError(m.error) && (
                  <button className="btn sm" onClick={() => api.openLogin(provider)}>
                    <Terminal size={14} /> Sign in
                  </button>
                )}
                <button className="btn sm" onClick={onRetry}>
                  <Retry size={14} /> Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {m.sources && m.content && <Sources sources={m.sources} />}
      {!m.error && (
        <div className={`msg-meta ${isLast ? 'show' : ''}`}>
          {m.content && <CopyButton text={m.content} />}
          {isLast && (
            <button className="icon-btn sm" title="Regenerate" onClick={onRetry}>
              <Retry size={13} />
            </button>
          )}
          {m.stopped && <span>Stopped</span>}
          {m.durationMs !== undefined && (
            <>
              {m.stopped && <span className="sep">·</span>}
              <span>{(m.durationMs / 1000).toFixed(1)}s</span>
            </>
          )}
          {m.model && (
            <>
              <span className="sep">·</span>
              <span className="meta-model">
                <ProviderLogo provider={provider} size={11} />
                {m.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
})

export function Messages({
  messages,
  live,
  onRetry
}: {
  messages: ChatMessage[]
  live: LiveReply | null
  onRetry(): void
}) {
  return (
    <div className="column">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} m={m} />
        ) : (
          <AssistantMessage key={m.id} m={m} isLast={!live && i === messages.length - 1} onRetry={onRetry} />
        )
      )}
      {live && (
        <div className="msg assistant">
          {live.sources && live.sources.length > 0 && !live.text && (
            <div className="searching">
              <Book size={13} /> Using {live.sources.length} excerpt{live.sources.length > 1 ? 's' : ''} from your notes
            </div>
          )}
          {live.text ? (
            <>
              <div className={`assistant-body ${live.status ? '' : 'caret'}`}>
                <Markdown source={live.text} />
              </div>
              {live.status && (
                <div className="thinking" style={{ marginTop: 10 }}>
                  <span className="shimmer">{live.status}</span>
                </div>
              )}
            </>
          ) : (
            <div className="thinking">
              <span className="shimmer">{live.status ?? (live.thinking ? 'Thinking…' : 'Working on it…')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function AuthCard({ status, onRecheck }: { status: ProviderStatus; onRecheck(): void }) {
  const [waiting, setWaiting] = useState(false)
  const claude = status.provider === 'claude'
  return (
    <div className="auth">
      <ProviderLogo provider={status.provider} size={24} />
      <h2>Connect your {PROVIDERS[status.provider].account} account</h2>
      {claude ? (
        <p>
          Claude models run through Claude Code on this Mac, so chats use your Claude subscription. No API key
          needed. Sign in once with <code>claude auth login</code>.
        </p>
      ) : (
        <p>
          OpenAI models run through Codex, using your ChatGPT account. No API key needed. Sign in once with your
          ChatGPT account (the same login as the Codex app).
        </p>
      )}
      {status.error && <p className="auth-err">{status.error}</p>}
      <div className="row">
        {status.canLogin && (
          <button
            className="btn primary"
            onClick={async () => {
              await api.openLogin(status.provider)
              setWaiting(true)
            }}
          >
            <Terminal size={14} /> Sign in with {PROVIDERS[status.provider].account}
          </button>
        )}
        <button className="btn" onClick={onRecheck}>
          {waiting ? 'I’ve signed in' : 'Check again'}
        </button>
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  { k: 'Linear algebra', v: 'Why is a matrix invertible iff its determinant is non-zero?', p: 'Why is a square matrix invertible if and only if its determinant is non-zero?' },
  { k: 'Analysis', v: 'Prove that √2 is irrational, step by step.', p: 'Prove that $\\sqrt{2}$ is irrational, step by step.' },
  { k: 'Calculus', v: 'Evaluate ∫₀^∞ e^(−x²) dx and explain the trick.', p: 'Evaluate $\\int_0^\\infty e^{-x^2}\\,dx$ and explain the trick.' },
  { k: 'Probability', v: 'Independence vs. zero covariance: what’s the difference?', p: 'Explain the difference between independence and zero covariance, with a counterexample.' }
]

export function Empty({ onPick }: { onPick(text: string): void }) {
  return (
    <div className="empty">
      <h1>What are we working on?</h1>
      <p>Ask about a problem, paste a screenshot, or pick a starting point.</p>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.k} className="suggestion" onClick={() => onPick(s.p)}>
            <span className="k">{s.k}</span>
            <span className="v">{s.v}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
