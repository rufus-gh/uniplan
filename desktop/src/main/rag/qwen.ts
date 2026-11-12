/*
 * Qwen3-Embedding-8B through Hack Club AI (an OpenAI-compatible proxy over
 * OpenRouter). No Electron imports, so it can be tested under plain Node.
 *
 * Vectors are 4096-d from the API; we keep the first QWEN_DIMS (Matryoshka
 * truncation) and re-normalise. On the MATH1116 library that kept top-5 recall
 * identical to full size at half the disk/memory.
 */

export const QWEN_MODEL = 'qwen/qwen3-embedding-8b'
export const QWEN_DIMS = 2048
const BATCH = 32

export const embedBase = () => process.env.LEMMA_EMBED_BASE || 'https://ai.hackclub.com/proxy/v1'

export class EmbedError extends Error {
  /** HTTP status, or 0 for network failures / timeouts. */
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
  /** The key was rejected: retrying won't help until it changes. */
  get auth() {
    return this.status === 401 || this.status === 403
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function normalise(v: number[]): Float32Array {
  const n = Math.min(QWEN_DIMS, v.length)
  const out = new Float32Array(n)
  let s = 0
  for (let i = 0; i < n; i++) {
    out[i] = v[i]
    s += v[i] * v[i]
  }
  s = Math.sqrt(s) || 1
  for (let i = 0; i < n; i++) out[i] /= s
  return out
}

async function request(texts: string[], key: string, timeoutMs: number): Promise<Float32Array[]> {
  let res: Response
  try {
    res = await fetch(`${embedBase()}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: QWEN_MODEL, input: texts, encoding_format: 'float' }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new EmbedError(timedOut ? 'Hack Club AI took too long to respond.' : 'Couldn’t reach Hack Club AI (offline?).')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const msg =
      res.status === 401 || res.status === 403
        ? 'Hack Club AI rejected the API key.'
        : res.status === 402 || res.status === 429
          ? 'Hack Club AI rate or budget limit reached (resets daily).'
          : `Hack Club AI error ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`
    throw new EmbedError(msg, res.status)
  }
  const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] }
  if (!json.data || json.data.length !== texts.length) throw new EmbedError('Hack Club AI returned an unexpected response.', 200)
  return json.data.sort((a, b) => a.index - b.index).map((d) => normalise(d.embedding))
}

export interface EmbedOpts {
  /** Per-request timeout. Queries want this short, indexing can wait. */
  timeoutMs: number
  /** Extra attempts for rate limits, server errors and network blips. */
  retries: number
  /** Called after each batch, for progress. */
  onBatch?(done: number, total: number): void
  /** Stop early (e.g. the user switched back to the local model). */
  cancelled?(): boolean
}

/** Embeds `texts`, batching and retrying. Throws EmbedError. */
export async function qwenEmbed(texts: string[], key: string, opts: EmbedOpts): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    if (opts.cancelled?.()) throw new EmbedError('Cancelled.')
    const batch = texts.slice(i, i + BATCH)
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await request(batch, key, opts.timeoutMs)))
        break
      } catch (e) {
        const err = e instanceof EmbedError ? e : new EmbedError(String(e))
        const retryable = !err.auth && (err.status === 0 || err.status === 429 || err.status >= 500)
        if (!retryable || attempt >= opts.retries) throw err
        await sleep(1500 * 2 ** attempt)
      }
    }
    opts.onBatch?.(Math.min(i + BATCH, texts.length), texts.length)
  }
  return out
}
