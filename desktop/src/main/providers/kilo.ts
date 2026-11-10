import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, dirOf, findBinary, run, runInTerminal, streamProcess, type StreamArgs, type StreamResult } from './common'

/*
 * Kilo Code CLI provider (@kilocode/cli).
 * Runs tasks headlessly via `kilo run --format json -m <model>`.
 */

export const KILO_MODELS: ModelOption[] = [
  { id: 'kilo:kilo-auto', provider: 'kilo', model: 'kilo-auto', label: 'Kilo Auto', desc: 'Optimal model routing across Kilo gateway' },
  { id: 'kilo:claude-sonnet-5-5', provider: 'kilo', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Kilo)', desc: 'High performance reasoning via Kilo' },
  { id: 'kilo:gpt-5.6-luna', provider: 'kilo', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (Kilo)', desc: 'Fast everyday math reasoning via Kilo' }
]

export async function findKilo(): Promise<string | null> {
  const home = homedir()
  const extras = [
    join(home, '.config/kilo/bin/kilo'),
    join(home, '.kilo/bin/kilo')
  ]
  return findBinary('kilo', extras)
}

function hasKiloConfig(): boolean {
  const home = homedir()
  return (
    existsSync(join(home, '.config/kilo')) ||
    existsSync(join(home, '.kilo'))
  )
}

export async function kiloStatus(): Promise<ProviderStatus> {
  const cli = await findKilo()
  const hasConfig = hasKiloConfig()

  if (!cli && !hasConfig) {
    return {
      provider: 'kilo',
      ok: false,
      canLogin: true,
      authCommand: 'kilo auth login',
      detectedPath: null,
      error: 'Install Kilo Code CLI: npm install -g @kilocode/cli (or curl -fsSL https://kilo.ai/install | bash)'
    }
  }

  if (cli) {
    try {
      const { stdout } = await run(cli, ['auth', 'list'], { env: cleanEnv(dirOf(cli)), timeout: 10000 })
      const hasAuth = stdout.trim().length > 0 && !/no providers|empty/i.test(stdout)
      return {
        provider: 'kilo',
        ok: hasAuth || hasConfig,
        plan: 'Kilo Code',
        canLogin: true,
        authCommand: 'kilo auth login',
        detectedPath: cli
      }
    } catch {
      /* ignore */
    }
  }

  return {
    provider: 'kilo',
    ok: hasConfig,
    plan: hasConfig ? 'Configured' : undefined,
    canLogin: true,
    authCommand: 'kilo auth login',
    detectedPath: cli
  }
}

export async function kiloLogin() {
  const cli = (await findKilo()) ?? 'kilo'
  await runInTerminal(`${cli} auth login`)
}

export async function streamKilo(a: StreamArgs): Promise<StreamResult> {
  const cli = await findKilo()
  if (!cli) {
    return {
      text: '',
      error: 'Kilo Code CLI not found. Run "kilo auth login" in Terminal to set up.',
      model: a.model
    }
  }

  const promptText = a.system
    ? `System Instructions:\n${a.system}\n\nProblem:\n${a.text}`
    : a.text

  return streamProcess({
    bin: cli,
    args: ['run', '--auto', '--format', 'json', '-m', a.model, promptText],
    env: cleanEnv(dirOf(cli)),
    abort: a.abort,
    model: a.model,
    onDelta: a.onDelta,
    onThinking: a.onThinking,
    parseJsonEvents: true
  })
}
