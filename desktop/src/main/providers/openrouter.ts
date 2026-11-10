import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, dirOf, findBinary, runInTerminal, streamProcess, type StreamArgs, type StreamResult } from './common'

/*
 * OpenRouter provider. Connects via OPENROUTER_API_KEY (or ~/.openrouter/key)
 * or through the openrouter CLI.
 */

export const OPENROUTER_MODELS: ModelOption[] = [
  { id: 'openrouter:anthropic/claude-3.5-sonnet', provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (OpenRouter)', desc: 'High capability reasoning via OpenRouter' },
  { id: 'openrouter:deepseek/deepseek-r1', provider: 'openrouter', model: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (OpenRouter)', desc: 'Open reasoning model via OpenRouter' },
  { id: 'openrouter:google/gemini-2.5-pro', provider: 'openrouter', model: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (OpenRouter)', desc: 'Multimodal math & proofs via OpenRouter' },
  { id: 'openrouter:openai/gpt-4o', provider: 'openrouter', model: 'openai/gpt-4o', label: 'GPT-4o (OpenRouter)', desc: 'Versatile tutor via OpenRouter' }
]

function getOpenRouterApiKey(): string | null {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim()
  const keyPath = join(homedir(), '.openrouter/key')
  if (existsSync(keyPath)) {
    try {
      const k = readFileSync(keyPath, 'utf8').trim()
      if (k) return k
    } catch {
      /* ignore */
    }
  }
  return null
}

export async function findOpenRouterCli(): Promise<string | null> {
  return findBinary('openrouter')
}

export async function openrouterStatus(): Promise<ProviderStatus> {
  const key = getOpenRouterApiKey()
  const cli = await findOpenRouterCli()

  if (key) {
    return {
      provider: 'openrouter',
      ok: true,
      plan: 'API Key Active',
      canLogin: true,
      authCommand: 'openrouter login',
      detectedPath: cli ?? 'API Key'
    }
  }

  if (cli) {
    return {
      provider: 'openrouter',
      ok: true,
      plan: 'CLI Ready',
      canLogin: true,
      authCommand: 'openrouter login',
      detectedPath: cli
    }
  }

  return {
    provider: 'openrouter',
    ok: false,
    canLogin: true,
    authCommand: 'openrouter login',
    detectedPath: null,
    error: 'Set OPENROUTER_API_KEY or install CLI: npm install -g @aaronjmars/openroutercli'
  }
}

export async function openrouterLogin() {
  const cli = (await findOpenRouterCli()) ?? 'openrouter'
  await runInTerminal(`${cli} login`)
}

export async function streamOpenRouter(a: StreamArgs): Promise<StreamResult> {
  const key = getOpenRouterApiKey()
  const cli = await findOpenRouterCli()

  // Use HTTP API if key is present
  if (key) {
    let out = ''
    try {
      const messages: Array<{ role: string; content: string }> = []
      if (a.system) messages.push({ role: 'system', content: a.system })
      messages.push({ role: 'user', content: a.text })

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://lemma.local',
          'X-Title': 'Lemma'
        },
        body: JSON.stringify({
          model: a.model,
          messages,
          stream: true
        }),
        signal: a.abort.signal
      })

      if (!res.ok) {
        const errText = await res.text()
        return { text: '', error: `OpenRouter API error (${res.status}): ${errText}`, model: a.model }
      }

      const reader = res.body?.getReader()
      if (!reader) return { text: '', error: 'OpenRouter returned empty stream body', model: a.model }

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
          if (!trimmed.startsWith('data:')) continue
          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') break
          try {
            const parsed = JSON.parse(dataStr) as { choices?: Array<{ delta?: { content?: string } }> }
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) {
              out += delta
              a.onDelta(delta)
            }
          } catch {
            /* ignore partial JSON */
          }
        }
      }

      return { text: out, model: a.model, stopped: a.abort.signal.aborted }
    } catch (e) {
      if (a.abort.signal.aborted) return { text: out, stopped: true, model: a.model }
      return { text: out, error: e instanceof Error ? e.message : String(e), model: a.model }
    }
  }

  // Fallback to CLI if installed
  if (cli) {
    const promptText = a.system ? `${a.system}\n\n${a.text}` : a.text
    return streamProcess({
      bin: cli,
      args: ['chat', promptText, '-m', a.model],
      env: cleanEnv(dirOf(cli)),
      abort: a.abort,
      model: a.model,
      onDelta: a.onDelta,
      onThinking: a.onThinking,
      parseJsonEvents: false
    })
  }

  return {
    text: '',
    error: 'OpenRouter authentication required. Run "openrouter login" in Terminal or set OPENROUTER_API_KEY.',
    model: a.model
  }
}
