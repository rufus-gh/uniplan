import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Effort, ImageAttachment, PracticeAttempt, PracticeLevel, PracticeRequest, PracticeStyle, Source } from '../shared/types'
import * as library from './rag/library'
import { pageImages } from './rag/pages'
import { parseModel, stream } from './providers'
import { runPython } from './python'

/*
 * Practice mode: write an exam-style question from the student's own course
 * materials, then mark their answer against a reference solution and mark
 * scheme (generated, and checked with Python where the model chooses to).
 * Attempts are saved in <userData>/practice.json.
 */

const file = () => join(app.getPath('userData'), 'practice.json')
let attempts: PracticeAttempt[] | null = null

function all(): PracticeAttempt[] {
  if (!attempts) {
    try {
      attempts = JSON.parse(readFileSync(file(), 'utf8')) as PracticeAttempt[]
    } catch {
      attempts = []
    }
  }
  return attempts
}

function save() {
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(all()))
  renameSync(tmp, file())
}

/** What the renderer may see: the solution and mark scheme stay hidden until the attempt is closed. */
function view(a: PracticeAttempt): PracticeAttempt {
  if (a.status === 'open') {
    const { solution: _s, markscheme: _m, ...rest } = a
    return rest
  }
  return a
}

export function list(courseId: string): PracticeAttempt[] {
  return all()
    .filter((a) => a.courseId === courseId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(view)
}

export function remove(id: string) {
  attempts = all().filter((a) => a.id !== id)
  save()
}

// ---------------------------------------------------------------- model calls

async function ask(modelId: string, effort: Effort, system: string, text: string, images: ImageAttachment[]) {
  const { provider, model } = parseModel(modelId)
  const res = await stream(provider, {
    model,
    effort: provider === 'claude' ? effort : undefined,
    system,
    text,
    images,
    abort: new AbortController(),
    // Claude can check calculations; GPT answers without tools.
    runPython: provider === 'claude' ? (code) => runPython(code, () => {}) : undefined,
    onSession() {},
    onDelta() {},
    onThinking() {}
  })
  if (res.error && !res.text) throw new Error(res.error)
  return res.text
}

const tag = (s: string, t: string) => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i'))?.[1].trim()

const STYLE: Record<PracticeStyle, string> = {
  mixed: 'a sensible mix of computation and reasoning',
  computation: 'a computational question (a calculation with clear steps and a definite answer)',
  proof: 'a proof question (prove a statement using the course’s definitions and results)'
}
const LEVEL: Record<PracticeLevel, string> = {
  easier: 'easier than a typical exam question: a single idea, about 3–5 marks',
  standard: 'typical exam difficulty: a couple of linked steps, about 5–8 marks',
  harder: 'harder than a typical exam question: several ideas combined, about 8–12 marks'
}

const GEN_SYSTEM = `You write exam practice questions for a university maths student, in the style and notation of their own course.

Output EXACTLY these tags and nothing outside them:
<question>The question. Self-contained, LaTeX with $...$ and $$...$$. No solution. Label parts (a), (b) if there are several.</question>
<marks>Total marks, a whole number.</marks>
<hint>One short sentence that nudges without giving the answer away.</hint>
<solution>A complete, rigorous worked solution in LaTeX, written the way the course would.</solution>
<markscheme>A bullet list of where each mark is earned, adding up to the total.</markscheme>

Rules:
- Use the definitions, theorems and notation in the course materials you are given. Only ask what the course has covered.
- If lecturer remarks in the materials stress something (e.g. "this will be on the exam"), prefer testing that.
- Make it genuinely examinable: precise, unambiguous, and answerable in a few minutes to half an hour.
- Verify every calculation in your solution with the run_python tool before finalising, if you have it.
- Do not repeat or closely mimic the previous questions listed.`

const MARK_SYSTEM = `You mark a university maths student's answer like a fair, precise tutor.

Output EXACTLY these tags and nothing outside them:
<score>A whole number from 0 to the total marks.</score>
<feedback>Markdown with LaTeX. Start with a one-line verdict. Then go through their working, quoting their steps: what earned marks, where marks were lost and why, and what a correct step looks like. Point out missing justification (markers deduct for it). Address the student directly as "you". Be concise and specific. Do NOT rewrite the full solution; it is shown separately.</feedback>

Rules:
- Compare against the mark scheme and reference solution, but give full credit for any valid alternative method.
- If the answer is blank or irrelevant, score 0.
- If you can, verify any numeric or algebraic claim in their working with run_python before judging it.
- Images attached are the student's handwritten or typed working: read them carefully.`

// ---------------------------------------------------------------- generate

function materials(sources: Source[]) {
  return sources
    .map((s) => `[${s.n}] ${s.fileName}${s.location ? ` (${s.location})` : ''}\n${s.excerpt}`)
    .join('\n\n---\n\n')
}

/** Notes for the topic, a couple of "what the lecturer stressed" clips, or random statements with no topic. */
async function gather(courseId: string, topic: string): Promise<Source[]> {
  const notes = topic ? await library.search(topic, courseId, 5) : await library.sample(courseId, 4)
  const emphasis = (await library.search(`${topic} exam important lecturer said`.trim(), courseId, 6)).filter((h) => /\.vtt$|\.srt$|^\d+ .*Lecture/i.test(h.fileName)).slice(0, 2)
  const out: Source[] = []
  for (const h of [...notes, ...emphasis]) {
    if (!out.some((o) => o.fileId === h.fileId && o.excerpt === h.excerpt)) out.push({ ...h, n: out.length + 1 })
  }
  return out
}

export async function generate(req: PracticeRequest): Promise<PracticeAttempt> {
  const sources = await gather(req.courseId, req.topic.trim())
  if (!sources.length) {
    throw new Error(
      req.topic.trim()
        ? `Nothing in your notes matches “${req.topic.trim()}”. Try a different topic, or leave it blank for a mix.`
        : 'This course has no indexed notes yet. Add some in the Library first.'
    )
  }
  const previous = list(req.courseId)
    .slice(0, 8)
    .map((a) => `- ${a.question.replace(/\s+/g, ' ').slice(0, 140)}`)
    .join('\n')
  const { images, labels } = await pageImages(sources).catch(() => ({ images: [] as ImageAttachment[], labels: [] as string[] }))

  const text = [
    `Course: ${library.courseName(req.courseId) ?? 'this course'}`,
    `Topic: ${req.topic.trim() || '(none given: choose something suitable from the materials)'}`,
    `Type: ${STYLE[req.style]}`,
    `Difficulty: ${LEVEL[req.level]}`,
    previous ? `Previous questions (do not repeat):\n${previous}` : '',
    `Course materials (excerpts from the student's notes and lecture transcripts):\n\n${materials(sources)}`,
    labels.length ? `(Original note pages attached: ${labels.join('; ')}. Read formulas from them.)` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const out = await ask(req.model, req.effort, GEN_SYSTEM, text, images)
  const question = tag(out, 'question')
  const solution = tag(out, 'solution')
  if (!question || !solution) throw new Error('The model didn’t return a usable question. Try again.')
  const marks = Math.max(1, Math.min(30, parseInt(tag(out, 'marks') ?? '', 10) || 6))

  const a: PracticeAttempt = {
    id: randomUUID(),
    courseId: req.courseId,
    topic: req.topic.trim(),
    style: req.style,
    level: req.level,
    question,
    marks,
    hint: tag(out, 'hint') ?? '',
    sources,
    createdAt: Date.now(),
    status: 'open',
    model: req.model,
    solution,
    markscheme: tag(out, 'markscheme') ?? ''
  }
  all().push(a)
  save()
  return view(a)
}

// ---------------------------------------------------------------- mark / reveal

export async function mark(req: { id: string; answer: string; images?: ImageAttachment[]; model: string; effort: Effort }) {
  const a = all().find((x) => x.id === req.id)
  if (!a) throw new Error('Question not found')
  if (!req.answer.trim() && !req.images?.length) throw new Error('Write an answer first, or attach a photo of your working.')

  const text = [
    `Total marks: ${a.marks}`,
    `Question:\n${a.question}`,
    `Mark scheme:\n${a.markscheme}`,
    `Reference solution:\n${a.solution}`,
    `Student's answer:\n${req.answer.trim() || '(see attached image of their working)'}`
  ].join('\n\n')

  const out = await ask(req.model, req.effort, MARK_SYSTEM, text, req.images ?? [])
  const raw = parseInt(tag(out, 'score') ?? '', 10)
  const feedback = tag(out, 'feedback')
  if (Number.isNaN(raw) || !feedback) throw new Error('The model didn’t return a mark. Try submitting again.')

  a.status = 'marked'
  a.answer = req.answer.trim()
  a.hadImages = !!req.images?.length
  a.score = Math.max(0, Math.min(a.marks, raw))
  a.feedback = feedback
  save()
  return view(a)
}

export function reveal(id: string) {
  const a = all().find((x) => x.id === id)
  if (!a) throw new Error('Question not found')
  if (a.status === 'open') {
    a.status = 'revealed'
    save()
  }
  return view(a)
}
