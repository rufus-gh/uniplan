import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/*
 * A private Python (sympy, numpy, scipy) that Claude can use to check its
 * working. Created with `uv` on first use in the app's data folder. Each run
 * is sandboxed: no network, no file writes outside a throwaway temp folder,
 * 20 s time limit.
 */

const envDir = () => join(app.getPath('userData'), 'python')
const pyBin = () => join(envDir(), 'bin', 'python')
let setup: Promise<void> | null = null

function findUv() {
  return [join(homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv'].find(existsSync) ?? null
}

function ensureEnv(onStatus: (s: string) => void): Promise<void> {
  if (existsSync(pyBin()) && existsSync(join(envDir(), '.ready'))) return Promise.resolve()
  if (setup) return setup
  setup = (async () => {
    const uv = findUv()
    if (!uv) throw new Error('Python needs `uv` (https://docs.astral.sh/uv/) to set up its environment.')
    onStatus('Setting up Python (first time only)…')
    const env = { ...process.env, VIRTUAL_ENV: envDir() }
    await run(uv, ['venv', '--python', '3.12', envDir()], { env, timeout: 180_000 })
    await run(uv, ['pip', 'install', '--python', pyBin(), 'sympy', 'numpy', 'scipy'], { env, timeout: 300_000 })
    writeFileSync(join(envDir(), '.ready'), '')
  })().finally(() => {
    setup = null
  })
  return setup
}

const profile = (tmp: string) => `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "${tmp}") (subpath "/private${tmp}") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))`

/** Runs a Python snippet and returns its combined output (truncated). */
export async function runPython(code: string, onStatus: (s: string) => void): Promise<string> {
  try {
    await ensureEnv(onStatus)
  } catch (e) {
    return `Python unavailable: ${e instanceof Error ? e.message : String(e)}`
  }
  onStatus('Running Python…')
  const tmp = mkdtempSync(join(tmpdir(), 'lemma-py-'))
  const script = join(tmp, 'main.py')
  writeFileSync(script, code)
  try {
    const { stdout, stderr } = await run('/usr/bin/sandbox-exec', ['-p', profile(tmp), pyBin(), '-I', script], {
      cwd: tmp,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, MPLBACKEND: 'Agg' }
    })
    const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()
    return (out || '(no output; use print())').slice(0, 8000)
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; message?: string }
    if (err.killed) return 'Timed out after 20 s.'
    return `${err.stdout ?? ''}\n${err.stderr ?? err.message ?? ''}`.trim().slice(0, 8000)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
