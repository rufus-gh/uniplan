import { useEffect, useMemo, useState } from 'react'
import type { ClaudeUsage, Effort, ModelOption, Provider, ProviderStatus, TutorMode } from '../../../shared/types'
import { ALL_PROVIDERS, EFFORTS, MODES, PROVIDERS } from '../lib'
import { Check, Copy, Gear, ProviderLogo, Refresh, Search, Terminal, X } from './Icons'

interface Props {
  open: boolean
  onClose(): void
  statuses: ProviderStatus[] | null
  models: ModelOption[]
  defaults: {
    model: string
    mode: TutorMode
    courseId: string
    effort: Effort
  }
  onUpdateDefaults(patch: Partial<{ model: string; mode: TutorMode; courseId: string; effort: Effort }>): void
  theme: 'system' | 'dark' | 'light'
  onTheme(t: 'system' | 'dark' | 'light'): void
  onLogin(p: Provider, customCmd?: string): Promise<void>
  onRecheckAuth(): Promise<void>
  claudeUsage: ClaudeUsage | null
  onRefreshUsage(): void
}

export function SettingsModal(p: Props) {
  const [tab, setTab] = useState<'providers' | 'general'>('providers')
  const [filter, setFilter] = useState('')
  const [authCommands, setAuthCommands] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [launching, setLaunching] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  // Close on Escape key
  useEffect(() => {
    if (!p.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p.open, p.onClose])

  const statusMap = useMemo(() => {
    const map = new Map<Provider, ProviderStatus>()
    for (const s of p.statuses ?? []) map.set(s.provider, s)
    return map
  }, [p.statuses])

  const activeCount = useMemo(() => {
    return ALL_PROVIDERS.filter((pr) => statusMap.get(pr)?.ok).length
  }, [statusMap])

  if (!p.open) return null

  const getCmd = (provider: Provider) => {
    if (authCommands[provider] !== undefined) return authCommands[provider]
    return statusMap.get(provider)?.authCommand ?? PROVIDERS[provider].defaultAuthCmd
  }

  const setCmd = (provider: Provider, val: string) => {
    setAuthCommands((prev) => ({ ...prev, [provider]: val }))
  }

  const handleRunTerminal = async (provider: Provider) => {
    const cmd = getCmd(provider)
    setLaunching(provider)
    try {
      await p.onLogin(provider, cmd)
    } finally {
      setTimeout(() => setLaunching(null), 2500)
    }
  }

  const handleCopy = (provider: Provider) => {
    const cmd = getCmd(provider)
    navigator.clipboard.writeText(cmd)
    setCopied(provider)
    setTimeout(() => setCopied(null), 1500)
  }

  const handleRecheck = async () => {
    setChecking(true)
    try {
      await p.onRecheckAuth()
    } finally {
      setChecking(false)
    }
  }

  const filteredProviders = ALL_PROVIDERS.filter((pr) => {
    if (!filter.trim()) return true
    const q = filter.toLowerCase()
    const info = PROVIDERS[pr]
    return (
      info.name.toLowerCase().includes(q) ||
      info.account.toLowerCase().includes(q) ||
      info.desc.toLowerCase().includes(q) ||
      pr.toLowerCase().includes(q)
    )
  })

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <div className="settings-head-left">
            <Gear size={14} />
            <span className="settings-title">Settings</span>
            <span className="settings-count" title={`${activeCount} of ${ALL_PROVIDERS.length} providers connected`}>
              {activeCount}/{ALL_PROVIDERS.length}
            </span>
          </div>
          <div className="settings-head-right">
            {tab === 'providers' && (
              <button
                className="ghost-btn"
                onClick={handleRecheck}
                disabled={checking}
                title="Re-check authentication status for all providers"
              >
                <Refresh size={12} className={checking ? 'spin' : ''} />
                {checking ? 'Checking…' : 'Check status'}
              </button>
            )}
            <button className="icon-btn sm" onClick={p.onClose} title="Close  Esc">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="settings-nav">
          <div className="seg" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'providers'}
              className={`seg-btn ${tab === 'providers' ? 'active' : ''}`}
              onClick={() => setTab('providers')}
            >
              <Terminal size={13} />
              Providers
            </button>
            <button
              role="tab"
              aria-selected={tab === 'general'}
              className={`seg-btn ${tab === 'general' ? 'active' : ''}`}
              onClick={() => setTab('general')}
            >
              <Gear size={13} />
              General
            </button>
          </div>
        </div>

        <div className="settings-body">
          {tab === 'providers' && (
            <div className="providers-panel">
              <div className="providers-search">
                <Search size={13} />
                <input
                  type="text"
                  placeholder="Filter providers…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="settings-search-input"
                  spellCheck={false}
                />
                {filter && (
                  <button className="icon-btn xs" onClick={() => setFilter('')} title="Clear filter">
                    <X size={12} />
                  </button>
                )}
              </div>

              <div className="providers-list">
                {filteredProviders.map((pr) => {
                  const info = PROVIDERS[pr]
                  const st = statusMap.get(pr)
                  const isOk = !!st?.ok
                  const currentCmd = getCmd(pr)
                  const isLaunching = launching === pr
                  const isCopied = copied === pr
                  const isClaude = pr === 'claude'
                  const isOllama = pr === 'ollama'

                  return (
                    <div key={pr} className="provider-row">
                      <div className="provider-row-head">
                        <div className="provider-logo">
                          <ProviderLogo provider={pr} size={15} />
                        </div>
                        <div className="provider-info">
                          <div className="provider-name-row">
                            <span className="provider-name">{info.name}</span>
                            <span className="provider-account">{info.account}</span>
                          </div>
                          <div className="provider-desc" title={info.desc}>{info.desc}</div>
                        </div>
                        {isOk ? (
                          <span className="provider-status ok">
                            <span className="pdot" />
                            {st?.plan || 'Connected'}
                          </span>
                        ) : (
                          <span className="provider-status">
                            <span className="pdot" />
                            Not signed in
                          </span>
                        )}
                      </div>

                      {st?.detectedPath && (
                        <div className="provider-meta-row">
                          <span className="meta-label">Path</span>
                          <code className="meta-code">{st.detectedPath}</code>
                        </div>
                      )}

                      {st?.error && !isOk && (
                        <div className="provider-error-note">{st.error}</div>
                      )}

                      {isClaude && isOk && p.claudeUsage && (
                        <div className="provider-usage">
                          <div className="usage-head">
                            <span className="usage-title">Claude plan limits</span>
                            <button className="link-mini" onClick={p.onRefreshUsage}>Refresh</button>
                          </div>
                          {p.claudeUsage.session && (
                            <div className="usage-meter">
                              <span className="usage-meter-label">Session · {Math.round(p.claudeUsage.session.percent)}%</span>
                              <div className="meter-track xs">
                                <div
                                  className="meter-fill xs"
                                  style={{ width: `${Math.min(100, p.claudeUsage.session.percent)}%` }}
                                />
                              </div>
                            </div>
                          )}
                          {p.claudeUsage.weekly && (
                            <div className="usage-meter">
                              <span className="usage-meter-label">Weekly · {Math.round(p.claudeUsage.weekly.percent)}%</span>
                              <div className="meter-track xs">
                                <div
                                  className="meter-fill xs"
                                  style={{ width: `${Math.min(100, p.claudeUsage.weekly.percent)}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {isOllama && isOk && (
                        <div className="provider-meta-row">
                          <span className="meta-label">Local</span>
                          <span className="meta-text">
                            {st?.modelCount ? `${st.modelCount} models available` : 'Ollama daemon ready'}
                          </span>
                        </div>
                      )}

                      <div className="provider-auth">
                        <div className="auth-field">
                          <span className="auth-prompt">$</span>
                          <input
                            type="text"
                            className="auth-input"
                            value={currentCmd}
                            onChange={(e) => setCmd(pr, e.target.value)}
                            placeholder={info.defaultAuthCmd}
                            spellCheck={false}
                            aria-label={`Auth command for ${info.name}`}
                          />
                        </div>
                        <button
                          className="btn primary sm auth-run"
                          onClick={() => handleRunTerminal(pr)}
                          disabled={isLaunching}
                          title="Run this command in Terminal to sign in"
                        >
                          <Terminal size={12} />
                          {isLaunching ? 'Opening…' : 'Run'}
                        </button>
                        <button
                          className="icon-btn sm"
                          onClick={() => handleCopy(pr)}
                          title="Copy command"
                        >
                          {isCopied ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                      </div>
                      {isLaunching && (
                        <div className="terminal-tip">
                          Terminal opened — finish signing in there, then Check status.
                        </div>
                      )}
                    </div>
                  )
                })}
                {filteredProviders.length === 0 && (
                  <div className="providers-empty">No providers match “{filter}”.</div>
                )}
              </div>
            </div>
          )}

          {tab === 'general' && (
            <div className="general-panel">
              <div className="pref-row">
                <div className="pref-text">
                  <div className="pref-title">Theme</div>
                  <div className="pref-desc">Application color appearance</div>
                </div>
                <div className="pref-group">
                  {(['system', 'dark', 'light'] as const).map((t) => (
                    <button
                      key={t}
                      className={`pref-btn ${p.theme === t ? 'active' : ''}`}
                      onClick={() => p.onTheme(t)}
                    >
                      {t[0].toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pref-row">
                <div className="pref-text">
                  <div className="pref-title">Default Model</div>
                  <div className="pref-desc">Model for new conversations</div>
                </div>
                <select
                  className="pref-select"
                  value={p.defaults.model}
                  onChange={(e) => p.onUpdateDefaults({ model: e.target.value })}
                >
                  {p.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} ({PROVIDERS[m.provider]?.name})
                    </option>
                  ))}
                </select>
              </div>

              <div className="pref-row">
                <div className="pref-text">
                  <div className="pref-title">Tutor Mode</div>
                  <div className="pref-desc">Explanation style for new sessions</div>
                </div>
                <div className="pref-group">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      className={`pref-btn ${p.defaults.mode === m.id ? 'active' : ''}`}
                      onClick={() => p.onUpdateDefaults({ mode: m.id })}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pref-row">
                <div className="pref-text">
                  <div className="pref-title">Reasoning Effort</div>
                  <div className="pref-desc">Thinking depth for supported models</div>
                </div>
                <div className="pref-group">
                  {EFFORTS.map((e) => (
                    <button
                      key={e.id}
                      className={`pref-btn ${p.defaults.effort === e.id ? 'active' : ''}`}
                      onClick={() => p.onUpdateDefaults({ effort: e.id })}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
