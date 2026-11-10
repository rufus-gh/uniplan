import { useEffect, useMemo, useState } from 'react'
import type { ClaudeUsage, Effort, ModelOption, Provider, ProviderStatus, TutorMode } from '../../../shared/types'
import { ALL_PROVIDERS, EFFORTS, MODES, PROVIDERS, mod } from '../lib'
import { Check, Copy, Gear, ProviderLogo, Refresh, Terminal, X } from './Icons'

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
          <div className="settings-title-group">
            <div className="settings-icon-badge">
              <Gear size={17} />
            </div>
            <div>
              <div className="settings-title">Settings</div>
              <div className="settings-subtitle">Manage AI providers, terminal authentication & model preferences</div>
            </div>
          </div>
          <div className="settings-head-actions">
            <span className="settings-active-pill">
              <span className="dot ok" />
              {activeCount} of {ALL_PROVIDERS.length} connected
            </span>
            <button className="icon-btn sm" onClick={p.onClose} title="Close  Esc">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="settings-nav">
          <button
            className={`settings-nav-btn ${tab === 'providers' ? 'active' : ''}`}
            onClick={() => setTab('providers')}
          >
            <Terminal size={14} />
            <span>AI Providers & Auth</span>
            <span className="badge-count">{activeCount}/{ALL_PROVIDERS.length}</span>
          </button>
          <button
            className={`settings-nav-btn ${tab === 'general' ? 'active' : ''}`}
            onClick={() => setTab('general')}
          >
            <Gear size={14} />
            <span>General Preferences</span>
          </button>
          <span className="spacer" />
          {tab === 'providers' && (
            <button
              className="btn sm"
              onClick={handleRecheck}
              disabled={checking}
              title="Re-check authentication status for all providers"
            >
              <Refresh size={12} className={checking ? 'spin' : ''} />
              {checking ? 'Checking…' : 'Check status'}
            </button>
          )}
        </div>

        <div className="settings-body">
          {tab === 'providers' && (
            <div className="providers-panel">
              <div className="providers-search-bar">
                <input
                  type="text"
                  placeholder="Filter providers (e.g. gemini, copilot, ollama, claude)…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="settings-search-input"
                />
              </div>

              <div className="providers-grid">
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
                    <div key={pr} className={`provider-card ${isOk ? 'connected' : 'disconnected'}`}>
                      <div className="provider-card-header">
                        <div className="provider-card-logo">
                          <ProviderLogo provider={pr} size={20} />
                        </div>
                        <div className="provider-card-titles">
                          <div className="provider-name-row">
                            <span className="provider-name">{info.name}</span>
                            <span className="provider-account">{info.account}</span>
                          </div>
                          <div className="provider-desc">{info.desc}</div>
                        </div>
                        <div className="provider-card-status">
                          {isOk ? (
                            <span className="status-pill connected">
                              <span className="dot ok" />
                              <span>{st?.plan || 'Connected'}</span>
                            </span>
                          ) : (
                            <span className="status-pill disconnected">
                              <span className="dot warn" />
                              <span>Not signed in</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {st?.detectedPath && (
                        <div className="provider-meta-row">
                          <span className="meta-label">Path:</span>
                          <code className="meta-code">{st.detectedPath}</code>
                        </div>
                      )}

                      {st?.error && !isOk && (
                        <div className="provider-error-note">
                          <span>{st.error}</span>
                        </div>
                      )}

                      {isClaude && isOk && p.claudeUsage && (
                        <div className="provider-usage-box">
                          <div className="usage-title-row">
                            <span className="usage-title">Claude Plan Limits</span>
                            <button className="link sm" onClick={p.onRefreshUsage}>
                              Refresh
                            </button>
                          </div>
                          {p.claudeUsage.session && (
                            <div className="usage-bar-row">
                              <span>Session: {Math.round(p.claudeUsage.session.percent)}%</span>
                              <div className="meter-track sm">
                                <div
                                  className="meter-fill sm"
                                  style={{ width: `${Math.min(100, p.claudeUsage.session.percent)}%` }}
                                />
                              </div>
                            </div>
                          )}
                          {p.claudeUsage.weekly && (
                            <div className="usage-bar-row">
                              <span>Weekly: {Math.round(p.claudeUsage.weekly.percent)}%</span>
                              <div className="meter-track sm">
                                <div
                                  className="meter-fill sm"
                                  style={{ width: `${Math.min(100, p.claudeUsage.weekly.percent)}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {isOllama && isOk && (
                        <div className="provider-usage-box">
                          <span className="usage-title">
                            {st?.modelCount ? `${st.modelCount} local models available` : 'Ollama daemon ready'}
                          </span>
                        </div>
                      )}

                      <div className="provider-auth-section">
                        <div className="auth-label-row">
                          <span className="auth-label">Terminal Auth Command</span>
                          <span className="auth-hint">Runs directly in macOS Terminal</span>
                        </div>
                        <div className="auth-command-bar">
                          <div className="auth-input-wrap">
                            <span className="auth-prompt-symbol">$</span>
                            <input
                              type="text"
                              className="auth-command-input"
                              value={currentCmd}
                              onChange={(e) => setCmd(pr, e.target.value)}
                              placeholder={info.defaultAuthCmd}
                              spellCheck={false}
                            />
                          </div>
                          <button
                            className="btn primary auth-action-btn"
                            onClick={() => handleRunTerminal(pr)}
                            disabled={isLaunching}
                            title="Run this command in Terminal to sign in"
                          >
                            <Terminal size={13} />
                            {isLaunching ? 'Opening…' : 'Run in Terminal'}
                          </button>
                          <button
                            className="icon-btn sm copy-btn"
                            onClick={() => handleCopy(pr)}
                            title="Copy command to clipboard"
                          >
                            {isCopied ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        </div>
                        {isLaunching && (
                          <div className="terminal-launched-tip">
                            Terminal launched! Complete authentication in your terminal, then press Check status.
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {tab === 'general' && (
            <div className="general-panel">
              <div className="pref-section">
                <div className="pref-title">Theme</div>
                <div className="pref-desc">Choose the application color appearance</div>
                <div className="pref-button-group">
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

              <div className="pref-section">
                <div className="pref-title">Default Model</div>
                <div className="pref-desc">Model used for new conversations</div>
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

              <div className="pref-section">
                <div className="pref-title">Default Tutor Mode</div>
                <div className="pref-desc">Pedagogical mode for explanations and practice</div>
                <div className="pref-button-group">
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

              <div className="pref-section">
                <div className="pref-title">Reasoning Effort</div>
                <div className="pref-desc">Thinking depth level for supported models</div>
                <div className="pref-button-group">
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

        <div className="settings-foot">
          <span className="settings-foot-hint">
            Tip: Press <kbd>{mod},</kbd> to open or close Settings anytime
          </span>
          <span className="spacer" />
          <button className="btn" onClick={p.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
