import type { ModelOption, ProviderStatus } from '../../shared/types'
import { findBinary, runInTerminal, type StreamArgs, type StreamResult } from './common'

/*
 * Ollama provider for local open-source models.
 * Connects directly to the Ollama HTTP API (http://127.0.0.1:11434) with live streaming.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'

export const OLLAMA_FALLBACK_MODELS: ModelOption[] = [
  { id: 'ollama:llama3.3', provider: 'ollama', model: 'llama3.3', label: 'Llama 3.3 (Local)', desc: 'Meta open weights 70B model via local Ollama' },
  { id: 'ollama:qwen2.5-coder:32b', provider: 'ollama', model: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B (Local)', desc: 'Strong maths & code reasoning' },
  { id: 'ollama:deepseek-r1:14b', provider: 'ollama', model: 'deepseek-r1:14b', label: 'DeepSeek R1 14B (Local)', desc: 'Local reasoning & proof generation' }
]

let cachedOllamaModels: ModelOption[] | null = null
let lastFetchedAt = 0

export async function ollamaModels(): Promise<ModelOption[]> {
  const now = Date.now()
  if (cachedOllamaModels && now - lastFetchedAt < 30000) {
    return cachedOllamaModels
  }

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string; size?: number; details?: { parameter_size?: string } }> }
      if (data.models && data.models.length > 0) {
        cachedOllamaModels = data.models.map((m) => {
          const sizeGB = m.size ? `${(m.size / 1e9).toFixed(1)} GB` : ''
          const param = m.details?.parameter_size ? `${m.details.parameter_size}` : ''
          const desc = [param, sizeGB].filter(Boolean).join(' · ') || 'Local model'
          return {
            id: `ollama:${m.name}`,
            provider: 'ollama' as const,
            model: m.name,
            label: `${m.name}`,
            desc
          }
        })
        lastFetchedAt = now
        return cachedOllamaModels
      }
    }
  } catch {
    /* ollama not running or unreachable */
  }

  return OLLAMA_FALLBACK_MODELS
}

export async function findOllama(): Promise<string | null> {
  return findBinary('ollama', ['/Applications/Ollama.app/Contents/Resources/ollama'])
}

export async function ollamaStatus(): Promise<ProviderStatus> {
  const cli = await findOllama()

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/version`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = (await res.json()) as { version?: string }
      const models = await ollamaModels()
      return {
        provider: 'ollama',
        ok: true,
        plan: `Local daemon v${data.version ?? 'active'}`,
        canLogin: true,
        authCommand: 'ollama run llama3.3',
        detectedPath: cli ?? OLLAMA_HOST,
        modelCount: models.length
      }
    }
  } catch {
    /* server not running */
  }

  return {
    provider: 'ollama',
    ok: false,
    canLogin: true,
    authCommand: cli ? 'ollama serve' : 'ollama run llama3.3',
    detectedPath: cli,
    error: cli ? 'Ollama daemon is stopped. Run: ollama serve' : 'Install Ollama: https://ollama.com or brew install ollama'
  }
}

export async function ollamaLogin() {
  const cli = (await findOllama()) ?? 'ollama'
  await runInTerminal(`${cli} run llama3.3`)
}

export async function streamOllama(a: StreamArgs): Promise<StreamResult> {
  const imagesBase64: string[] = []
  for (const img of a.images) {
    const m = /^data:image\/(?:png|jpeg|gif|webp);base64,(.+)$/.exec(img.dataUrl)
    if (m) imagesBase64.push(m[1])
  }

  const messages: Array<{ role: string; content: string; images?: string[] }> = []
  if (a.system) {
    messages.push({ role: 'system', content: a.system })
  }
  messages.push({
    role: 'user',
    content: a.text,
    images: imagesBase64.length ? imagesBase64 : undefined
  })

  let out = ''
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: a.model,
        messages,
        stream: true
      }),
      signal: a.abort.signal
    })

    if (!res.ok) {
      const errText = await res.text()
      return { text: '', error: `Ollama error (${res.status}): ${errText}`, model: a.model }
    }

    if (!res.body) {
      return { text: '', error: 'Ollama returned an empty response body.', model: a.model }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const chunk = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean }
          const delta = chunk.message?.content
          if (delta) {
            out += delta
            a.onDelta(delta)
          }
        } catch {
          /* ignore incomplete line */
        }
      }
    }

    return { text: out, model: a.model, stopped: a.abort.signal.aborted }
  } catch (e) {
    if (a.abort.signal.aborted) {
      return { text: out, stopped: true, model: a.model }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return {
      text: out,
      error: `Could not connect to Ollama at ${OLLAMA_HOST}. Is it running? (${msg})`,
      model: a.model
    }
  }
}
