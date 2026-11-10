import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Codex, type ThreadOptions } from '@openai/codex-sdk'
import type { ModelOption, ProviderStatus } from '../../shared/types'
import { cleanEnv, run, runInTerminal, shellQuote, unpacked, workspace, type StreamArgs, type StreamResult } from './common'

/*
 * OpenAI models run through the Codex CLI, which uses the ChatGPT account the
 * Codex app/CLI is signed in to (~/.codex/auth.json), not an API key. Same
 * approach as Conductor. We use the Codex binary bundled with @openai/codex-sdk.
 */

const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex')

function codexBinary(): string | null {
  const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const pkg = `@openai/codex-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}/package.json`
  try {
    const req = createRequire(import.meta.url)
    const p = unpacked(join(dirname(req.resolve(pkg)), 'vendor', triple, 'bin', 'codex'))
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

const FALLBACK_MODELS = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']

/** Models available to this ChatGPT account, from the Codex model cache. */
export function openaiModels(): ModelOption[] {
  let list: { slug: string; display_name?: string; description?: string }[] = []
  try {
    const cache = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8')) as {
      models?: { slug: string; display_name?: string; description?: string; visibility?: string; priority?: number }[]
    }
    list = (cache.models ?? [])
      .filter((m) => m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
  } catch {
    /* no cache yet */
  }
  if (!list.length) list = FALLBACK_MODELS.map((slug) => ({ slug }))
  return list.map((m) => ({
    id: `openai:${m.slug}`,
    provider: 'openai' as const,
    model: m.slug,
    label: m.display_name ?? m.slug,
    desc: m.description ?? ''
  }))
}

/** Reads the ChatGPT plan from the id_token claims (no network, no secrets exposed). */
function chatgptPlan(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(codexHome(), 'auth.json'), 'utf8')) as { tokens?: { id_token?: string } }
    const payload = auth.tokens?.id_token?.split('.')[1]
    if (!payload) return undefined
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, Record<string, string>>
    const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type
    return plan ? plan[0].toUpperCase() + plan.slice(1) : undefined
  } catch {
    return undefined
  }
}

export async function openaiStatus(): Promise<ProviderStatus> {
  const bin = codexBinary()
  if (!bin) return { provider: 'openai', ok: false, canLogin: false, authCommand: 'codex login', detectedPath: null, error: 'Codex CLI missing from the app bundle.' }
  try {
    const { stdout, stderr } = await run(bin, ['login', 'status'], { env: cleanEnv(), timeout: 15000 })
    const s = `${stdout}\n${stderr}`
    if (/logged in using chatgpt/i.test(s)) return { provider: 'openai', ok: true, plan: chatgptPlan(), canLogin: true, authCommand: 'codex login', detectedPath: bin }
    if (/logged in/i.test(s) && !/not logged in/i.test(s)) {
      return { provider: 'openai', ok: false, canLogin: true, authCommand: 'codex login', detectedPath: bin, error: 'Codex is signed in with an API key. Sign in with ChatGPT to use your subscription.' }
    }
    return { provider: 'openai', ok: false, canLogin: true, authCommand: 'codex login', detectedPath: bin }
  } catch {
    return { provider: 'openai', ok: false, canLogin: true, authCommand: 'codex login', detectedPath: bin }
  }
}

export async function openaiLogin() {
  const bin = codexBinary()
  if (bin) await runInTerminal(`env -u OPENAI_API_KEY ${shellQuote(bin)} login`)
}

function writeImages(images: StreamArgs['images']) {
  const dir = join(app.getPath('userData'), 'tmp', randomUUID())
  mkdirSync(dir, { recursive: true })
  const paths: string[] = []
  images.forEach((img, i) => {
    const m = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(img.dataUrl)
    if (!m) return
    const p = join(dir, `image-${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
    writeFileSync(p, Buffer.from(m[2], 'base64'))
    paths.push(p)
  })
  return { dir, paths }
}

export async function streamOpenAI(a: StreamArgs): Promise<StreamResult> {
  const bin = codexBinary()
  const codex = new Codex({
    codexPathOverride: bin ?? undefined,
    env: cleanEnv(),
    config: {
      developer_instructions: a.system,
      // Chat only: ignore the user's notify hooks, MCP servers and plugins.
      notify: [],
      mcp_servers: {},
      features: { plugins: false }
    }
  })
  const opts: ThreadOptions = {
    model: a.model,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    workingDirectory: workspace(),
    skipGitRepoCheck: true,
    webSearchMode: 'disabled',
    networkAccessEnabled: false
  }
  const thread = a.resume ? codex.resumeThread(a.resume, opts) : codex.startThread(opts)
  const { dir, paths } = writeImages(a.images)

  // Codex may send an agent message whole or update it progressively; keep the
  // text of each message item and emit whatever is new.
  const items = new Map<string, string>()
  let sent = ''
  const emit = () => {
    const full = [...items.values()].filter(Boolean).join('\n\n')
    if (full.startsWith(sent) && full.length > sent.length) {
      a.onDelta(full.slice(sent.length))
      sent = full
    }
  }

  let error: string | undefined
  try {
    const input = [...paths.map((path) => ({ type: 'local_image' as const, path })), { type: 'text' as const, text: a.text }]
    const { events } = await thread.runStreamed(input, { signal: a.abort.signal })
    for await (const e of events) {
      if (e.type === 'thread.started') a.onSession(e.thread_id)
      else if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') {
        if (e.item.type === 'agent_message') {
          items.set(e.item.id, e.item.text)
          emit()
        } else if (e.item.type === 'reasoning') a.onThinking()
      } else if (e.type === 'turn.failed') error = e.error.message
      else if (e.type === 'error') error ??= e.message
    }
  } catch (e) {
    // The SDK throws after a failed turn too; keep the more useful event message.
    if (!a.abort.signal.aborted) error ??= e instanceof Error ? e.message : String(e)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (a.abort.signal.aborted) return { text: sent, stopped: true, model: a.model }
  if (error) error = error.replace(/^Codex Exec exited with code \d+:\s*/i, '').replace(/Reading prompt from stdin\.\.\.\s*/i, '').trim()
  const resumeFailed = !!(error && a.resume && !sent && /no (such )?(session|conversation|thread|rollout)|not found/i.test(error))
  return { text: sent, error, model: a.model, resumeFailed }
}
