import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Effort, ImageAttachment } from '../../shared/types'

export const run = promisify(execFile)

export interface StreamArgs {
  /** Provider-specific model id, e.g. "claude-opus-5-5" or "gpt-6-luna". */
  model: string
  system: string
  text: string
  images: ImageAttachment[]
  resume?: string
  abort: AbortController
  /** Claude only: reasoning effort. */
  effort?: Effort
  /**
   * When set, the model may search the course notes itself (Claude only).
   * Returns text to hand back to the model.
   */
  searchNotes?: (query: string) => Promise<string>
  /** When set, the model may run Python to check its working (Claude only). */
  runPython?: (code: string) => Promise<string>
  onStatus?(text: string): void
  onSession(id: string): void
  onDelta(text: string): void
  onThinking(): void
}

export interface StreamResult {
  text: string
  error?: string
  stopped?: boolean
  model?: string
  /** True when `resume` was given but the provider no longer has that session. */
  resumeFailed?: boolean
}

/**
 * A minimal environment for CLI subprocesses. API-key variables are dropped so
 * the CLIs always use the local account login, and so are variables inherited
 * from a parent Claude/Codex session, which change how the CLIs authenticate.
 */
export function cleanEnv(extraPathDirs: string[] = []): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  const path = new Set<string>(extraPathDirs)
  for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) path.add(p)
  for (const p of (process.env.PATH ?? '').split(':')) if (p) path.add(p)
  env.PATH = [...path].join(':')
  return env
}

export const dirOf = (p: string | null) => (p ? [dirname(p)] : [])

/** An empty working directory, so agent CLIs have nothing to read or touch. */
export function workspace() {
  const d = join(app.getPath('userData'), 'workspace')
  mkdirSync(d, { recursive: true })
  return d
}

/** Executables inside app.asar can't be spawned; electron-builder unpacks them here. */
export const unpacked = (p: string) => p.replace('/app.asar/', '/app.asar.unpacked/')

/** Opens Terminal running a shell command (used for CLI sign-in flows). */
export async function runInTerminal(cmd: string) {
  const script = `tell application "Terminal"
  activate
  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`
  await run('/usr/bin/osascript', ['-e', script])
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
