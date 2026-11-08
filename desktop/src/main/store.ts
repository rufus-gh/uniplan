import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Thread, ThreadSummary } from '../shared/types'
import { normalizeModel } from './providers'

/** Threads are stored one JSON file per thread under <userData>/threads. */
const dir = () => {
  const d = join(app.getPath('userData'), 'threads')
  mkdirSync(d, { recursive: true })
  return d
}

const cache = new Map<string, Thread>()
let loaded = false

function loadAll() {
  if (loaded) return
  loaded = true
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue
    try {
      cache.set(...migrate(JSON.parse(readFileSync(join(dir(), f), 'utf8'))))
    } catch {
      // ignore a corrupt file rather than failing startup
    }
  }
}

/** Upgrades threads saved by older versions. */
function migrate(t: Thread & { sessionId?: string }): [string, Thread] {
  const model = normalizeModel(t.model)
  if (t.sessionId && !t.sessions) {
    t.sessions = { claude: { id: t.sessionId, upTo: t.messages.length } }
    delete t.sessionId
  }
  return [t.id, { ...t, model, courseId: t.courseId ?? '', effort: t.effort ?? 'medium' }]
}

export function listThreads(): ThreadSummary[] {
  loadAll()
  return [...cache.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, createdAt, updatedAt, model, mode, courseId, effort, messages }) => {
      const last = [...messages].reverse().find((m) => m.content)
      return { id, title, createdAt, updatedAt, model, mode, courseId, effort, preview: last?.content.slice(0, 140) ?? '' }
    })
}

export function getThread(id: string): Thread | null {
  loadAll()
  return cache.get(id) ?? null
}

export function createThread(init: Partial<Pick<Thread, 'model' | 'mode' | 'courseId' | 'effort'>> = {}): Thread {
  loadAll()
  const now = Date.now()
  const t: Thread = {
    id: randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    model: normalizeModel(init.model),
    mode: init.mode ?? 'explain',
    courseId: init.courseId ?? '',
    effort: init.effort ?? 'medium',
    messages: []
  }
  cache.set(t.id, t)
  // Not written to disk until the first message, so empty chats don't pile up.
  return t
}

export function saveThread(t: Thread) {
  cache.set(t.id, t)
  if (t.messages.length === 0) return
  const file = join(dir(), `${t.id}.json`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(t))
  renameSync(tmp, file)
}

export function deleteThread(id: string) {
  cache.delete(id)
  rmSync(join(dir(), `${id}.json`), { force: true })
}
