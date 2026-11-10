import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, dirOf, findBinary, run, runInTerminal, streamProcess, type StreamArgs, type StreamResult } from './common'

/*
 * OpenCode CLI provider. Uses credentials stored in ~/.local/share/opencode/auth.json
 * and streams non-interactive runs via `opencode run --format json`.
 */

export const OPENCODE_MODELS: ModelOption[] = [
  { id: 'opencode:claude-sonnet-5-5', provider: 'opencode', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (OpenCode)', desc: 'High capability via OpenCode' },
  { id: 'opencode:gpt-5-pro', provider: 'opencode', model: 'gpt-5-pro', label: 'GPT-5 Pro (OpenCode)', desc: 'Deep reasoning via OpenCode' },
  { id: 'opencode:deepseek-r1', provider: 'opencode', model: 'deepseek-r1', label: 'DeepSeek R1 (OpenCode)', desc: 'Open reasoning model via OpenCode' }
]

export async function findOpenCode(): Promise<string | null> {
  const home = homedir()
  const extras = [
    join(home, '.opencode/bin/opencode'),
    join(home, '.local/share/opencode/bin/opencode')
  ]
  return findBinary('opencode', extras)
}

function hasOpenCodeAuth(): boolean {
  const p = join(homedir(), '.local/share/opencode/auth.json')
  return existsSync(p)
}

export async function opencodeStatus(): Promise<ProviderStatus> {
  const cli = await findOpenCode()
  const authFileExists = hasOpenCodeAuth()

  if (!cli && !authFileExists) {
    return {
      provider: 'opencode',
      ok: false,
      canLogin: true,
      authCommand: 'opencode auth login',
      detectedPath: null,
      error: 'Install OpenCode CLI: curl -fsSL https://opencode.ai/install | bash'
    }
  }

  if (cli) {
    try {
      const { stdout } = await run(cli, ['auth', 'list'], { env: cleanEnv(dirOf(cli)), timeout: 10000 })
      const hasAccounts = stdout.trim().length > 0 && !/no accounts|empty/i.test(stdout)
      return {
        provider: 'opencode',
        ok: hasAccounts || authFileExists,
        plan: 'OpenCode',
        canLogin: true,
        authCommand: 'opencode auth login',
        detectedPath: cli
      }
    } catch {
      /* fall back to auth file check */
    }
  }

  return {
    provider: 'opencode',
    ok: authFileExists,
    plan: authFileExists ? 'Configured' : undefined,
    canLogin: true,
    authCommand: 'opencode auth login',
    detectedPath: cli
  }
}

export async function opencodeLogin() {
  const cli = (await findOpenCode()) ?? 'opencode'
  await runInTerminal(`${cli} auth login`)
}

export async function streamOpenCode(a: StreamArgs): Promise<StreamResult> {
  const cli = await findOpenCode()
  if (!cli) {
    return {
      text: '',
      error: 'OpenCode CLI not found. Run "opencode auth login" in Terminal to set up.',
      model: a.model
    }
  }

  const promptText = a.system
    ? `Instructions for maths tutor:\n${a.system}\n\nProblem:\n${a.text}`
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
