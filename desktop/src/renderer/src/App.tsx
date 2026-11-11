import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClaudeUsage,
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
import { api, errorText, MODES, mod, plainTitle, PROVIDERS, providerOf, quoteMarkdown, selectionMarkdown } from './lib'
import { Sidebar } from './components/Sidebar'
import { Composer, type ComposerHandle } from './components/Composer'
import { AuthCard, Empty, Messages, type LiveReply } from './components/Messages'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Library } from './components/Library'
import { Practice } from './components/Practice'
import { MemorableBackground } from './components/MemorableBackground'
import { ArrowDown, Book, Bolt, Chat, Pencil, Target, Plus, ProviderLogo, Sidebar as SidebarIcon, Sun, Terminal, Trash } from './components/Icons'

type ThemePref = 'system' | 'dark' | 'light'
interface Defaults {
  model: string
  mode: TutorMode
  courseId: string
  effort: Effort
  /** Whether to include course-notes context in Claude chats (can be disabled to save usage). */
  notesEnabled: boolean
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
  const [view, setView] = useState<'chat' | 'library' | 'practice'>('chat')
  const [libCourse, setLibCourse] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [collapsed, setCollapsed] = useState(() => loadScalar('sidebarCollapsed', false))
  const [theme, setTheme] = useState<ThemePref>(() => loadScalar('theme', 'system'))
  const [defaults, setDefaults] = useState<Defaults>(() => {
    const d = load<Defaults>('defaults', { model: 'claude:claude-opus-5-5', mode: 'explain', courseId: '', effort: 'medium', notesEnabled: true })
    return { ...d, model: LEGACY[d.model] ?? d.model, notesEnabled: d.notesEnabled ?? true }
  })
  const [renaming, setRenaming] = useState(false)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const [stuck, setStuckState] = useState(true)
  const [quote, setQuote] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ x: number; y: number; text: string } | null>(null)

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

  const loadUsage = useCallback(async (force = false) => {
    try {
      setUsage(await api.claudeUsage(force))
    } catch {
      /* ignore */
    }
  }, [])

  // Load Claude usage once Claude is connected, and refresh every 5 minutes.
  useEffect(() => {
    const claudeOk = !!statuses?.find((s) => s.provider === 'claude')?.ok
    if (!claudeOk) return
    loadUsage()
    const t = setInterval(() => loadUsage(), 5 * 60_000)
    return () => clearInterval(t)
  }, [statuses, loadUsage])

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
      // Take the pending text out of the shared buffer *before* the state update: updater functions must be pure
      // (React may run them twice), so they can't empty the buffer themselves.
      const batch = new Map(buf)
      buf.clear()
      setLive((prev) => {
        const next = { ...prev }
        for (const [tid, text] of batch) {
          const cur = next[tid] ?? { messageId: '', text: '', thinking: false }
          next[tid] = { ...cur, text: cur.text + text, status: undefined }
        }
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
  const setStick = useCallback((v: boolean) => {
    stick.current = v
    setStuckState(v)
  }, [])

  // New messages: jump to the bottom if following.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [thread?.messages.length, activeLive?.messageId])

  // While a reply streams, ease towards the bottom every frame instead of jumping in chunks.
  const replying = !!activeLive
  useEffect(() => {
    if (!replying) return
    let raf = 0
    const tick = () => {
      const el = scroller.current
      if (el && stick.current) {
        const d = el.scrollHeight - el.clientHeight - el.scrollTop
        if (d > 0.5) el.scrollTop += d < 2 ? d : d * 0.2
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [replying])

  useLayoutEffect(() => {
    setStick(true)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread?.id, view, setStick])

  const jumpToBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setStick(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [setStick])

  // ------------------------------------------------------------ ask about a selection
  useEffect(() => {
    const check = () => {
      const sel = window.getSelection()
      const root = scroller.current
      if (!sel || sel.isCollapsed || !sel.rangeCount || !root) return setAsk(null)
      const range = sel.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return setAsk(null)
      // Only text inside the conversation (not the empty state or sign-in card).
      if (!root.querySelector('.column')?.contains(range.commonAncestorContainer)) return setAsk(null)
      const text = selectionMarkdown(range)
      if (text.length < 2) return setAsk(null)
      const rects = range.getClientRects()
      const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
      // The end of the selection must be inside the visible chat area.
      const vis = root.getBoundingClientRect()
      if (r.bottom < vis.top + 8 || r.bottom > vis.bottom - 8) return setAsk(null)
      setAsk({ x: r.right, y: r.bottom, text })
    }
    const onUp = () => setTimeout(check, 0)
    const onChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setAsk(null)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keyup', onUp)
    document.addEventListener('selectionchange', onChange)
    // Re-place (or hide) the button when the chat scrolls under a live selection.
    document.addEventListener('scroll', check, true)
    return () => {
      document.removeEventListener('scroll', check, true)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keyup', onUp)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [])

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
  const openPractice = useCallback(() => {
    setView('practice')
    setRenaming(false)
  }, [])

  const send = useCallback(
    async (text: string, images: ImageAttachment[], retry = false, editId?: string) => {
      let t = threadRef.current
      if (!t) {
        t = await api.createThread(defaults)
        setThread(t)
      }
      const id = t.id
      setStick(true)
      setLive((l) => ({ ...l, [id]: { messageId: '', text: '', thinking: false } }))
      try {
        await api.send({ threadId: id, text, images, retry, editId })
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
    [defaults, refreshList, setStick]
  )

  const retry = useCallback(() => send('', [], true), [send])

  /** Replace an earlier message: show the chat rewound right away, then resend from there. */
  const edit = useCallback(
    (id: string, text: string) => {
      const t = threadRef.current
      const idx = t?.messages.findIndex((m) => m.id === id) ?? -1
      if (!t || idx === -1) return
      const images = t.messages[idx].images ?? []
      setThread({ ...t, messages: t.messages.slice(0, idx) })
      send(text, images, false, id)
    },
    [send]
  )

  const sendWithQuote = useCallback(
    (text: string, images: ImageAttachment[]) => {
      const full = quote ? `${quoteMarkdown(quote)}\n\n${text}` : text
      setQuote(null)
      send(full, images)
    },
    [quote, send]
  )

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
  const login = useCallback((p: Provider, cmd?: string) => api.openLogin(p, cmd), [])

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
        else if (a === 'practice') setView((v) => (v === 'practice' ? 'chat' : 'practice'))
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
      { id: 'practice', section: 'Actions', label: 'Practice questions', icon: <Target />, hint: <kbd>{mod}P</kbd>, keywords: 'exam quiz test mark revise', run: openPractice },
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
        const name = PROVIDERS[s.provider]?.name ?? s.provider
        cmds.push({ id: `login-${s.provider}`, section: 'Account', label: `Sign in to ${name}`, icon: <Terminal />, run: () => login(s.provider) })
      }
    }
    for (const t of threads) {
      cmds.push({ id: `t-${t.id}`, section: 'Chats', label: plainTitle(t.title), icon: <Chat />, keywords: t.preview, run: () => select(t.id) })
    }
    return cmds
  }, [threads, thread, collapsed, theme, model, mode, courseId, models, lib.courses, statuses, newChat, openLibrary, openPractice, remove, select, setMode, setModel, setCourse, login])

  // ------------------------------------------------------------ render
  const provider = providerOf(model)
  const providerStatus = statuses?.find((s) => s.provider === provider)
  // The provider is "offline" (not signed in / not running). We still allow the app to be used —
  // the user can switch to a connected provider using the model picker in the Composer.
  const providerOffline = !!providerStatus && !providerStatus.ok
  // Block sending only when every known provider is disconnected (truly no way to chat).
  const noProviders = !!statuses && statuses.every((s) => !s.ok)
  const hasMessages = !!thread && (thread.messages.length > 0 || !!activeLive)
  const readyFiles = lib.files.filter((f) => f.status === 'ready').length

  // The effective courseId passed to threads: empty when notes are disabled.
  const effectiveCourseId = defaults.notesEnabled ? courseId : ''

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        activeId={thread?.id ?? null}
        streaming={streaming}
        collapsed={collapsed}
        statuses={statuses}
        libraryOpen={view === 'library'}
        practiceOpen={view === 'practice'}
        onPractice={openPractice}
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
        <MemorableBackground active={!hasMessages && view === 'chat' && !providerOffline} />
        <header className={`header drag ${collapsed ? 'inset' : ''}`}>
          {collapsed && (
            <button className="icon-btn no-drag" title={`Show sidebar  ${mod}\\`} onClick={() => setCollapsed(false)}>
              <SidebarIcon />
            </button>
          )}
          {view === 'library' || view === 'practice' ? (
            <span className="header-title">{view === 'library' ? 'Library' : 'Practice'}</span>
          ) : renaming && thread ? (
            <input
              className="header-title-input no-drag"
              autoFocus
              defaultValue={plainTitle(thread.title)}
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename(e.currentTarget.value)
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <button className="header-title no-drag" onClick={() => thread && setRenaming(true)} title={thread ? 'Rename' : undefined}>
              {thread ? plainTitle(thread.title) : 'New chat'}
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
        ) : view === 'practice' ? (
          <div className="scroll">
            <Practice lib={lib} model={defaults.model} effort={defaults.effort} onToast={(text) => setToast({ text })} onOpenLibrary={openLibrary} />
          </div>
        ) : (
          <>
            <div className="scroll-wrap">
              <div
                className="scroll"
                ref={scroller}
                onScroll={(e) => {
                  const el = e.currentTarget
                  // Back at the bottom = following again. Leaving the bottom is detected from the wheel / scrollbar
                  // so content growing while we follow never unsticks us by accident.
                  if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setStick(true)
                }}
                onWheel={(e) => {
                  if (e.deltaY < 0) setStick(false)
                }}
                onPointerDown={(e) => {
                  // A press on the scrollbar itself (outside the content box).
                  if (e.target === e.currentTarget && e.nativeEvent.offsetX > e.currentTarget.clientWidth) setStick(false)
                }}
                onKeyDown={(e) => {
                  if (['PageUp', 'Home', 'ArrowUp'].includes(e.key)) setStick(false)
                }}
              >
                {hasMessages ? (
                  <Messages messages={thread!.messages} live={activeLive} canEdit={!activeLive} onRetry={retry} onEdit={edit} />
                ) : providerOffline ? (
                  <AuthCard status={providerStatus!} onRecheck={checkAuth} />
                ) : (
                  <Empty onPick={(t) => composer.current?.setText(t)} />
                )}
              </div>
              {hasMessages && (
                <button
                  className={`jump ${!stuck ? 'show' : ''} ${activeLive ? 'busy' : ''}`}
                  title="Scroll to latest"
                  aria-label="Scroll to latest"
                  tabIndex={stuck ? -1 : 0}
                  onClick={jumpToBottom}
                >
                  <span className="jump-ring" />
                  <ArrowDown size={15} />
                </button>
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
              disabled={providerOffline}
              onModel={setModel}
              onMode={setMode}
              onEffort={setEffort}
              onCourse={setCourse}
              onLogin={login}
              onOpenLibrary={openLibrary}
              quote={quote}
              onClearQuote={() => setQuote(null)}
              onSend={sendWithQuote}
              onStop={stop}
            />
          </>
        )}
      </main>

      {ask && view === 'chat' && (
        <button
          className="ask-pop"
          style={{ left: Math.min(Math.max(ask.x - 60, 12), window.innerWidth - 150), top: Math.min(ask.y + 8, window.innerHeight - 48) }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuote(ask.text)
            setAsk(null)
            window.getSelection()?.removeAllRanges()
            composer.current?.focus()
          }}
        >
          <Chat size={14} /> Ask about this
        </button>
      )}

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
