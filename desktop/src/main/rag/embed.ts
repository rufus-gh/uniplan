import { app } from 'electron'
import { join } from 'node:path'
import type { EmbedderKind, LibraryState } from '../../shared/types'
import { getApiKey, getEmbedderKind } from '../settings'
import { EmbedError, qwenEmbed } from './qwen'

/*
 * Semantic embeddings for course notes. Two interchangeable models:
 *
 *   local  bge-small (~33 MB, downloaded once from Hugging Face), runs on this
 *          Mac with onnxruntime. Works offline.
 *   qwen   Qwen3-Embedding-8B through Hack Club AI. More accurate on the notes,
 *          but needs internet and an API key, and each question costs a
 *          network round trip.
 *
 * Whichever is selected, if it can't produce vectors, search falls back to
 * keyword (BM25) ranking only.
 */

const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5'
const LOCAL_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

/** Cosine similarity below which a passage is treated as unrelated, per model. */
export interface Cutoffs {
  /** Notes, worksheets, slides. */
  notes: number
  /** Lecture transcripts when the question is about the lectures themselves. */
  lecture: number
  /** Lecture transcripts otherwise. */
  transcript: number
}
export const CUTOFFS: Record<EmbedderKind, Cutoffs> = {
  // Tuned for bge-small, which scores even unrelated text fairly high.
  local: { notes: 0.6, lecture: 0.65, transcript: 0.7 },
  // Qwen separates related (~0.73 median) from unrelated (~0.38 median, 0.57 at the 95th percentile)
  // more widely; cutoffs are kept just under the weakest relevant matches seen on a real course.
  qwen: { notes: 0.55, lecture: 0.6, transcript: 0.65 }
}

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>

let kind: EmbedderKind = 'local'
let generation = 0 // bumped on every switch so stale work can notice
let extractor: Extractor | null = null
let loading: Promise<Extractor | null> | null = null
let error: string | undefined
const queryCache = new Map<string, Float32Array>() // recent query vectors (Qwen: saves a network round trip)
let rejectedKey: string | null = null // a key the API refused; not retried until it changes
export let embedderState: LibraryState['embedder'] = 'idle'
let onState: (() => void) | null = null

export function onEmbedderState(cb: () => void) {
  onState = cb
}

function setState(s: LibraryState['embedder'], err?: string) {
  embedderState = s
  error = err
  onState?.()
}

export const activeKind = () => kind
export const embedGeneration = () => generation
export const embedError = () => error

/** Selects the model from saved settings (call once at startup). */
export function initEmbedder() {
  kind = getEmbedderKind()
  setState('idle')
}

/** Switches model. Returns false if it was already selected. */
export function selectEmbedder(next: EmbedderKind): boolean {
  if (next === kind) return false
  kind = next
  generation++
  queryCache.clear()
  setState('idle')
  return true
}

async function loadLocal(): Promise<Extractor | null> {
  if (extractor) return extractor
  if (loading) return loading
  setState('loading')
  loading = (async () => {
    try {
      const t = await import('@huggingface/transformers')
      t.env.cacheDir = join(app.getPath('userData'), 'models')
      t.env.allowLocalModels = true
      extractor = (await t.pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'q8' })) as unknown as Extractor
      if (kind === 'local') setState('ready')
      return extractor
    } catch (e) {
      console.error('[lemma] embedding model unavailable, using keyword search only:', e)
      if (kind === 'local') setState('unavailable', 'The local search model couldn’t load (it downloads once, so it needs internet the first time).')
      return null
    } finally {
      loading = null // allow a retry later (e.g. when back online)
    }
  })()
  return loading
}

/** Prepares the selected model. Resolves true when it can embed. */
export async function loadEmbedder(): Promise<boolean> {
  if (kind === 'qwen') {
    const key = getApiKey()
    if (!key) {
      setState('unavailable', 'Add your Hack Club AI key in Settings to use Qwen3.')
      return false
    }
    if (key === rejectedKey) {
      setState('unavailable', 'Hack Club AI rejected the API key.')
      return false
    }
    if (embedderState !== 'ready') setState('ready')
    return true
  }
  return !!(await loadLocal())
}

/**
 * Embeds texts into L2-normalised vectors with the selected model, or returns
 * null if it can't (offline, bad key, model missing). `query` marks a search
 * query (local model prefix; short timeout and no retries for Qwen).
 */
export async function embed(
  texts: string[],
  query = false,
  progress?: (done: number, total: number) => void
): Promise<Float32Array[] | null> {
  const gen = generation
  if (kind === 'qwen') {
    const cacheKey = query && texts.length === 1 ? texts[0] : null
    const hit = cacheKey !== null ? queryCache.get(cacheKey) : undefined
    if (hit) return [hit]
    const key = getApiKey()
    if (!key) {
      setState('unavailable', 'Add your Hack Club AI key in Settings to use Qwen3.')
      return null
    }
    if (key === rejectedKey) return null
    try {
      const out = await qwenEmbed(texts, key, {
        timeoutMs: query ? 8000 : 60000,
        retries: query ? 0 : 4,
        onBatch: progress,
        cancelled: () => gen !== generation
      })
      if (gen === generation && embedderState !== 'ready') setState('ready')
      if (gen === generation && cacheKey !== null) {
        queryCache.set(cacheKey, out[0])
        if (queryCache.size > 64) queryCache.delete(queryCache.keys().next().value!)
      }
      return gen === generation ? out : null
    } catch (e) {
      if (gen !== generation) return null
      const err = e instanceof EmbedError ? e : new EmbedError(String(e))
      console.error('[lemma] Qwen embedding failed:', err.message)
      // A rejected key stays unavailable until it changes; a network blip doesn't stick.
      if (err.auth) {
        rejectedKey = key
        setState('unavailable', err.message)
      } else {
        error = err.message
        onState?.()
      }
      return null
    }
  }
  const ex = await loadLocal()
  if (!ex || gen !== generation) return null
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => (query ? LOCAL_QUERY_PREFIX + t : t))
    const res = await ex(batch, { pooling: 'cls', normalize: true })
    for (const v of res.tolist()) out.push(Float32Array.from(v))
    progress?.(Math.min(i + 16, texts.length), texts.length)
  }
  return out
}

/** Quick end-to-end check of a key. Doesn't touch the saved state. */
export async function testQwenKey(key: string): Promise<{ ok: boolean; error?: string; ms?: number }> {
  const t0 = Date.now()
  try {
    await qwenEmbed(['connection test'], key, { timeoutMs: 15000, retries: 1 })
    return { ok: true, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
