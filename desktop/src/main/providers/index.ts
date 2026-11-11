import type { ModelOption, Provider, ProviderStatus } from '../../shared/types'
import { CLAUDE_MODELS, claudeLogin, claudeStatus, streamClaude } from './claude'
import { openaiLogin, openaiModels, openaiStatus, streamOpenAI } from './openai'
import { runInTerminal, type StreamArgs, type StreamResult } from './common'

export type { StreamArgs, StreamResult }

export async function listModels(): Promise<ModelOption[]> {
  return [...CLAUDE_MODELS, ...openaiModels()]
}

export const DEFAULT_MODEL = CLAUDE_MODELS[0].id

export const VALID_PROVIDERS: Provider[] = ['claude', 'openai']

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
  return Promise.all([claudeStatus(), openaiStatus()])
}

export async function login(p: Provider, customCmd?: string): Promise<void> {
  if (customCmd?.trim()) {
    return runInTerminal(customCmd.trim())
  }
  return p === 'openai' ? openaiLogin() : claudeLogin()
}

export function stream(provider: Provider, a: StreamArgs): Promise<StreamResult> {
  return provider === 'openai' ? streamOpenAI(a) : streamClaude(a)
}
