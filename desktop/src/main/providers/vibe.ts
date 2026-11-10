import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, dirOf, findBinary, run, runInTerminal, streamProcess, type StreamArgs, type StreamResult } from './common'

/*
 * Mistral Vibe CLI provider.
 * Runs non-interactively with `vibe -p <prompt> --auto-approve`.
 */

export const VIBE_MODELS: ModelOption[] = [
  { id: 'vibe:mistral-large', provider: 'vibe', model: 'mistral-large', label: 'Mistral Large', desc: 'Flagship reasoning for complex maths & proofs' },
  { id: 'vibe:devstral', provider: 'vibe', model: 'devstral', label: 'Devstral', desc: 'Code & STEM reasoning model' },
  { id: 'vibe:codestral', provider: 'vibe', model: 'codestral', label: 'Codestral', desc: 'Fast, lightweight tutor assistant' }
]

export async function findVibe(): Promise<string | null> {
  const home = homedir()
  const extras = [
    join(home, '.vibe/bin/vibe'),
    join(home, '.local/bin/vibe')
  ]
  return findBinary('vibe', extras)
}

function hasVibeConfig(): boolean {
  return existsSync(join(homedir(), '.vibe/.env')) || existsSync(join(homedir(), '.config/vibe'))
}

export async function vibeStatus(): Promise<ProviderStatus> {
  const cli = await findVibe()
  const hasConfig = hasVibeConfig()

  if (!cli && !hasConfig) {
    return {
      provider: 'vibe',
      ok: false,
      canLogin: true,
      authCommand: 'vibe --setup',
      detectedPath: null,
      error: 'Install Mistral Vibe CLI: pip install mistral-vibe (or curl -fsSL https://mistral.ai/vibe | bash)'
    }
  }

  if (cli) {
    try {
      const { stdout, stderr } = await run(cli, ['--version'], { env: cleanEnv(dirOf(cli)), timeout: 8000 })
      const out = `${stdout}\n${stderr}`.toLowerCase()
      if (out.includes('vibe') || out.includes('mistral')) {
        return {
          provider: 'vibe',
          ok: true,
          plan: 'Mistral Vibe',
          canLogin: true,
          authCommand: 'vibe --setup',
          detectedPath: cli
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    provider: 'vibe',
    ok: hasConfig,
    plan: hasConfig ? 'Configured' : undefined,
    canLogin: true,
    authCommand: 'vibe --setup',
    detectedPath: cli
  }
}

export async function vibeLogin() {
  const cli = (await findVibe()) ?? 'vibe'
  await runInTerminal(`${cli} --setup`)
}

export async function streamVibe(a: StreamArgs): Promise<StreamResult> {
  const cli = await findVibe()
  if (!cli) {
    return {
      text: '',
      error: 'Mistral Vibe CLI not found. Run "vibe --setup" in Terminal to configure.',
      model: a.model
    }
  }

  const promptText = a.system
    ? `System instructions:\n${a.system}\n\nStudent question:\n${a.text}`
    : a.text

  return streamProcess({
    bin: cli,
    args: ['-p', promptText, '--auto-approve'],
    env: cleanEnv(dirOf(cli)),
    abort: a.abort,
    model: a.model,
    onDelta: a.onDelta,
    onThinking: a.onThinking,
    parseJsonEvents: false
  })
}
