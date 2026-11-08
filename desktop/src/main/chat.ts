import { randomUUID } from 'node:crypto'
import type { ChatEvent, ChatMessage, SendRequest, Source, Thread, TutorMode } from '../shared/types'
import * as store from './store'
import * as library from './rag/library'
import { parseModel, stream } from './providers'
import { claudeStatus, invalidateUsage, rewriteQueries } from './providers/claude'
import { queryLabels } from './rag/labels'
import { pageImages } from './rag/pages'
import { runPython } from './python'

const running = new Map<string, AbortController>()

export const isRunning = (id: string) => running.has(id)
export const stopThread = (id: string) => running.get(id)?.abort()
export const stopAll = () => running.forEach((a) => a.abort())

// ---------------------------------------------------------------- prompts

const BASE_PROMPT = `You are Lemma, a patient, precise maths tutor for a university student.

Formatting:
- Write all mathematics in LaTeX: inline as $...$ and display as $$...$$ on their own lines. Never use \\( \\) or \\[ \\].
- Use short paragraphs, numbered steps for derivations, and **bold** for the key idea. Use Markdown headings only for long answers.
- Keep notation consistent with what the student uses.

Teaching:
- Be mathematically rigorous: state assumptions, justify each non-obvious step, and flag common mistakes.
- When a problem is ambiguous, say what interpretation you are using.
- Prefer intuition first, then the formal argument. Sanity-check final answers (units, special cases, limits).
- If the student shares a photo or screenshot of a problem, transcribe the problem in LaTeX first so they can confirm you read it correctly.

This is a chat: answer directly. Do not run commands, read files or use tools.`

const MATERIALS_PROMPT = `Course materials:
Some messages include excerpts from the student's own lecture notes and lecture transcripts inside <course_materials>. When they are relevant:
- Ground your answer in them and follow their definitions, notation and conventions (these are what the student will be assessed on).
- Cite the excerpts you use inline as [1], [2], matching their numbers.
- If they conflict with standard conventions, follow the course and point out the difference.
- If they don't cover the question, say so briefly and answer from general knowledge.
Transcripts are auto-generated, so expect some mis-transcribed words and maths.`

const SEARCH_PROMPT = `You have a search_notes tool over the student's own notes, worksheets and lecture transcripts. The excerpts in <course_materials> were picked automatically and often miss the most relevant passage.
- If those excerpts don't directly contain what the question is about (the definition, theorem, numbered result or method asked for), you MUST call search_notes before answering. Never say the notes don't cover something without searching first.
- Search with precise mathematical terms, as the notes would phrase it (e.g. "definition convergence sequence epsilon N", "Proposition 3.12", "uniformly continuous definition"), not the student's wording. Try a rephrased search if the first misses. At most 3 searches.
- Don't narrate searching; just answer, citing excerpts as [n].`

const PYTHON_PROMPT = `You can run Python (sympy, numpy, scipy) with the run_python tool. Use it to verify calculations, simplifications, integrals, eigenvalues, numerical checks or small counterexample searches when that makes your answer more reliable, especially before stating a final numeric or symbolic result. Keep the maths in your answer; mention briefly that you checked it (e.g. "checked with sympy"). Don't use it for pure proof-writing.`

const PAGES_PROMPT = `When images of note pages are attached, they are the original pages behind the excerpts. Read formulas from the images (the extracted text garbles maths) and quote the course's statements exactly.`

const MODE_PROMPT: Record<TutorMode, string> = {
  explain: 'Mode: Explain. Work through the problem fully with clear reasoning, then summarise the method in one or two lines.',
  hint: 'Mode: Hints only. Do NOT give the full solution or final answer. Give the smallest useful next hint, ask a guiding question, and stop. Give more only if the student asks.',
  check:
    'Mode: Check my work. The student will share their attempt. Identify exactly where it is correct and where it goes wrong, quoting the step. Do not rewrite the whole solution unless asked.'
}

function systemPrompt(t: Thread, canSearch: boolean, tools: boolean) {
  return [
    BASE_PROMPT.replace('Do not run commands, read files or use tools.', tools ? 'Only use the tools described below.' : 'Do not run commands, read files or use tools.'),
    t.courseId ? MATERIALS_PROMPT : '',
    t.courseId ? PAGES_PROMPT : '',
    canSearch ? SEARCH_PROMPT : '',
    tools ? PYTHON_PROMPT : '',
    MODE_PROMPT[t.mode]
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Formats search hits for the model, numbering them after the excerpts it already has. */
function formatHits(hits: Source[]) {
  if (!hits.length) return 'No matching passages in the notes. Answer from general knowledge and say the notes don’t cover it.'
  return hits.map((s) => `[${s.n}] ${s.fileName}${s.location ? ` (${s.location})` : ''}\n${s.excerpt}`).join('\n\n---\n\n')
}

function transcript(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.content && !m.error)
    .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}${m.images?.length ? ' [image attached]' : ''}`)
    .join('\n\n')
}

function materialsBlock(sources: Source[], canSearch: boolean) {
  if (!sources.length) {
    return canSearch ? '(No passages were found automatically. Use search_notes if the question is about the course.)\n\n' : ''
  }
  const body = sources
    .map((s) => `[${s.n}] ${s.fileName}${s.location ? ` (${s.location})` : ''}\n${s.excerpt}`)
    .join('\n\n---\n\n')
  const reminder = canSearch
    ? '\n(These were retrieved automatically by keyword/similarity. If none of them states exactly what the question asks about, call search_notes with better terms before answering.)'
    : ''
  return `<course_materials>\n${body}\n</course_materials>${reminder}\n\n`
}

/** Rewriting needs a signed-in Claude; a positive check is remembered, a negative one re-checked. */
let claudeReady = false
async function canRewrite() {
  if (!claudeReady) claudeReady = (await claudeStatus()).ok
  return claudeReady
}

/**
 * Retrieval: the question itself plus up to three textbook-style rewrites
 * (from Haiku), searched in parallel and fused by reciprocal rank. Exact
 * references ("Proposition 3.12") skip the rewrite, since they're found directly.
 */
async function retrieve(text: string, history: ChatMessage[], courseId: string, onStatus: (s: string) => void): Promise<Source[]> {
  const q = retrievalQuery(text, history)
  const prev = [...history].reverse().find((m) => m.role === 'user')?.content
  onStatus('Searching your notes…')
  const rewrites = !queryLabels(text).length && (await canRewrite()) ? rewriteQueries(text, text.split(/\s+/).length < 8 ? prev : undefined) : Promise.resolve([])
  const lists = await Promise.all([library.search(q, courseId), rewrites.then((rs) => Promise.all(rs.map((r) => library.search(r, courseId))))])
  const all = [lists[0], ...lists[1]]
  const key = (s: Source) => `${s.fileId}|${s.excerpt.slice(0, 120)}`
  const fused = new Map<string, { s: Source; score: number }>()
  all.forEach((list, li) =>
    list.forEach((s, rank) => {
      // Exact-reference hits from the original question keep the top spots.
      const bonus = li === 0 && s.score >= 0.95 ? 1 : 0
      const cur = fused.get(key(s)) ?? { s, score: 0 }
      cur.score += 1 / (4 + rank) + bonus
      fused.set(key(s), cur)
    })
  )
  const limit = lists[0].some((s) => s.score >= 0.95) ? lists[0].length : 6
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x, i) => ({ ...x.s, n: i + 1 }))
}

/** Short follow-ups ("why?", "and the second part?") retrieve better with the previous question. */
function retrievalQuery(text: string, history: ChatMessage[]) {
  const prev = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
  return text.split(/\s+/).length < 8 && prev ? `${prev}\n${text}` : text
}

/**
 * Builds the text sent to the model. A provider only knows the turns its own
 * session has seen, so turns it missed (new chat, session lost, or answered by
 * the other provider) are replayed as context.
 */
function buildPrompt(history: ChatMessage[], seen: number, text: string, sources: Source[], canSearch: boolean) {
  const missed = history.slice(seen)
  let prefix = ''
  if (missed.length) {
    prefix =
      seen === 0
        ? `Here is our conversation so far, for context:\n\n${transcript(missed)}\n\n---\n\n`
        : `(Since your last reply, the conversation continued with another tutor:)\n\n${transcript(missed)}\n\n---\n\n`
  }
  const question = text || (sources.length ? '' : 'Please look at the attached image.')
  return `${prefix}${materialsBlock(sources, canSearch)}${prefix || sources.length ? 'Student: ' : ''}${question}`
}

// ---------------------------------------------------------------- titles

const SYM: Record<string, string> = {
  sqrt: '√', int: '∫', sum: 'Σ', prod: 'Π', infty: '∞', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ',
  theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', epsilon: 'ε', delta: 'δ', partial: '∂', nabla: '∇',
  cdot: '·', times: '×', leq: '≤', geq: '≥', neq: '≠', to: '→', in: '∈', mathbb: '', mathrm: '', frac: ''
}

export function titleFrom(text: string) {
  const line = text
    .replace(/\\([a-zA-Z]+)/g, (m, name: string) => SYM[name] ?? m.slice(1))
    .replace(/[{}$]/g, '')
    .replace(/\\[,;!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return 'Image problem'
  return line.length > 48 ? `${line.slice(0, 46).trimEnd()}…` : line
}

// ---------------------------------------------------------------- send

export async function send(req: SendRequest, emit: (e: ChatEvent) => void) {
  const thread = store.getThread(req.threadId)
  if (!thread) throw new Error('Thread not found')
  if (running.has(thread.id)) throw new Error('Already replying in this chat')

  if (req.retry) {
    // Drop the failed reply and the user turn it answered, then resend that turn.
    if (thread.messages.at(-1)?.role === 'assistant') thread.messages.pop()
    const last = thread.messages.at(-1)
    if (last?.role !== 'user') throw new Error('Nothing to retry')
    thread.messages.pop()
    req = { threadId: req.threadId, text: last.content, images: last.images }
  }

  const history = [...thread.messages]
  const userMessage: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: req.text,
    images: req.images?.length ? req.images : undefined,
    createdAt: Date.now()
  }
  const assistantId = randomUUID()
  thread.messages.push(userMessage)
  thread.updatedAt = Date.now()
  if (history.length === 0 && thread.title === 'New chat') {
    thread.title = titleFrom(req.text)
    emit({ threadId: thread.id, type: 'title', title: thread.title })
  }
  store.saveThread(thread)

  const abort = new AbortController()
  running.set(thread.id, abort)
  const started = Date.now()

  void (async () => {
    const { provider, model } = parseModel(thread.model)

    let sources: Source[] = []
    if (thread.courseId && req.text.trim()) {
      try {
        sources = await retrieve(req.text, history, thread.courseId, (text) =>
          emit({ threadId: thread.id, messageId: assistantId, type: 'status', text })
        )
      } catch (e) {
        console.error('[lemma] retrieval failed', e)
      }
    }
    emit({ threadId: thread.id, messageId: assistantId, type: 'start', sources })

    // Claude can search the notes itself; new hits are numbered after the
    // automatic ones so citations stay consistent, and shown live.
    const canSearch = provider === 'claude' && !!thread.courseId
    const isClaude = provider === 'claude'
    const status = (text: string) => emit({ threadId: thread.id, messageId: assistantId, type: 'status', text })

    // Original page images for the cited PDF pages (exact formulas).
    let pages: Awaited<ReturnType<typeof pageImages>> = { images: [], labels: [] }
    if (sources.length) {
      try {
        pages = await pageImages(sources)
      } catch (e) {
        console.error('[lemma] page images failed', e)
      }
    }
    const searchNotes = async (q: string) => {
      const hits = await library.search(q, thread.courseId, 5)
      const out: Source[] = []
      for (const h of hits) {
        const same = sources.find((s) => s.fileId === h.fileId && s.excerpt === h.excerpt)
        if (same) out.push(same)
        else {
          const added = { ...h, n: sources.length + 1 }
          sources.push(added)
          out.push(added)
        }
      }
      emit({ threadId: thread.id, messageId: assistantId, type: 'sources', sources: [...sources] })
      return formatHits(out)
    }

    const run = async (session: { id: string; upTo: number } | undefined) => {
      let newSession = session?.id
      const seen = session ? Math.min(session.upTo, history.length) : 0
      const res = await stream(provider, {
        model,
        effort: thread.effort,
        searchNotes: canSearch ? searchNotes : undefined,
        runPython: isClaude ? (code: string) => runPython(code, status) : undefined,
        onStatus: (text) => emit({ threadId: thread.id, messageId: assistantId, type: 'status', text }),
        system: systemPrompt(thread, canSearch, isClaude),
        text:
          buildPrompt(history, seen, req.text, sources, canSearch) +
          (pages.labels.length ? `\n\n(Attached after any student images: original note pages ${pages.labels.join('; ')}.)` : ''),
        images: [...(req.images ?? []), ...pages.images],
        resume: session?.id,
        abort,
        onSession: (id) => (newSession = id),
        onDelta: (text) => emit({ threadId: thread.id, messageId: assistantId, type: 'delta', text }),
        onThinking: () => emit({ threadId: thread.id, messageId: assistantId, type: 'thinking' })
      })
      return { res, newSession }
    }

    const prior = thread.sessions?.[provider]
    let { res, newSession } = await run(prior)
    // The provider's saved session is gone: start fresh, replaying the chat.
    if (res.resumeFailed) ({ res, newSession } = await run(undefined))
    running.delete(thread.id)
    if (provider === 'claude') invalidateUsage()

    const msg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: res.text,
      createdAt: Date.now(),
      durationMs: Date.now() - started,
      model: res.model ?? model,
      provider,
      error: res.error,
      stopped: res.stopped,
      sources: sources.length ? sources : undefined
    }

    const latest = store.getThread(thread.id)
    if (!latest) return // deleted mid-stream
    latest.messages.push(msg)
    if (newSession && !res.error) {
      latest.sessions = { ...latest.sessions, [provider]: { id: newSession, upTo: latest.messages.length } }
    }
    latest.updatedAt = Date.now()
    store.saveThread(latest)
    emit({ threadId: thread.id, messageId: assistantId, type: res.error ? 'error' : 'done', message: msg })
  })()

  return { userMessage, assistantId }
}
