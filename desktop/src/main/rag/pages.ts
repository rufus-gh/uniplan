import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageAttachment, Source } from '../../shared/types'
import { storedPath } from './library'

/*
 * Extracted PDF text mangles formulas ("∑ ∞ j =0 x j"). For the PDF pages a
 * reply cites, we render the real page to an image so the model can read the
 * maths exactly. Rendered pages are cached on disk.
 */

const MAX_PAGES = 3
const SCALE = 1.6 // ~1000px wide for an A4 page: legible, modest token cost

const cacheDir = () => {
  const d = join(app.getPath('userData'), 'pages')
  mkdirSync(d, { recursive: true })
  return d
}

/** "p. 32" -> [32], "pp. 32–33" -> [32, 33] */
function pagesOf(loc?: string): number[] {
  const m = loc?.match(/pp?\.\s*(\d+)(?:\s*[–-]\s*(\d+))?/)
  if (!m) return []
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  return b - a <= 1 ? [a, b].filter((v, i, arr) => arr.indexOf(v) === i) : [a]
}

async function render(fileId: string, pdfPath: string, page: number): Promise<string | null> {
  const out = join(cacheDir(), `${fileId}-p${page}.png`)
  if (!existsSync(out)) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdfPath)), useSystemFonts: true })
    try {
      const doc = await task.promise
      if (page < 1 || page > doc.numPages) return null
      const p = await doc.getPage(page)
      const viewport = p.getViewport({ scale: SCALE })
      const { createCanvas } = await import('@napi-rs/canvas')
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await p.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise
      writeFileSync(out, canvas.toBuffer('image/png'))
    } finally {
      await task.destroy()
    }
  }
  return `data:image/png;base64,${readFileSync(out).toString('base64')}`
}

/** Page images for the top PDF sources (deduped, at most MAX_PAGES). */
export async function pageImages(sources: Source[]): Promise<{ images: ImageAttachment[]; labels: string[] }> {
  const images: ImageAttachment[] = []
  const labels: string[] = []
  const seen = new Set<string>()
  for (const s of sources) {
    if (!/\.pdf$/i.test(s.fileName)) continue
    const path = storedPath(s.fileId)
    if (!path) continue
    for (const page of pagesOf(s.location)) {
      const key = `${s.fileId}:${page}`
      if (seen.has(key) || images.length >= MAX_PAGES) continue
      seen.add(key)
      try {
        const dataUrl = await render(s.fileId, path, page)
        if (dataUrl) {
          images.push({ dataUrl, name: `${s.fileName} p. ${page}` })
          labels.push(`${s.fileName} p. ${page} (excerpt [${s.n}])`)
        }
      } catch (e) {
        console.error('[lemma] page render failed', s.fileName, page, e)
      }
    }
  }
  return { images, labels }
}
