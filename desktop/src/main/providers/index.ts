import type { ModelOption, Provider, ProviderStatus } from '../../shared/types'
import { CLAUDE_MODELS, claudeLogin, claudeStatus, streamClaude } from './claude'
import { openaiLogin, openaiModels, openaiStatus, streamOpenAI } from './openai'
import { GEMINI_MODELS, geminiLogin, geminiStatus, streamGemini } from './gemini'
import { OPENCODE_MODELS, opencodeLogin, opencodeStatus, streamOpenCode } from './opencode'
import { COPILOT_MODELS, copilotLogin, copilotStatus, streamCopilot } from './copilot'
import { VIBE_MODELS, vibeLogin, vibeStatus, streamVibe } from './vibe'
import { ollamaLogin, ollamaModels, ollamaStatus, streamOllama } from './ollama'
import { KILO_MODELS, kiloLogin, kiloStatus, streamKilo } from './kilo'
import { OPENROUTER_MODELS, openrouterLogin, openrouterStatus, streamOpenRouter } from './openrouter'
import { runInTerminal, type StreamArgs, type StreamResult } from './common'

export type { StreamArgs, StreamResult }

export async function listModels(): Promise<ModelOption[]> {
  const ollama = await ollamaModels()
  return [
    ...CLAUDE_MODELS,
    ...openaiModels(),
    ...GEMINI_MODELS,
    ...OPENCODE_MODELS,
    ...COPILOT_MODELS,
    ...VIBE_MODELS,
    ...ollama,
    ...KILO_MODELS,
    ...OPENROUTER_MODELS
  ]
}

export const DEFAULT_MODEL = CLAUDE_MODELS[0].id

export const VALID_PROVIDERS: Provider[] = [
  'claude',
  'openai',
  'gemini',
  'opencode',
  'copilot',
  'vibe',
  'ollama',
  'kilo',
  'openrouter'
]

/** Maps legacy ids ("opus") and unknown ids onto a current ModelOption id. */
export function normalizeModel(id: string | undefined): string {
  if (!id) return DEFAULT_MODEL
  const legacy: Record<string, string> = {
    opus: 'claude:claude-opus-5-5',
    sonnet: 'claude:claude-sonnet-5-5',
    haiku: 'claude:claude-haiku-5-5'
  }
  if (legacy[id]) return legacy[id]
  return id.includes(':') ? id : DEFAULT_MODEL
}

export function parseModel(id: string): { provider: Provider; model: string } {
  const norm = normalizeModel(id)
  const [provider, ...rest] = norm.split(':')
  const validProvider = VALID_PROVIDERS.includes(provider as Provider) ? (provider as Provider) : 'claude'
  return { provider: validProvider, model: rest.join(':') }
}

export async function providerStatus(): Promise<ProviderStatus[]> {
  return Promise.all([
    claudeStatus(),
    openaiStatus(),
    geminiStatus(),
    opencodeStatus(),
    copilotStatus(),
    vibeStatus(),
    ollamaStatus(),
    kiloStatus(),
    openrouterStatus()
  ])
}

export async function login(p: Provider, customCmd?: string): Promise<void> {
  if (customCmd?.trim()) {
    return runInTerminal(customCmd.trim())
  }
  switch (p) {
    case 'claude':
      return claudeLogin()
    case 'openai':
      return openaiLogin()
    case 'gemini':
      return geminiLogin()
    case 'opencode':
      return opencodeLogin()
    case 'copilot':
      return copilotLogin()
    case 'vibe':
      return vibeLogin()
    case 'ollama':
      return ollamaLogin()
    case 'kilo':
      return kiloLogin()
    case 'openrouter':
      return openrouterLogin()
  }
}

export function stream(provider: Provider, a: StreamArgs): Promise<StreamResult> {
  switch (provider) {
    case 'claude':
      return streamClaude(a)
    case 'openai':
      return streamOpenAI(a)
    case 'gemini':
      return streamGemini(a)
    case 'opencode':
      return streamOpenCode(a)
    case 'copilot':
      return streamCopilot(a)
    case 'vibe':
      return streamVibe(a)
    case 'ollama':
      return streamOllama(a)
    case 'kilo':
      return streamKilo(a)
    case 'openrouter':
      return streamOpenRouter(a)
  }
}
