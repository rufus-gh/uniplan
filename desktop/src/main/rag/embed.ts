import { app } from 'electron'
import { join } from 'node:path'
import type { LibraryState } from '../../shared/types'

/*
 * Local sentence embeddings (bge-small, ~33 MB, downloaded once from Hugging
 * Face into the app's data folder). Runs fully on-device with onnxruntime.
 * If it can't load, search falls back to keyword (BM25) ranking only.
 */

const MODEL = 'Xenova/bge-small-en-v1.5'
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>

let extractor: Extractor | null = null
let loading: Promise<Extractor | null> | null = null
export let embedderState: LibraryState['embedder'] = 'idle'
let onState: (() => void) | null = null

export function onEmbedderState(cb: () => void) {
  onState = cb
}

function setState(s: LibraryState['embedder']) {
  embedderState = s
  onState?.()
}

export function loadEmbedder(): Promise<Extractor | null> {
  if (extractor) return Promise.resolve(extractor)
  if (loading) return loading
  setState('loading')
  loading = (async () => {
    try {
      const t = await import('@huggingface/transformers')
      t.env.cacheDir = join(app.getPath('userData'), 'models')
      t.env.allowLocalModels = true
      extractor = (await t.pipeline('feature-extraction', MODEL, { dtype: 'q8' })) as unknown as Extractor
      setState('ready')
      return extractor
    } catch (e) {
      console.error('[lemma] embedding model unavailable, using keyword search only:', e)
      setState('unavailable')
      loading = null // allow a retry later (e.g. when back online)
      return null
    }
  })()
  return loading
}

/** Embeds texts into L2-normalised vectors, or returns null if the model is unavailable. */
export async function embed(texts: string[], query = false): Promise<Float32Array[] | null> {
  const ex = await loadEmbedder()
  if (!ex) return null
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => (query ? QUERY_PREFIX + t : t))
    const res = await ex(batch, { pooling: 'cls', normalize: true })
    for (const v of res.tolist()) out.push(Float32Array.from(v))
  }
  return out
}
