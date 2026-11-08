import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  Effort,
  ImageAttachment,
  LibraryState,
  ModelOption,
  Provider,
  ProviderStatus,
  Thread,
  ThreadSummary,
  TutorMode
} from '../../shared/types'
import { api, errorText, MODES, mod, providerOf } from './lib'
import { Sidebar } from './components/Sidebar'
import { Composer, type ComposerHandle } from './components/Composer'
import { AuthCard, Empty, Messages, type LiveReply } from './components/Messages'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Library } from './components/Library'
import { Book, Bolt, Chat, Pencil, Plus, ProviderLogo, Sidebar as SidebarIcon, Sun, Terminal, Trash } from './components/Icons'

type ThemePref = 'system' | 'dark' | 'light'
interface Defaults {
  model: string
  mode: TutorMode
  courseId: string
  effort: Effort
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? { ...fallback, ...(JSON.parse(v) as T) } : fallback
  } catch {
    return fallback
  }
}
function loadScalar<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

const LEGACY: Record<string, string> = { opus: 'claude:claude-opus-5-5', sonnet: 'claude:claude-sonnet-5-5', haiku: 'claude:claude-haiku-5-5' }

export function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [thread, setThread] = useState<Thread | null>(null)
  const [live, setLive] = useState<Record<string, LiveReply>>({})
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [lib, setLib] = useState<LibraryState>({ courses: [], files: [], embedder: 'idle' })
  const [view, setView] = useState<'chat' | 'library'>('chat')
  const [libCourse, setLibCourse] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [collapsed, setCollapsed] = useState(() => loadScalar('sidebarCollapsed', false))
  const [theme, setTheme] = useState<ThemePref>(() => loadScalar('theme', 'system'))
  const [defaults, setDefaults] = useState<Defaults>(() => {
    const d = load<Defaults>('defaults', { model: 'claude:claude-opus-5-5', mode: 'explain', courseId: '', effort: 'medium' })
    return { ...d, model: LEGACY[d.model] ?? d.model }
  })
  const [renaming, setRenaming] = useState(false)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)

  const composer = useRef<ComposerHandle>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pendingDelete = useRef<{ id: string; timer: number } | null>(null)
  const threadRef = useRef(thread)
  threadRef.current = thread

  // ------------------------------------------------------------ data
  const refreshList = useCallback(async () => {
    const list = await api.listThreads()
    setThreads(list.filter((t) => t.id !== pendingDelete.current?.id))
  }, [])

  const checkAuth = useCallback(async () => {
    const [s, m] = await Promise.all([api.authStatus(), api.listModels()])
    setStatuses(s)
    setModels(m)
  }, [])

  useEffect(() => {
    refreshList()
    checkAuth()
    api.library().then(setLib)
    return api.onLibrary(setLib)
  }, [refreshList, checkAuth])

  // Re-check sign-in when the window regains focus (e.g. back from Terminal).
  useEffect(() => {
    const onFocus = () => {
      if (!statuses || statuses.some((s) => !s.ok)) checkAuth()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [statuses, checkAuth])

  // A course that was deleted can't stay selected.
  useEffect(() => {
    const valid = (id: string) => !id || id === 'all' || lib.courses.some((c) => c.id === id)
    if (!valid(defaults.courseId)) setDefaults((d) => ({ ...d, courseId: '' }))
  }, [lib.courses, defaults.courseId])

  // ------------------------------------------------------------ theme & prefs
  useEffect(() => {
    save('theme', theme)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      (document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => save('sidebarCollapsed', collapsed), [collapsed])
  useEffect(() => save('defaults', defaults), [defaults])

  // ------------------------------------------------------------ streaming events
  useEffect(() => {
    const buf = new Map<string, string>()
    let raf = 0
    const flush = () => {
      raf = 0
      setLive((prev) => {
        const next = { ...prev }
        for (const [tid, text] of buf) {
          const cur = next[tid] ?? { messageId: '', text: '', thinking: false }
          next[tid] = { ...cur, text: cur.text + text, status: undefined }
        }
        buf.clear()
        return next
      })
    }
    return api.onChatEvent(async (e) => {
      if (e.type === 'title') {
        setThreads((ts) => ts.map((t) => (t.id === e.threadId ? { ...t, title: e.title } : t)))
        setThread((t) => (t?.id === e.threadId ? { ...t, title: e.title } : t))
      } else if (e.type === 'start') {
        setLive((l) => ({ ...l, [e.threadId]: { messageId: e.messageId, text: '', thinking: false, sources: e.sources } }))
      } else if (e.type === 'delta') {
        buf.set(e.threadId, (buf.get(e.threadId) ?? '') + e.text)
        if (!raf) raf = requestAnimationFrame(flush)
      } else if (e.type === 'sources') {
        setLive((l) => (l[e.threadId] ? { ...l, [e.threadId]: { ...l[e.threadId], sources: e.sources } } : l))
      } else if (e.type === 'status') {
        setLive((l) => (l[e.threadId] ? { ...l, [e.threadId]: { ...l[e.threadId], status: e.text } } : l))
      } else if (e.type === 'thinking') {
        setLive((l) => (l[e.threadId] && !l[e.threadId].thinking ? { ...l, [e.threadId]: { ...l[e.threadId], thinking: true } } : l))
      } else if (e.type === 'done' || e.type === 'error') {
        if (raf) {
          cancelAnimationFrame(raf)
          flush()
        }
        if (threadRef.current?.id === e.threadId) {
          const fresh = await api.getThread(e.threadId)
          if (fresh) setThread(fresh)
        }
        setLive((l) => {
          const { [e.threadId]: _, ...rest } = l
          return rest
        })
        refreshList()
        if (e.type === 'error') checkAuth()
      }
    })
  }, [refreshList, checkAuth])

  // ------------------------------------------------------------ scrolling
  const activeLive = thread ? (live[thread.id] ?? null) : null
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [thread?.messages.length, activeLive?.text, activeLive?.messageId])

  useLayoutEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread?.id, view])

  // ------------------------------------------------------------ actions
  const select = useCallback(async (id: string) => {
    setRenaming(false)
    setView('chat')
    const t = await api.getThread(id)
    if (t) setThread(t)
    requestAnimationFrame(() => composer.current?.focus())
  }, [])

  const newChat = useCallback(() => {
    setThread(null)
    setRenaming(false)
    setView('chat')
    requestAnimationFrame(() => composer.current?.focus())
  }, [])

  const openLibrary = useCallback(() => {
    setView('library')
    setRenaming(false)
  }, [])

  const send = useCallback(
    async (text: string, images: ImageAttachment[], retry = false) => {
      let t = threadRef.current
      if (!t) {
        t = await api.createThread(defaults)
        setThread(t)
      }
      const id = t.id
      stick.current = true
      setLive((l) => ({ ...l, [id]: { messageId: '', text: '', thinking: false } }))
      try {
        await api.send({ threadId: id, text, images, retry })
      } catch (err) {
        setLive((l) => {
          const { [id]: _, ...rest } = l
          return rest
        })
        setToast({ text: errorText(err) })
      }
      const fresh = await api.getThread(id)
      if (fresh && (threadRef.current?.id === id || !threadRef.current)) setThread(fresh)
      refreshList()
    },
    [defaults, refreshList]
  )

  const retry = useCallback(() => send('', [], true), [send])

  const stop = useCallback(() => {
    if (threadRef.current) api.stop(threadRef.current.id)
  }, [])

  const patchThread = useCallback(async (patch: Partial<Defaults>) => {
    setDefaults((d) => ({ ...d, ...patch }))
    const t = threadRef.current
    if (t) setThread((await api.updateThread(t.id, patch)) ?? t)
  }, [])

  const setModel = useCallback((model: string) => patchThread({ model }), [patchThread])
  const setMode = useCallback((mode: TutorMode) => patchThread({ mode }), [patchThread])
  const setCourse = useCallback((courseId: string) => patchThread({ courseId }), [patchThread])
  const setEffort = useCallback((effort: Effort) => patchThread({ effort }), [patchThread])
  const login = useCallback((p: Provider) => api.openLogin(p), [])

  const commitDelete = useCallback(() => {
    const p = pendingDelete.current
    if (!p) return
    clearTimeout(p.timer)
    pendingDelete.current = null
    api.deleteThread(p.id).then(refreshList)
  }, [refreshList])

  const remove = useCallback(
    (id: string) => {
      commitDelete()
      api.stop(id)
      const idx = threads.findIndex((t) => t.id === id)
      setThreads((ts) => ts.filter((t) => t.id !== id))
      if (threadRef.current?.id === id) {
        const next = threads[idx + 1] ?? threads[idx - 1]
        if (next && next.id !== id) select(next.id)
        else setThread(null)
      }
      pendingDelete.current = { id, timer: window.setTimeout(() => (commitDelete(), setToast(null)), 5000) }
      setToast({
        text: 'Chat deleted',
        undo: () => {
          if (pendingDelete.current) clearTimeout(pendingDelete.current.timer)
          pendingDelete.current = null
          setToast(null)
          refreshList()
          select(id)
        }
      })
    },
    [threads, select, commitDelete, refreshList]
  )

  const rename = useCallback(
    async (title: string) => {
      setRenaming(false)
      const t = threadRef.current
      if (!t || !title.trim()) return
      const updated = await api.updateThread(t.id, { title })
      if (updated) setThread(updated)
      refreshList()
    },
    [refreshList]
  )

  useEffect(() => {
    if (!toast || toast.undo) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // ------------------------------------------------------------ keyboard
  const moveThread = useCallback(
    (delta: number) => {
      if (!threads.length) return
      const idx = threads.findIndex((t) => t.id === thread?.id)
      const next = threads[Math.max(0, Math.min(threads.length - 1, idx === -1 ? 0 : idx + delta))]
      if (next) select(next.id)
    },
    [threads, thread, select]
  )

  useEffect(
    () =>
      api.onMenu((a) => {
        if (a === 'new') newChat()
        else if (a === 'palette') setPalette((v) => !v)
        else if (a === 'sidebar') setCollapsed((v) => !v)
        else if (a === 'library') setView((v) => (v === 'library' ? 'chat' : 'library'))
      }),
    [newChat]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (palette) return
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        moveThread(e.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (e.key === 'Escape' && thread && live[thread.id]) {
        stop()
        return
      }
      if (view !== 'chat' || typing || e.metaKey || e.ctrlKey || e.altKey) return
      // Start typing anywhere to write in the composer.
      if (e.key.length === 1 || e.key === '/') {
        if (e.key === '/') e.preventDefault()
        composer.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [palette, moveThread, thread, live, stop, view])

  // ------------------------------------------------------------ palette
  const streaming = useMemo(() => new Set(Object.keys(live)), [live])
  const model = thread?.model ?? defaults.model
  const mode = thread?.mode ?? defaults.mode
  const courseId = thread?.courseId ?? defaults.courseId
  const effort = thread?.effort ?? defaults.effort

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: 'new', section: 'Actions', label: 'New chat', icon: <Plus />, hint: <kbd>{mod}N</kbd>, run: newChat },
      { id: 'library', section: 'Actions', label: 'Open library', icon: <Book />, hint: <kbd>{mod}L</kbd>, keywords: 'notes transcripts upload', run: openLibrary },
      {
        id: 'sidebar',
        section: 'Actions',
        label: collapsed ? 'Show sidebar' : 'Hide sidebar',
        icon: <SidebarIcon />,
        hint: <kbd>{mod}\</kbd>,
        run: () => setCollapsed((v) => !v)
      }
    ]
    if (thread) {
      cmds.push(
        { id: 'rename', section: 'Actions', label: 'Rename chat', icon: <Pencil />, run: () => setRenaming(true) },
        { id: 'delete', section: 'Actions', label: 'Delete chat', icon: <Trash />, run: () => remove(thread.id) }
      )
    }
    const current = <span className="crumb">current</span>
    for (const m of models) {
      cmds.push({
        id: `model-${m.id}`,
        section: 'Model',
        label: m.label,
        icon: <ProviderLogo provider={m.provider} />,
        hint: model === m.id ? current : undefined,
        keywords: `model ${m.provider} ${m.desc}`,
        run: () => setModel(m.id)
      })
    }
    for (const m of MODES) {
      cmds.push({
        id: `mode-${m.id}`,
        section: 'Mode',
        label: `${m.label} — ${m.desc}`,
        icon: <Bolt />,
        hint: mode === m.id ? current : undefined,
        keywords: 'mode tutor',
        run: () => setMode(m.id)
      })
    }
    const courseOpts = [{ id: '', name: 'No notes' }, ...(lib.courses.length > 1 ? [{ id: 'all', name: 'All courses' }] : []), ...lib.courses]
    for (const c of courseOpts) {
      cmds.push({
        id: `course-${c.id || 'none'}`,
        section: 'Course notes',
        label: `Use ${c.name}`,
        icon: <Book />,
        hint: courseId === c.id ? current : undefined,
        keywords: 'course notes rag library',
        run: () => setCourse(c.id)
      })
    }
    for (const t of ['system', 'dark', 'light'] as ThemePref[]) {
      cmds.push({
        id: `theme-${t}`,
        section: 'Theme',
        label: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`,
        icon: <Sun />,
        hint: theme === t ? current : undefined,
        keywords: 'appearance',
        run: () => setTheme(t)
      })
    }
    for (const s of statuses ?? []) {
      if (!s.ok && s.canLogin) {
        const name = s.provider === 'openai' ? 'ChatGPT' : 'Claude'
        cmds.push({ id: `login-${s.provider}`, section: 'Account', label: `Sign in to ${name}`, icon: <Terminal />, run: () => login(s.provider) })
      }
    }
    for (const t of threads) {
      cmds.push({ id: `t-${t.id}`, section: 'Chats', label: t.title, icon: <Chat />, keywords: t.preview, run: () => select(t.id) })
    }
    return cmds
  }, [threads, thread, collapsed, theme, model, mode, courseId, models, lib.courses, statuses, newChat, openLibrary, remove, select, setMode, setModel, setCourse, login])

  // ------------------------------------------------------------ render
  const provider = providerOf(model)
  const providerStatus = statuses?.find((s) => s.provider === provider)
  const hasMessages = !!thread && (thread.messages.length > 0 || !!activeLive)
  const needsAuth = !!providerStatus && !providerStatus.ok
  const readyFiles = lib.files.filter((f) => f.status === 'ready').length

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        activeId={thread?.id ?? null}
        streaming={streaming}
        collapsed={collapsed}
        statuses={statuses}
        libraryOpen={view === 'library'}
        fileCount={readyFiles}
        onLibrary={openLibrary}
        onLogin={login}
        onSelect={select}
        onNew={newChat}
        onDelete={remove}
        onToggle={() => setCollapsed((v) => !v)}
        onPalette={() => setPalette(true)}
      />
      <main className="main">
        <header className={`header drag ${collapsed ? 'inset' : ''}`}>
          {collapsed && (
            <button className="icon-btn no-drag" title={`Show sidebar  ${mod}\\`} onClick={() => setCollapsed(false)}>
              <SidebarIcon />
            </button>
          )}
          {view === 'library' ? (
            <span className="header-title">Library</span>
          ) : renaming && thread ? (
            <input
              className="header-title-input no-drag"
              autoFocus
              defaultValue={thread.title}
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename(e.currentTarget.value)
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <button className="header-title no-drag" onClick={() => thread && setRenaming(true)} title={thread ? 'Rename' : undefined}>
              {thread?.title ?? 'New chat'}
            </button>
          )}
          <span className="spacer" />
          <button className="icon-btn no-drag" title={`New chat  ${mod}N`} onClick={newChat}>
            <Plus />
          </button>
        </header>

        {view === 'library' ? (
          <div className="scroll">
            <Library lib={lib} selected={libCourse} onSelect={setLibCourse} onToast={(text) => setToast({ text })} />
          </div>
        ) : (
          <>
            <div
              className="scroll"
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              {hasMessages ? (
                <Messages messages={thread!.messages} live={activeLive} onRetry={retry} />
              ) : needsAuth ? (
                <AuthCard status={providerStatus!} onRecheck={checkAuth} />
              ) : (
                <Empty onPick={(t) => composer.current?.setText(t)} />
              )}
            </div>

            <Composer
              ref={composer}
              models={models}
              statuses={statuses ?? []}
              model={model}
              mode={mode}
              effort={effort}
              courseId={courseId}
              courses={lib.courses}
              streaming={!!activeLive}
              disabled={needsAuth}
              onModel={setModel}
              onMode={setMode}
              onEffort={setEffort}
              onCourse={setCourse}
              onLogin={login}
              onOpenLibrary={openLibrary}
              onSend={(t, imgs) => send(t, imgs)}
              onStop={stop}
            />
          </>
        )}
      </main>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {toast && (
        <div className="toast">
          {toast.text}
          {toast.undo && (
            <button className="btn sm" style={{ marginLeft: 12 }} onClick={toast.undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
