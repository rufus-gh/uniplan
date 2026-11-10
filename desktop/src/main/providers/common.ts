import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
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

const binaryCache = new Map<string, string | null>()

/** Locates a CLI binary across common install locations and the user's login shell PATH. */
export async function findBinary(name: string, extraCandidates: string[] = []): Promise<string | null> {
  if (binaryCache.has(name)) return binaryCache.get(name)!
  const home = homedir()
  const candidates = [
    ...extraCandidates,
    join(home, `.local/bin/${name}`),
    join(home, `.cargo/bin/${name}`),
    join(home, `.${name}/bin/${name}`),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/bin/${name}`
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) {
    binaryCache.set(name, found)
    return found
  }
  try {
    const { stdout } = await run('/bin/zsh', ['-lc', `command -v ${name}`], { timeout: 5000 })
    const path = stdout.trim()
    if (path && existsSync(path)) {
      binaryCache.set(name, path)
      return path
    }
  } catch {
    /* not installed */
  }
  binaryCache.set(name, null)
  return null
}

export interface StreamProcessOptions {
  bin: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  abort: AbortController
  model: string
  onDelta(text: string): void
  onThinking?(): void
  parseJsonEvents?: boolean
  inputStdin?: string
}

/** Spawns a CLI process and streams its stdout back to the caller. */
export function streamProcess(opts: StreamProcessOptions): Promise<StreamResult> {
  const { bin, args, env, cwd, abort, model, onDelta, onThinking, parseJsonEvents, inputStdin } = opts
  return new Promise<StreamResult>((resolve) => {
    let out = ''
    let err = ''
    let resolved = false

    const proc = spawn(bin, args, {
      env: env ?? cleanEnv(dirOf(bin)),
      cwd: cwd ?? workspace()
    })

    const onAbort = () => {
      try {
        proc.kill('SIGINT')
        setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }, 1500)
      } catch {
        /* ignore */
      }
    }

    if (abort.signal.aborted) {
      onAbort()
      resolve({ text: '', stopped: true, model })
      return
    }

    abort.signal.addEventListener('abort', onAbort)

    if (inputStdin) {
      proc.stdin?.write(inputStdin)
      proc.stdin?.end()
    }

    let lineBuf = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8')
      if (parseJsonEvents) {
        lineBuf += str
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed)
            const delta =
              ev.delta?.text ??
              ev.text ??
              ev.content ??
              ev.message?.content ??
              (typeof ev.delta === 'string' ? ev.delta : undefined)
            if (typeof delta === 'string') {
              out += delta
              onDelta(delta)
            } else if (ev.type === 'thinking' || ev.thinking) {
              onThinking?.()
            }
          } catch {
            out += line + '\n'
            onDelta(line + '\n')
          }
        }
      } else {
        out += str
        onDelta(str)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })

    const finish = (code: number | null) => {
      if (resolved) return
      resolved = true
      abort.signal.removeEventListener('abort', onAbort)

      if (abort.signal.aborted) {
        resolve({ text: out, stopped: true, model })
        return
      }

      if (code !== 0 && !out) {
        const errorMsg = err.trim() || `Process exited with code ${code}`
        resolve({ text: out, error: errorMsg, model })
        return
      }

      resolve({ text: out, model })
    }

    proc.on('error', (e) => {
      if (resolved) return
      resolved = true
      abort.signal.removeEventListener('abort', onAbort)
      resolve({ text: out, error: e.message, model, stopped: abort.signal.aborted })
    })

    proc.on('close', finish)
    proc.on('exit', finish)
  })
}
