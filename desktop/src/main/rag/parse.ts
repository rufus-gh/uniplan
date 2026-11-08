import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { statementStarts } from './labels'

/** File types the library can index. */
export const SUPPORTED = ['.pdf', '.txt', '.md', '.markdown', '.tex', '.vtt', '.srt', '.docx'] as const

export function kindOf(path: string) {
  const ext = extname(path).toLowerCase()
  if (ext === '.vtt' || ext === '.srt') return 'transcript'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  return ext.slice(1)
}

/** A unit of source text with where it came from (page, timestamp). */
export interface Unit {
  text: string
  page?: number
  time?: number // seconds
  /** Starts a numbered statement ("Proposition 3.12. …"). */
  statement?: boolean
}

export interface Chunk {
  text: string
  loc?: string
}

// ---------------------------------------------------------------- parsing

async function parsePdf(path: string): Promise<Unit[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const req = createRequire(import.meta.url)
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  const data = new Uint8Array(await readFile(path))
  const task = pdfjs.getDocument({ data, useSystemFonts: true })
  const doc = await task.promise
  const units: Unit[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        text += item.str
        text += item.hasEOL ? '\n' : ' '
      }
      for (const para of splitParagraphs(text)) units.push({ text: para, page: p })
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return units
}

function parseTimestamp(s: string) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?/.exec(s)
  if (!m) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function parseCues(raw: string): Unit[] {
  const units: Unit[] = []
  for (const block of raw.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i === -1) continue
    const text = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // WebVTT voice/style tags
      .replace(/\s+/g, ' ')
      .trim()
    if (text) units.push({ text, time: parseTimestamp(lines[i]) })
  }
  // Auto-captions often repeat the previous cue's text; drop exact repeats.
  return units.filter((u, i) => i === 0 || u.text !== units[i - 1].text)
}

function splitParagraphs(text: string) {
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
}

export async function parseFile(path: string): Promise<Unit[]> {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return parsePdf(path)
  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    const { value } = await (mammoth.default ?? mammoth).extractRawText({ path })
    return splitParagraphs(value).map((text) => ({ text }))
  }
  const raw = await readFile(path, 'utf8')
  if (ext === '.vtt' || ext === '.srt') return parseCues(raw)
  return splitParagraphs(raw).map((text) => ({ text }))
}

// ---------------------------------------------------------------- chunking

const TARGET = 1000
const OVERLAP = 180
/** Don't cut before a statement if the current chunk is still tiny. */
const MIN_BEFORE_STATEMENT = 250

function fmtTime(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function locOf(units: Unit[]) {
  const pages = units.map((u) => u.page).filter((p): p is number => p !== undefined)
  if (pages.length) {
    const a = Math.min(...pages)
    const b = Math.max(...pages)
    return a === b ? `p. ${a}` : `pp. ${a}–${b}`
  }
  const t = units.find((u) => u.time !== undefined)?.time
  return t !== undefined ? fmtTime(t) : undefined
}

/** Splits units so every numbered statement ("Theorem 2.4. …") begins its own unit. */
function splitAtStatements(units: Unit[]): Unit[] {
  const out: Unit[] = []
  for (const u of units) {
    const cuts = statementStarts(u.text).filter((i) => i > 0)
    let from = 0
    for (const at of cuts) {
      const head = u.text.slice(from, at).trim()
      if (head) out.push({ ...u, text: head, statement: from > 0 || statementStarts(head)[0] === 0 })
      from = at
    }
    const tail = u.text.slice(from).trim()
    if (tail) out.push({ ...u, text: tail, statement: from > 0 || statementStarts(tail)[0] === 0 })
  }
  return out
}

/** Splits units longer than the target size at sentence boundaries. */
function explode(units: Unit[]): Unit[] {
  const out: Unit[] = []
  for (const u of units) {
    if (u.text.length <= TARGET) {
      out.push(u)
      continue
    }
    let buf = ''
    let first = true
    for (const s of u.text.split(/(?<=[.!?])\s+/)) {
      if (buf && buf.length + s.length > TARGET) {
        out.push({ ...u, text: buf, statement: first && u.statement })
        first = false
        buf = ''
      }
      // A single huge "sentence" (e.g. a formula dump): hard-wrap it.
      for (let i = 0; i < s.length; i += TARGET) buf += (buf ? ' ' : '') + s.slice(i, i + TARGET)
    }
    if (buf) out.push({ ...u, text: buf, statement: first && u.statement })
  }
  return out
}

/**
 * Packs units into ~1000-character chunks with a little overlap. A numbered
 * statement starts a fresh chunk (no overlap carried in), so "Proposition 3.12"
 * and the text right after it stay together.
 */
export function chunk(units: Unit[]): Chunk[] {
  const parts = explode(splitAtStatements(units))
  const chunks: Chunk[] = []
  let cur: Unit[] = []
  let size = 0
  let fresh = false // whether `cur` holds text not yet in any chunk
  const flush = (carryOver: boolean) => {
    if (!cur.length) return
    if (fresh) chunks.push({ text: cur.map((u) => u.text).join('\n\n'), loc: locOf(cur) })
    fresh = false
    const carry: Unit[] = []
    let c = 0
    if (carryOver) {
      for (let i = cur.length - 1; i > 0 && c + cur[i].text.length <= OVERLAP; i--) {
        carry.unshift(cur[i])
        c += cur[i].text.length
      }
    }
    cur = carry
    size = c
  }
  for (const u of parts) {
    if (u.statement && fresh && size > MIN_BEFORE_STATEMENT) flush(false)
    else if (size && size + u.text.length > TARGET) flush(true)
    cur.push(u)
    size += u.text.length
    fresh = true
  }
  if (cur.length && fresh) chunks.push({ text: cur.map((u) => u.text).join('\n\n'), loc: locOf(cur) })
  // Drop scraps such as a lone running header on the last page.
  return chunks.filter((c) => c.text.replace(/[^\p{L}]/gu, '').length >= 40)
}
