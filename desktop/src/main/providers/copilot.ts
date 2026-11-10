import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, dirOf, findBinary, run, runInTerminal, streamProcess, type StreamArgs, type StreamResult } from './common'

/*
 * GitHub Copilot provider. Runs via Copilot CLI or GitHub CLI (gh auth).
 */

export const COPILOT_MODELS: ModelOption[] = [
  { id: 'copilot:claude-sonnet-5-5', provider: 'copilot', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Copilot)', desc: 'Advanced coding & proofs via GitHub Copilot' },
  { id: 'copilot:gpt-5.6-luna', provider: 'copilot', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (Copilot)', desc: 'Balanced everyday reasoning via Copilot' },
  { id: 'copilot:o3-mini', provider: 'copilot', model: 'o3-mini', label: 'o3-mini (Copilot)', desc: 'Maths and STEM reasoning model' }
]

export async function findCopilot(): Promise<string | null> {
  return (await findBinary('copilot')) ?? (await findBinary('gh'))
}

function hasCopilotConfig(): boolean {
  const home = homedir()
  return (
    existsSync(join(home, '.config/github-copilot')) ||
    existsSync(join(home, '.config/gh/hosts.yml'))
  )
}

export async function copilotStatus(): Promise<ProviderStatus> {
  const bin = await findCopilot()
  const hasConfig = hasCopilotConfig()

  if (!bin && !hasConfig) {
    return {
      provider: 'copilot',
      ok: false,
      canLogin: true,
      authCommand: 'gh auth login',
      detectedPath: null,
      error: 'Install GitHub CLI or Copilot: brew install gh copilot-cli'
    }
  }

  // Check auth with gh auth status if gh is available
  const ghBin = await findBinary('gh')
  if (ghBin) {
    try {
      const { stdout, stderr } = await run(ghBin, ['auth', 'status'], { env: cleanEnv(dirOf(ghBin)), timeout: 10000 })
      const out = `${stdout}\n${stderr}`.toLowerCase()
      if (out.includes('logged in') && !out.includes('not logged in')) {
        return {
          provider: 'copilot',
          ok: true,
          plan: 'GitHub Copilot',
          canLogin: true,
          authCommand: 'gh auth login',
          detectedPath: bin
        }
      }
    } catch {
      /* not logged in or failed */
    }
  }

  return {
    provider: 'copilot',
    ok: hasConfig,
    plan: hasConfig ? 'Configured' : undefined,
    canLogin: true,
    authCommand: 'gh auth login',
    detectedPath: bin
  }
}

export async function copilotLogin() {
  const ghBin = await findBinary('gh')
  if (ghBin) {
    await runInTerminal(`${ghBin} auth login`)
  } else {
    const copilotBin = (await findBinary('copilot')) ?? 'copilot'
    await runInTerminal(`${copilotBin} /login`)
  }
}

export async function streamCopilot(a: StreamArgs): Promise<StreamResult> {
  const bin = await findBinary('copilot')
  if (!bin) {
    return {
      text: '',
      error: 'Copilot CLI not found. Run "gh auth login" or install copilot: brew install copilot-cli',
      model: a.model
    }
  }

  const promptText = a.system
    ? `System Instructions:\n${a.system}\n\nProblem:\n${a.text}`
    : a.text

  return streamProcess({
    bin,
    args: ['-s', '-p', promptText],
    env: cleanEnv(dirOf(bin)),
    abort: a.abort,
    model: a.model,
    onDelta: a.onDelta,
    onThinking: a.onThinking,
    parseJsonEvents: false
  })
}
