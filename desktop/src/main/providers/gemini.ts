import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, dirOf, findBinary, run, runInTerminal, streamProcess, type StreamArgs, type StreamResult } from './common'

/*
 * Gemini models run through the Google Antigravity CLI (agy).
 * agy manages credentials and routes to Gemini with full tool and reasoning support.
 */

export const GEMINI_MODELS: ModelOption[] = [
  { id: 'gemini:gemini-2.5-pro', provider: 'gemini', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', desc: 'Complex reasoning & mathematical proofs' },
  { id: 'gemini:gemini-2.5-flash', provider: 'gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Fast, versatile tutor for problems & derivations' },
  { id: 'gemini:gemini-2.5-flash-lite', provider: 'gemini', model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', desc: 'Fastest response for quick checks' }
]

export async function findAgy(): Promise<string | null> {
  const home = homedir()
  const extras = [
    join(home, '.gemini/antigravity-cli/bin/agy'),
    join(home, '.gemini/bin/agy'),
    join(home, '.antigravity/bin/agy')
  ]
  return findBinary('agy', extras)
}

export async function geminiStatus(): Promise<ProviderStatus> {
  const cli = await findAgy()
  if (!cli) {
    return {
      provider: 'gemini',
      ok: false,
      canLogin: true,
      authCommand: 'agy auth login',
      detectedPath: null,
      error: 'Install Google Antigravity CLI: curl -fsSL https://antigravity.google/install | bash'
    }
  }

  try {
    const { stdout, stderr } = await run(cli, ['auth', 'status'], { env: cleanEnv(dirOf(cli)), timeout: 10000 })
    const combined = `${stdout}\n${stderr}`.toLowerCase()
    const loggedIn = combined.includes('logged in') || combined.includes('authenticated') || combined.includes('active')
    return {
      provider: 'gemini',
      ok: loggedIn || !combined.includes('not logged in'),
      plan: 'Antigravity',
      canLogin: true,
      authCommand: 'agy auth login',
      detectedPath: cli
    }
  } catch {
    // If agy exists, we can still attempt login or use it
    return {
      provider: 'gemini',
      ok: false,
      canLogin: true,
      authCommand: 'agy auth login',
      detectedPath: cli,
      error: 'Sign in to Google Antigravity with: agy auth login'
    }
  }
}

export async function geminiLogin() {
  const cli = (await findAgy()) ?? 'agy'
  await runInTerminal(`${cli} auth login`)
}

export async function streamGemini(a: StreamArgs): Promise<StreamResult> {
  const cli = await findAgy()
  if (!cli) {
    return {
      text: '',
      error: 'Google Antigravity CLI (agy) not found. Run "agy auth login" in Terminal to install & authenticate.',
      model: a.model
    }
  }

  const promptText = a.system
    ? `Instructions for maths tutor:\n${a.system}\n\nStudent problem:\n${a.text}`
    : a.text

  // Try streaming with json events first, fall back to plain text streaming if needed
  const res = await streamProcess({
    bin: cli,
    args: ['--output-format', 'stream-json', '-p', promptText, '-m', a.model],
    env: cleanEnv(dirOf(cli)),
    abort: a.abort,
    model: a.model,
    onDelta: a.onDelta,
    onThinking: a.onThinking,
    parseJsonEvents: true
  })

  if (res.error && !res.text && /unrecognized|unknown option|--output-format/i.test(res.error)) {
    return streamProcess({
      bin: cli,
      args: ['-p', promptText, '-m', a.model],
      env: cleanEnv(dirOf(cli)),
      abort: a.abort,
      model: a.model,
      onDelta: a.onDelta,
      onThinking: a.onThinking,
      parseJsonEvents: false
    })
  }

  return res
}
