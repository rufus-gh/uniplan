import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ClaudeUsage, ModelOption, ProviderStatus, UsageWindow } from '../../shared/types'
import { cleanEnv, dirOf, run, runInTerminal, shellQuote, unpacked, workspace, type StreamArgs, type StreamResult } from './common'

/*
 * Claude runs through Claude Code, so messages use whichever Claude account is
 * signed in on this Mac (Pro/Max), not an API key. Same approach as Conductor.
 *
 * Chats use the Claude Code build bundled with the Agent SDK, which keeps up
 * with new models. It reads the same keychain login as the installed `claude`
 * CLI, which we use for `auth status` / `auth login`.
 */

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude:claude-opus-5-5', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', desc: 'Deepest reasoning, for proofs' },
  { id: 'claude:claude-sonnet-5-5', provider: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', desc: 'Fast and strong, everyday problems' },
  { id: 'claude:claude-haiku-5-5', provider: 'claude', model: 'claude-haiku-5-5', label: 'Haiku 5.5', desc: 'Quickest, for simple checks' }
]

/**
 * The Claude Code binary bundled with the SDK. In a packaged app the SDK can't
 * find it by itself (it looks inside app.asar, which isn't a real directory:
 * ENOTDIR), so we locate the unpacked copy and pass its path explicitly.
 */
function bundledClaude(): string | undefined {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}/package.json`
    const p = unpacked(join(dirname(createRequire(import.meta.url).resolve(pkg)), 'claude'))
    return existsSync(p) ? p : undefined
  } catch {
    return undefined
  }
}

/** Which executable the SDK should run: the bundled one, or the user's installed CLI as a fallback. */
const exe = (installed: string | null, useInstalled = false) => (useInstalled && installed ? installed : bundledClaude())

let cliPath: string | null | undefined

async function findClaude(): Promise<string | null> {
  if (cliPath !== undefined) return cliPath
  const home = homedir()
  const candidates = [join(home, '.local/bin/claude'), join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  cliPath = candidates.find((p) => existsSync(p)) ?? null
  if (!cliPath) {
    // Apps launched from Finder get a minimal PATH, so ask a login shell.
    try {
      const { stdout } = await run('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 5000 })
      if (stdout.trim() && existsSync(stdout.trim())) cliPath = stdout.trim()
    } catch {
      /* not installed */
    }
  }
  return cliPath
}

function env(cli: string | null) {
  return {
    ...cleanEnv(dirOf(cli)),
    CLAUDE_AGENT_SDK_CLIENT_APP: `lemma/${app.getVersion()}`,
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1'
  }
}

export async function claudeStatus(): Promise<ProviderStatus> {
  const cli = await findClaude()
  if (!cli) {
    return {
      provider: 'claude',
      ok: false,
      canLogin: true,
      authCommand: 'claude auth login',
      detectedPath: null,
      error: 'Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash'
    }
  }
  let out = ''
  try {
    out = (await run(cli, ['auth', 'status'], { env: env(cli), timeout: 15000 })).stdout
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '' // exits non-zero when logged out
  }
  try {
    const s = JSON.parse(out) as { loggedIn?: boolean; subscriptionType?: string }
    const plan = s.subscriptionType ? s.subscriptionType[0].toUpperCase() + s.subscriptionType.slice(1) : undefined
    return { provider: 'claude', ok: !!s.loggedIn, plan, canLogin: true, authCommand: 'claude auth login', detectedPath: cli }
  } catch {
    return { provider: 'claude', ok: false, canLogin: true, authCommand: 'claude auth login', detectedPath: cli, error: 'Could not read Claude sign-in status.' }
  }
}

export async function claudeLogin() {
  const cli = (await findClaude()) ?? 'claude'
  await runInTerminal(`env -u ANTHROPIC_API_KEY ${shellQuote(cli)} auth login`)
}

function blocks(text: string, images: StreamArgs['images']) {
  const out: Array<Record<string, unknown>> = []
  for (const img of images) {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(img.dataUrl)
    if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
  }
  if (text.trim()) out.push({ type: 'text', text })
  return out
}

export async function streamClaude(a: StreamArgs, useInstalledCli = false): Promise<StreamResult> {
  const cli = await findClaude()

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: blocks(a.text, a.images) as never },
      parent_tool_use_id: null
    } as SDKUserMessage
  }

  let out = ''
  let model: string | undefined
  let error: string | undefined

  // Optional in-process tools: search the course notes, run Python.
  const notes = a.searchNotes
  const py = a.runPython
  const tools = [
    ...(notes
      ? [
          tool(
            'search_notes',
            'Search the student’s own lecture notes, worksheets and lecture transcripts for this course. Use precise mathematical terms (e.g. "definition convergence sequence epsilon N") or a numbered reference (e.g. "Proposition 3.12"). Returns numbered excerpts; cite them as [n].',
            { query: z.string().describe('What to look for') },
            async ({ query: q }) => {
              a.onStatus?.(`Searching your notes for “${q}”`)
              return { content: [{ type: 'text' as const, text: await notes(q) }] }
            }
          )
        ]
      : []),
    ...(py
      ? [
          tool(
            'run_python',
            'Run a short Python 3 script to check working: arithmetic, algebra (sympy), numerics (numpy/scipy), counterexample searches. Print what you need. No network or file access; 20 s limit.',
            { code: z.string().describe('Python source; use print() for output') },
            async ({ code }) => ({ content: [{ type: 'text' as const, text: await py(code) }] })
          )
        ]
      : [])
  ]
  const lemmaServer = tools.length ? createSdkMcpServer({ name: 'lemma', version: '1.0.0', tools }) : null
  const allowed = [...(notes ? ['mcp__lemma__search_notes'] : []), ...(py ? ['mcp__lemma__run_python'] : [])]

  try {
    const q = query({
      prompt: prompt(),
      options: {
        model: a.model,
        effort: a.effort,
        resume: a.resume,
        systemPrompt: a.system,
        tools: [],
        mcpServers: lemmaServer ? { lemma: lemmaServer } : {},
        allowedTools: allowed,
        settingSources: [],
        includePartialMessages: true,
        // One reply, plus a few tool calls (searches / Python) when enabled.
        maxTurns: lemmaServer ? 8 : 1,
        cwd: workspace(),
        env: env(cli),
        pathToClaudeCodeExecutable: exe(cli, useInstalledCli),
        abortController: a.abort,
        extraArgs: { 'strict-mcp-config': null }
      }
    })

    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        model = m.model
        a.onSession(m.session_id)
      } else if (m.type === 'stream_event') {
        const ev = m.event
        if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') {
            out += ev.delta.text
            a.onDelta(ev.delta.text)
          } else if (ev.delta.type === 'thinking_delta') {
            a.onThinking()
          }
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'text' && out && !out.endsWith('\n')) {
          out += '\n\n'
          a.onDelta('\n\n')
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          a.onStatus?.('Working…')
        }
      } else if (m.type === 'assistant' && !out) {
        for (const b of m.message.content) if (b.type === 'text') out += b.text
        if (out) a.onDelta(out)
      } else if (m.type === 'result' && m.subtype === 'error_max_turns' && out) {
        // Ran out of search turns but still answered: fine.
      } else if (m.type === 'result' && (m.is_error || m.subtype !== 'success')) {
        error = ('result' in m && typeof m.result === 'string' && m.result) || ('errors' in m && m.errors?.join('\n')) || m.subtype
      }
    }
  } catch (e) {
    if (!a.abort.signal.aborted) error = e instanceof Error ? e.message : String(e)
  }

  if (a.abort.signal.aborted) return { text: out, stopped: true, model }

  // If the bundled build can't start, fall back to the user's installed CLI.
  if (error && !out && !useInstalledCli && cli && /ENOENT|EACCES|spawn|exited with code|executable/i.test(error)) {
    return streamClaude(a, true)
  }
  const resumeFailed = !!(error && a.resume && !out && /no conversation|session|not found/i.test(error))
  return { text: out, error, model, resumeFailed }
}

// ---------------------------------------------------------------- usage

let usageCache: ClaudeUsage | null = null

const win = (w?: { utilization: number | null; resets_at: string | null } | null): UsageWindow | undefined =>
  w && w.utilization !== null ? { percent: w.utilization, resetsAt: w.resets_at } : undefined

/**
 * Plan usage (the data behind Claude Code's /usage): 5-hour session and weekly
 * limits. Opens a Claude Code session without sending a prompt and asks for it,
 * so it costs nothing. Cached for a minute.
 */
export async function claudeUsage(force = false): Promise<ClaudeUsage> {
  if (!force && usageCache && Date.now() - usageCache.fetchedAt < 60_000) return usageCache
  const cli = await findClaude()
  const abort = new AbortController()
  let release!: () => void
  const hold = new Promise<void>((r) => (release = r))
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await hold // never sends a message
  }
  try {
    const q = query({ prompt: idle(), options: { tools: [], settingSources: [], cwd: workspace(), env: env(cli), abortController: abort, pathToClaudeCodeExecutable: exe(cli) } })
    // Experimental SDK API (it may be renamed in later SDK versions).
    const fn = (q as unknown as Record<string, unknown>)['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']
    if (typeof fn !== 'function') throw new Error('Usage isn’t available in this version of the Claude SDK.')
    const u = (await Promise.race([
      fn.call(q, { skipBehaviors: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out fetching usage')), 15_000))
    ])) as {
      subscription_type: string | null
      rate_limits: Record<string, { utilization: number | null; resets_at: string | null } | null> & {
        seven_day_breakdown?: { rows?: { display_name: string; percent: number }[] } | null
      } | null
    }
    const rl = u.rate_limits
    usageCache = {
      plan: u.subscription_type ? u.subscription_type[0].toUpperCase() + u.subscription_type.slice(1) : undefined,
      session: win(rl?.five_hour),
      weekly: win(rl?.seven_day),
      weeklyOpus: win(rl?.seven_day_opus),
      weeklySonnet: win(rl?.seven_day_sonnet),
      breakdown: rl?.seven_day_breakdown?.rows?.filter((r) => r.percent > 0).map((r) => ({ name: r.display_name, percent: r.percent })),
      fetchedAt: Date.now(),
      error: rl ? undefined : 'Plan limits aren’t available for this account.'
    }
  } catch (e) {
    usageCache = { fetchedAt: Date.now(), error: e instanceof Error ? e.message : String(e) }
  } finally {
    release()
    abort.abort()
  }
  return usageCache
}

/** Called after a Claude reply so the next hover shows fresh numbers. */
export function invalidateUsage() {
  usageCache = null
}

// ---------------------------------------------------------------- query rewriting

const REWRITE_PROMPT = `You write search queries for a university student's maths lecture notes. Given their question (and possibly the previous question for context), output 1 to 3 short queries, one per line, no numbering or quotes, using the precise terms a textbook would use, e.g. "definition convergence of a sequence epsilon N". Keep any numbered reference (e.g. Proposition 3.12) exactly. Output only the queries.`

/**
 * Turns a casual question into textbook-style search queries with Haiku, so
 * retrieval finds e.g. "Definition 2.2 … converges if ∀ε>0 ∃N" for "what's the
 * epsilon formula for convergence". Returns [] on failure or timeout.
 */
export async function rewriteQueries(question: string, previous?: string, timeoutMs = 6000): Promise<string[]> {
  const cli = await findClaude()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const content = previous ? `Previous question: ${previous}\nQuestion: ${question}` : question
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage
  }
  try {
    for await (const m of query({
      prompt: prompt(),
      options: {
        model: 'claude-haiku-5-5',
        effort: 'low',
        systemPrompt: REWRITE_PROMPT,
        tools: [],
        mcpServers: {},
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        cwd: workspace(),
        env: env(cli),
        abortController: abort,
        pathToClaudeCodeExecutable: exe(cli),
        extraArgs: { 'strict-mcp-config': null }
      }
    })) {
      if (m.type === 'result' && m.subtype === 'success') {
        return m.result
          .split('\n')
          .map((l) => l.replace(/^[\s\d.)\-*"]+|"$/g, '').trim())
          .filter((l) => l.length > 2)
          .slice(0, 3)
      }
    }
  } catch {
    /* timed out or unavailable: fall back to the original question */
  } finally {
    clearTimeout(timer)
  }
  return []
}
