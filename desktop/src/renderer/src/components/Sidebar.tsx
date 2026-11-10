import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeUsage, ProviderStatus, ThreadSummary, UsageWindow } from '../../../shared/types'
import { api, fmtReset, groupThreads, mod, plainTitle, PROVIDERS } from '../lib'
import { Book, Gear, LemmaMark, Plus, ProviderLogo, Refresh, Search, Sidebar as SidebarIcon, Target, Trash } from './Icons'

interface Props {
  threads: ThreadSummary[]
  activeId: string | null
  streaming: Set<string>
  collapsed: boolean
  statuses: ProviderStatus[] | null
  libraryOpen: boolean
  practiceOpen: boolean
  onPractice(): void
  fileCount: number
  onLibrary(): void
  onLogin(p: ProviderStatus['provider']): void
  onSelect(id: string): void
  onNew(): void
  onDelete(id: string): void
  onToggle(): void
  onPalette(): void
  onSettings(): void
}

function Meter({ label, w }: { label: string; w: UsageWindow }) {
  const pct = Math.min(100, Math.max(0, Math.round(w.percent)))
  return (
    <div className="meter">
      <div className="meter-row">
        <span>{label}</span>
        <span className="meter-pct">{pct}% used</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${pct >= 95 ? 'crit' : pct >= 80 ? 'high' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {w.resetsAt && <div className="meter-reset">Resets {fmtReset(w.resetsAt)}</div>}
    </div>
  )
}

/** Plan usage for Claude, shown when hovering the Claude account row. */
function UsageCard({ usage, loading, onRefresh }: { usage: ClaudeUsage | null; loading: boolean; onRefresh(): void }) {
  const ago = usage ? Math.round((Date.now() - usage.fetchedAt) / 60000) : 0
  return (
    <div className="usage-pop">
      <div className="usage-card">
        <div className="usage-head">
          <ProviderLogo provider="claude" size={14} />
          <span className="grow">Claude {usage?.plan ?? ''} usage</span>
          <button className="icon-btn sm" title="Refresh" onClick={onRefresh}>
            <Refresh size={13} className={loading ? 'spin' : ''} />
          </button>
        </div>
        {!usage && <div className="usage-note">Loading…</div>}
        {usage?.error && <div className="usage-note">{usage.error}</div>}
        {usage?.session && <Meter label="Current session" w={usage.session} />}
        {usage?.weekly && <Meter label="Weekly · all models" w={usage.weekly} />}
        {usage?.weeklyOpus && <Meter label="Weekly · Opus" w={usage.weeklyOpus} />}
        {usage?.weeklySonnet && <Meter label="Weekly · Sonnet" w={usage.weeklySonnet} />}
        {usage?.breakdown && usage.breakdown.length > 0 && (
          <div className="usage-note">
            This week: {usage.breakdown.map((b) => `${b.name} ${b.percent}%`).join(' · ')}
          </div>
        )}
        {usage && !usage.error && <div className="usage-foot">Updated {ago < 1 ? 'just now' : `${ago} min ago`}</div>}
      </div>
    </div>
  )
}

export function Sidebar(p: Props) {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const loadUsage = useCallback(async (force = false) => {
    setUsageLoading(true)
    try {
      setUsage(await api.claudeUsage(force))
    } finally {
      setUsageLoading(false)
    }
  }, [])

  // Keep the usage figure in the sidebar current without needing a hover:
  // on load (once Claude is signed in), every 5 minutes, and after each reply finishes.
  const claudeOk = !!p.statuses?.find((s) => s.provider === 'claude')?.ok
  const replying = p.streaming.size > 0
  useEffect(() => {
    if (!claudeOk) return
    loadUsage()
    const t = setInterval(() => loadUsage(), 5 * 60_000)
    return () => clearInterval(t)
  }, [claudeOk, loadUsage])
  const wasReplying = useRef(false)
  useEffect(() => {
    if (claudeOk && wasReplying.current && !replying) loadUsage(true)
    wasReplying.current = replying
  }, [replying, claudeOk, loadUsage])

  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? p.threads.filter((t) => t.title.toLowerCase().includes(needle) || t.preview.toLowerCase().includes(needle))
      : p.threads
    return groupThreads(list)
  }, [p.threads, q])

  return (
    <aside className={`sidebar ${p.collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-top drag">
        <div className="brand">
          <LemmaMark size={18} />
          Lemma
        </div>
        <button className="icon-btn no-drag" title={`Hide sidebar  ${mod}\\`} onClick={p.onToggle}>
          <SidebarIcon />
        </button>
      </div>

      <div className="sidebar-actions">
        <button className="nav-item" onClick={p.onNew}>
          <Plus />
          <span className="grow">New chat</span>
          <span className="nav-end">
            <kbd>{mod}N</kbd>
          </span>
        </button>
        <button className={`nav-item ${p.libraryOpen ? 'active' : ''}`} onClick={p.onLibrary}>
          <Book />
          <span className="grow">Library</span>
          <span className="nav-end">
            {p.fileCount > 0 && <span className="count">{p.fileCount}</span>}
            <kbd>{mod}L</kbd>
          </span>
        </button>
        <button className={`nav-item ${p.practiceOpen ? 'active' : ''}`} onClick={p.onPractice}>
          <Target />
          <span className="grow">Practice</span>
          <span className="nav-end">
            <kbd>{mod}P</kbd>
          </span>
        </button>
        <label className="search">
          <Search />
          <input
            placeholder="Search chats"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          />
          {!q && (
            <span className="nav-end">
              <kbd role="button" onClick={p.onPalette}>
                {mod}K
              </kbd>
            </span>
          )}
        </label>
      </div>

      <nav className="threads">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="group-label">{g.label}</div>
            {g.items.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                className={`thread ${t.id === p.activeId && !p.libraryOpen && !p.practiceOpen ? 'active' : ''}`}
                onClick={() => p.onSelect(t.id)}
                onKeyDown={(e) => e.key === 'Enter' && p.onSelect(t.id)}
                title={plainTitle(t.title)}
              >
                <span className="t">{plainTitle(t.title)}</span>
                {p.streaming.has(t.id) && <span className="live" />}
                <button
                  className="icon-btn sm del"
                  title="Delete chat"
                  onClick={(e) => {
                    e.stopPropagation()
                    p.onDelete(t.id)
                  }}
                >
                  <Trash size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="group-label" style={{ paddingTop: 18 }}>
            {q ? 'No matching chats' : 'No chats yet'}
          </div>
        )}
      </nav>

      <div className="sidebar-foot">
        <button
          className="nav-item settings-item"
          onClick={p.onSettings}
          title={`Settings & AI Providers  ${mod},`}
        >
          <Gear size={15} />
          <span className="grow">Settings</span>
          <span className="nav-end">
            {(p.statuses?.filter((s) => s.ok).length ?? 0) > 0 ? (
              <span className="count ok">{p.statuses?.filter((s) => s.ok).length} active</span>
            ) : (
              p.statuses && <span className="count warn">0 active</span>
            )}
            <kbd>{mod},</kbd>
          </span>
        </button>
      </div>
    </aside>
  )
}
