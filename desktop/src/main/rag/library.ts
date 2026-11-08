import { app } from 'electron'
import { copyFile, readdir, readFile, rm, stat, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Course, LibraryFile, LibraryState, SearchHit } from '../../shared/types'
import { chunk, kindOf, parseFile, SUPPORTED } from './parse'
import { embed, embedderState, loadEmbedder, onEmbedderState } from './embed'
import { findLabels, labelMatches, queryLabels, spellSymbols, stripLabels } from './labels'

/*
 * The course library: lecture notes and transcripts the user adds, indexed for
 * hybrid retrieval (BM25 keyword ranking + local semantic embeddings, fused
 * with reciprocal-rank fusion).
 *
 * Layout under <userData>/library:
 *   library.json          courses + file metadata
 *   files/<id><ext>       a copy of each original file
 *   chunks/<id>.json      extracted chunks (+ base64 Float32 vectors)
 */

interface ChunkRec {
  fileId: string
  courseId: string
  /** Position within its file, for pulling in the following chunk. */
  idx: number
  transcript: boolean
  text: string
  loc?: string
  tf: Map<string, number>
  len: number
  vec?: Float32Array
  /** Numbered statements in this chunk; `defining` = the statement itself, not a reference to it. */
  labels: { key: string; defining: boolean }[]
  /** Repeated across many files (e.g. a copyright notice read out at the start of every lecture). */
  boilerplate?: boolean
}

/** Bump when chunking/analysis changes; existing files are then re-indexed in the background. */
const INDEX_VERSION = 3

interface StoredChunks {
  chunks: { text: string; loc?: string }[]
  dims?: number
  vectors?: string
}

const root = () => join(app.getPath('userData'), 'library')
const metaPath = () => join(root(), 'library.json')
const filePath = (f: LibraryFile) => join(root(), 'files', `${f.id}${extname(f.name).toLowerCase()}`)
const chunkPath = (id: string) => join(root(), 'chunks', `${id}.json`)

let courses: Course[] = []
let files: LibraryFile[] = []
const index = new Map<string, ChunkRec[]>() // fileId -> chunks
let loaded: Promise<void> | null = null
let indexVersion = INDEX_VERSION
let listener: ((s: LibraryState) => void) | null = null

export function onLibraryChange(cb: (s: LibraryState) => void) {
  listener = cb
  onEmbedderState(() => listener?.(state()))
}

export function state(): LibraryState {
  return { courses, files, embedder: embedderState }
}

function changed() {
  listener?.(state())
}

async function saveMeta() {
  await mkdir(root(), { recursive: true })
  const tmp = `${metaPath()}.tmp`
  await writeFile(tmp, JSON.stringify({ version: indexVersion, courses, files }, null, 1))
  await rename(tmp, metaPath())
}

// ---------------------------------------------------------------- text analysis

const STOP = new Set(
  'a an and are as at be but by for from has have he her his how i if in into is it its of on or our she so that the their them then there these they this to was we were what when where which who why will with you your can do does did not no yes also just than too very'.split(
    ' '
  )
)

/** Suffixes stripped so related forms meet: converges/convergence/convergent -> converg. */
const SUFFIXES = ['ations', 'ation', 'ences', 'ence', 'ances', 'ance', 'ities', 'ity', 'ments', 'ment', 'ings', 'ing', 'ously', 'ous', 'ively', 'ive', 'ibly', 'ible', 'ably', 'able', 'edly', 'ed', 'ents', 'ent', 'ally', 'al', 'ly', 'ies', 'es', 's']

export function stem(t: string): string {
  for (const suf of SUFFIXES) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) {
      const base = t.slice(0, -suf.length)
      if (suf === 's' && (base.endsWith('s') || base.endsWith('u'))) return t // "class", "radius"
      return suf === 'ies' ? `${base}y` : base
    }
  }
  return t
}

export function tokenize(text: string): string[] {
  const out: string[] = []
  // Keep dotted numbers ("3.12") as tokens too, so references match exactly.
  for (const m of text.matchAll(/\b\d+(?:\.\d+)+\b/g)) out.push(m[0])
  for (const t of spellSymbols(text).toLowerCase().normalize('NFKD').split(/[^\p{L}\p{N}]+/u)) {
    if (!t || STOP.has(t)) continue
    out.push(stem(t))
  }
  return out
}

function termFreq(tokens: string[]) {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

function toRecs(f: LibraryFile, stored: StoredChunks): ChunkRec[] {
  let vecs: Float32Array | null = null
  if (stored.vectors && stored.dims) {
    const buf = Buffer.from(stored.vectors, 'base64')
    vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  }
  return stored.chunks.map((c, i) => {
    const tokens = tokenize(`${f.name} ${c.text}`)
    return {
      fileId: f.id,
      courseId: f.courseId,
      idx: i,
      transcript: f.kind === 'transcript',
      labels: findLabels(c.text).map(({ key, defining }) => ({ key, defining })),
      text: c.text,
      loc: c.loc,
      tf: termFreq(tokens),
      len: tokens.length,
      vec: vecs && stored.dims ? vecs.slice(i * stored.dims, (i + 1) * stored.dims) : undefined
    }
  })
}

// ---------------------------------------------------------------- loading

export function load(): Promise<void> {
  if (loaded) return loaded
  loaded = (async () => {
    try {
      const meta = JSON.parse(readFileSync(metaPath(), 'utf8')) as { courses: Course[]; files: LibraryFile[]; version?: number }
      courses = meta.courses ?? []
      files = meta.files ?? []
      indexVersion = meta.version ?? 1
    } catch {
      courses = []
      files = []
    }
    for (const f of files) {
      if (f.status !== 'ready') continue
      try {
        index.set(f.id, toRecs(f, JSON.parse(await readFile(chunkPath(f.id), 'utf8')) as StoredChunks))
      } catch {
        f.status = 'error'
        f.error = 'Index missing; remove and re-add this file.'
      }
    }
    markBoilerplate()
    // Indexed by an older version: re-index in the background. The old index
    // keeps answering searches until each file is replaced.
    if (indexVersion < INDEX_VERSION) {
      for (const f of files) if (f.status === 'ready' && existsSync(filePath(f))) f.status = 'queued'
      indexVersion = INDEX_VERSION
      await saveMeta()
    }
    // Files interrupted mid-index (app quit) are re-queued.
    const pending = files.filter((f) => f.status === 'queued' || f.status === 'indexing')
    for (const f of pending) f.status = 'queued'
    if (pending.length) void drain()
    // Warm the embedder if there's anything to search, then backfill any
    // chunks that were indexed while it was unavailable.
    if (files.length) void loadEmbedder().then((ok) => ok && backfillVectors())
    changed()
  })()
  return loaded
}

/** What the embedding model sees: the passage with maths symbols spelled out. */
const embedText = (t: string) => spellSymbols(t).replace(/\s+/g, ' ').trim()

/** Flags chunks whose opening text repeats across 3+ files (lecture-recording notices etc.). */
function markBoilerplate() {
  const key = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 80)
  const seen = new Map<string, Set<string>>()
  for (const [fid, recs] of index) {
    for (const r of recs) {
      const k = key(r.text)
      if (k.length < 40) continue
      if (!seen.has(k)) seen.set(k, new Set())
      seen.get(k)!.add(fid)
    }
  }
  for (const recs of index.values()) for (const r of recs) r.boilerplate = (seen.get(key(r.text))?.size ?? 0) >= 3
}

async function backfillVectors() {
  for (const f of files) {
    const recs = index.get(f.id)
    if (!recs?.length || recs[0].vec) continue
    const vecs = await embed(recs.map((r) => embedText(r.text)))
    if (!vecs) return
    recs.forEach((r, i) => (r.vec = vecs[i]))
    await persistChunks(f.id, recs)
  }
}

async function persistChunks(id: string, recs: ChunkRec[]) {
  const stored: StoredChunks = { chunks: recs.map((r) => ({ text: r.text, loc: r.loc })) }
  if (recs.length && recs.every((r) => r.vec)) {
    const dims = recs[0].vec!.length
    const all = new Float32Array(recs.length * dims)
    recs.forEach((r, i) => all.set(r.vec!, i * dims))
    stored.dims = dims
    stored.vectors = Buffer.from(all.buffer).toString('base64')
  }
  await mkdir(join(root(), 'chunks'), { recursive: true })
  await writeFile(chunkPath(id), JSON.stringify(stored))
}

// ---------------------------------------------------------------- courses

export async function createCourse(name: string): Promise<Course> {
  await load()
  const c: Course = { id: randomUUID(), name: name.trim() || 'Untitled course', createdAt: Date.now() }
  courses.push(c)
  await saveMeta()
  changed()
  return c
}

export async function renameCourse(id: string, name: string) {
  await load()
  const c = courses.find((x) => x.id === id)
  if (c && name.trim()) c.name = name.trim()
  await saveMeta()
  changed()
}

export async function deleteCourse(id: string) {
  await load()
  for (const f of files.filter((x) => x.courseId === id)) await removeFile(f.id, false)
  courses = courses.filter((c) => c.id !== id)
  await saveMeta()
  changed()
}

// ---------------------------------------------------------------- files

async function expand(paths: string[], depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    if (basename(p).startsWith('.')) continue
    let s
    try {
      s = await stat(p)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (depth < 5) out.push(...(await expand((await readdir(p)).map((n) => join(p, n)), depth + 1)))
    } else if ((SUPPORTED as readonly string[]).includes(extname(p).toLowerCase())) {
      out.push(p)
    }
  }
  return out
}

export async function addPaths(courseId: string, paths: string[]) {
  await load()
  if (!courses.some((c) => c.id === courseId)) throw new Error('Course not found')
  const found = await expand(paths)
  if (!found.length) throw new Error(`No supported files found. Lemma can index ${SUPPORTED.join(', ')}.`)
  await mkdir(join(root(), 'files'), { recursive: true })
  for (const p of found) {
    const s = await stat(p)
    const f: LibraryFile = {
      id: randomUUID(),
      courseId,
      name: basename(p),
      kind: kindOf(p),
      size: s.size,
      addedAt: Date.now(),
      status: 'queued',
      chunks: 0
    }
    await copyFile(p, filePath(f))
    files.push(f)
  }
  await saveMeta()
  changed()
  void drain()
}

let draining = false
async function drain() {
  if (draining) return
  draining = true
  try {
    let f: LibraryFile | undefined
    while ((f = files.find((x) => x.status === 'queued'))) {
      f.status = 'indexing'
      changed()
      try {
        const chunks = chunk(await parseFile(filePath(f)))
        if (!chunks.length) throw new Error('No text found (scanned PDFs need OCR first).')
        const recs = toRecs(f, { chunks })
        const vecs = await embed(recs.map((r) => embedText(r.text)))
        if (vecs) recs.forEach((r, i) => (r.vec = vecs[i]))
        if (!files.includes(f)) continue // removed while indexing
        await persistChunks(f.id, recs)
        index.set(f.id, recs)
        markBoilerplate()
        f.status = 'ready'
        f.chunks = recs.length
        f.error = undefined
      } catch (e) {
        f.status = 'error'
        f.error = e instanceof Error ? e.message : String(e)
      }
      await saveMeta()
      changed()
    }
  } finally {
    draining = false
  }
}

export async function removeFile(id: string, notify = true) {
  await load()
  const f = files.find((x) => x.id === id)
  if (!f) return
  files = files.filter((x) => x.id !== id)
  index.delete(id)
  await rm(filePath(f), { force: true })
  await rm(chunkPath(id), { force: true })
  if (notify) {
    await saveMeta()
    changed()
  }
}

export function storedPath(id: string): string | null {
  const f = files.find((x) => x.id === id)
  if (!f) return null
  const p = filePath(f)
  return existsSync(p) ? p : null
}

// ---------------------------------------------------------------- search

const K1 = 1.2
const B = 0.75
const RRF_K = 60
/** bge-small cosine similarity below which a notes passage is treated as unrelated. */
const MIN_COSINE = 0.6
/**
 * Lecture transcripts are long, noisy and conversational; the small embedding
 * model scores filler ("ok, so, right…") as similar to almost anything. They
 * need a stronger match, count for less, and are capped, unless the question
 * is about the lectures themselves.
 */
const TRANSCRIPT_WEIGHT = 0.6
const TRANSCRIPT_MIN_COSINE = 0.7
const DEFINITION_INTENT = /^\s*(what('?s| is| are)|define|definition|meaning of)\b/i
const LECTURE_INTENT = /\b(lecture|lecturer|said|say|says|mention(ed)?|class|recording|exam|examinable|assessment|test|quiz|week)\b/i

/** Words that say nothing about the topic ("explain … to me"). */
const GENERIC = new Set(tokenize('explain show prove proof tell help understand mean meaning what why how give me please about the this that it again simpler simple detail detailed step steps short shorter brief briefly sentence sentences paragraph words word line lines summary summarise summarize intuition intuitively example'))

const textKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 160)

/**
 * Hybrid search over a course ('all' = every course).
 *
 * 1. Numbered references in the question ("prop 3.12", "Theorem 2.4") are
 *    looked up directly: the chunk that states it comes first, followed by the
 *    next chunk of the same file (usually the proof/continuation).
 * 2. The rest is ranked by BM25 + embedding similarity (reciprocal-rank fusion),
 *    with transcripts down-weighted and capped, boilerplate dropped and
 *    near-duplicate passages (e.g. two versions of the same notes) merged.
 */
export async function search(query: string, courseId: string, k = 6): Promise<SearchHit[]> {
  await load()
  const cands: ChunkRec[] = []
  for (const [fid, recs] of index) {
    const f = files.find((x) => x.id === fid)
    if (f && (courseId === 'all' || f.courseId === courseId)) for (const r of recs) if (!r.boilerplate) cands.push(r)
  }
  if (!cands.length || !query.trim()) return []

  const picked: { c: ChunkRec; score: number }[] = []
  const has = (c: ChunkRec) => picked.some((p) => p.c === c || textKey(p.c.text) === textKey(c.text))
  const take = (c: ChunkRec | undefined, score: number) => {
    if (c && !c.boilerplate && !has(c)) picked.push({ c, score })
  }

  // 1. Exact references.
  const refs = queryLabels(query)
  if (refs.length) {
    const hits = cands
      .map((c) => {
        const ls = c.labels.filter((l) => refs.some((r) => labelMatches(r, l.key)))
        return { c, defining: ls.some((l) => l.defining), mentions: ls.length }
      })
      .filter((x) => x.mentions)
      // Statement first, notes before transcripts, earliest in the file.
      .sort((a, b) => +b.defining - +a.defining || +a.c.transcript - +b.c.transcript || a.c.idx - b.c.idx)
    for (const h of hits.filter((x) => x.defining).slice(0, 2)) {
      take(h.c, 1)
      take(index.get(h.c.fileId)?.[h.c.idx + 1], 0.95) // proof / rest of the statement
    }
    // No statement found (e.g. it's only referred to): use a couple of mentions.
    if (!picked.length) for (const h of hits.slice(0, 2)) take(h.c, 0.9)
  }

  // 2. Hybrid ranking. When a reference was found, rank on the rest of the
  // question only ("explain prop 3.12 to me" -> nothing left -> done), so the
  // word "proposition" doesn't pull in every other proposition.
  const rest = picked.length ? stripLabels(query) : query
  const terms = [...new Set(tokenize(rest))]
  if (picked.length && terms.filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t)).length < 2) return finish(picked)
  const avg = cands.reduce((s, c) => s + c.len, 0) / cands.length
  const idf = new Map<string, number>()
  for (const t of terms) {
    const df = cands.reduce((n, c) => n + (c.tf.has(t) ? 1 : 0), 0)
    idf.set(t, Math.log(1 + (cands.length - df + 0.5) / (df + 0.5)))
  }
  const bm25 = cands.map((c) => {
    let s = 0
    for (const t of terms) {
      const f = c.tf.get(t)
      if (f) s += idf.get(t)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.len) / avg)))
    }
    return s
  })

  let cos: number[] | null = null
  if (embedderState === 'ready' && cands.every((c) => c.vec)) {
    const q = (await embed([embedText(rest)], true))?.[0]
    if (q) {
      cos = cands.map((c) => {
        let s = 0
        for (let i = 0; i < q.length; i++) s += q[i] * c.vec![i]
        return s
      })
    }
  }

  const rank = (scores: number[]) => {
    const r = new Array<number>(scores.length)
    scores
      .map((s, i) => [s, i] as const)
      .sort((a, b) => b[0] - a[0])
      .forEach(([, i], pos) => (r[i] = pos))
    return r
  }
  const rb = rank(bm25)
  const rc = cos ? rank(cos) : null
  const maxBm = Math.max(...bm25)
  const lectureIntent = LECTURE_INTENT.test(rest)
  const definitionIntent = DEFINITION_INTENT.test(rest)
  const maxTranscripts = lectureIntent ? 4 : 2

  const ranked = cands
    .map((c, i) => {
      let fused = 1 / (RRF_K + rb[i]) + (rc ? 1 / (RRF_K + rc[i]) : 0)
      if (c.transcript && !lectureIntent) fused *= TRANSCRIPT_WEIGHT
      if (definitionIntent && c.labels.some((l) => l.defining && l.key.startsWith('definition'))) fused *= 1.35
      const lexical = bm25[i] > 0 && bm25[i] >= 0.3 * maxBm
      const relevant = cos
        ? c.transcript
          ? cos[i] >= (lectureIntent ? 0.65 : TRANSCRIPT_MIN_COSINE) && lexical // must also share real terms
          : cos[i] >= MIN_COSINE || (lexical && maxBm > 3 && bm25[i] >= 0.6 * maxBm)
        : bm25[i] > 0
      return { c, i, fused, relevant }
    })
    .filter((x) => x.relevant)
    .sort((a, b) => b.fused - a.fused)

  // After an exact reference, add at most two closely related passages.
  const limit = picked.length ? picked.length + 2 : k
  const perFile = new Map<string, number>()
  let transcripts = picked.filter((p) => p.c.transcript).length
  for (const x of ranked) {
    if (picked.length >= limit) break
    if (x.c.transcript && transcripts >= maxTranscripts) continue
    if ((perFile.get(x.c.fileId) ?? 0) >= 3) continue
    const before = picked.length
    take(x.c, cos ? cos[x.i] : bm25[x.i])
    if (picked.length > before) {
      perFile.set(x.c.fileId, (perFile.get(x.c.fileId) ?? 0) + 1)
      if (x.c.transcript) transcripts++
    }
  }

  return finish(picked)
}

function finish(picked: { c: ChunkRec; score: number }[]): SearchHit[] {
  return picked.map((p, n) => {
    const f = files.find((y) => y.id === p.c.fileId)!
    return {
      n: n + 1,
      fileId: f.id,
      fileName: f.name,
      courseId: f.courseId,
      location: p.c.loc,
      excerpt: p.c.text,
      score: p.score
    }
  })
}

export function courseName(id: string) {
  return id === 'all' ? 'All courses' : courses.find((c) => c.id === id)?.name
}
