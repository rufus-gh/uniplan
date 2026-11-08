import type { ModelOption, Provider, ProviderStatus } from '../../shared/types'
import { CLAUDE_MODELS, claudeLogin, claudeStatus, streamClaude } from './claude'
import { openaiLogin, openaiModels, openaiStatus, streamOpenAI } from './openai'
import type { StreamArgs, StreamResult } from './common'

export type { StreamArgs, StreamResult }

export function listModels(): ModelOption[] {
  return [...CLAUDE_MODELS, ...openaiModels()]
}

export const DEFAULT_MODEL = CLAUDE_MODELS[0].id

/** Maps legacy ids ("opus") and unknown ids onto a current ModelOption id. */
export function normalizeModel(id: string | undefined): string {
  if (!id) return DEFAULT_MODEL
  const legacy: Record<string, string> = { opus: 'claude:claude-opus-5-5', sonnet: 'claude:claude-sonnet-5-5', haiku: 'claude:claude-haiku-5-5' }
  if (legacy[id]) return legacy[id]
  return id.includes(':') ? id : DEFAULT_MODEL
}

export function parseModel(id: string): { provider: Provider; model: string } {
  const [provider, ...rest] = normalizeModel(id).split(':')
  return { provider: provider === 'openai' ? 'openai' : 'claude', model: rest.join(':') }
}

export async function providerStatus(): Promise<ProviderStatus[]> {
  return Promise.all([claudeStatus(), openaiStatus()])
}

export function login(p: Provider) {
  return p === 'openai' ? openaiLogin() : claudeLogin()
}

export function stream(provider: Provider, a: StreamArgs): Promise<StreamResult> {
  return provider === 'openai' ? streamOpenAI(a) : streamClaude(a)
}
