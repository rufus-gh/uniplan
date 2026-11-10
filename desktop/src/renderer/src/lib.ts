import { cleanMath } from '../../shared/text'
import type { Effort, LemmaApi, ModelOption, Provider, ThreadSummary, TutorMode } from '../../shared/types'

declare global {
  interface Window {
    lemma: LemmaApi
  }
}

export const api = window.lemma

export interface ProviderInfo {
  name: string
  account: string
  defaultAuthCmd: string
  desc: string
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  claude: {
    name: 'Claude',
    account: 'Claude Code',
    defaultAuthCmd: 'claude auth login',
    desc: 'Anthropic Claude models via Claude Code CLI'
  },
  openai: {
    name: 'OpenAI',
    account: 'Codex (ChatGPT)',
    defaultAuthCmd: 'codex login',
    desc: 'OpenAI ChatGPT models via Codex CLI'
  },
  gemini: {
    name: 'Gemini',
    account: 'Antigravity (agy)',
    defaultAuthCmd: 'agy auth login',
    desc: 'Google Gemini models through the Antigravity CLI'
  },
  opencode: {
    name: 'OpenCode',
    account: 'OpenCode',
    defaultAuthCmd: 'opencode auth login',
    desc: 'OpenCode CLI assistant and multi-provider models'
  },
  copilot: {
    name: 'GitHub Copilot',
    account: 'GitHub Copilot',
    defaultAuthCmd: 'gh auth login',
    desc: 'GitHub Copilot models via GitHub CLI / Copilot'
  },
  vibe: {
    name: 'Mistral Vibe',
    account: 'Mistral Vibe',
    defaultAuthCmd: 'vibe --setup',
    desc: 'Mistral models via the Vibe CLI'
  },
  ollama: {
    name: 'Ollama',
    account: 'Ollama (Local)',
    defaultAuthCmd: 'ollama run llama3.3',
    desc: 'Local open-source models running on your machine'
  },
  kilo: {
    name: 'Kilo Code',
    account: 'Kilo Code',
    defaultAuthCmd: 'kilo auth login',
    desc: 'Kilo Code CLI and universal gateway models'
  },
  openrouter: {
    name: 'OpenRouter',
    account: 'OpenRouter',
    defaultAuthCmd: 'openrouter login',
    desc: 'Unified API routing to 100+ frontier models'
  }
}

export const ALL_PROVIDERS: Provider[] = [
  'claude',
  'openai',
  'gemini',
  'opencode',
  'copilot',
  'vibe',
  'ollama',
  'kilo',
  'openrouter'
]

export const MODES: { id: TutorMode; label: string; desc: string }[] = [
  { id: 'explain', label: 'Explain', desc: 'Full worked solution' },
  { id: 'hint', label: 'Hint', desc: 'Nudges only, no answers' },
  { id: 'check', label: 'Check', desc: 'Mark my working' }
]

export const EFFORTS: { id: Effort; label: string; desc: string }[] = [
  { id: 'low', label: 'Low', desc: 'Quick answers. Uses the least of your plan.' },
  { id: 'medium', label: 'Medium', desc: 'Balanced thinking for most problems.' },
  { id: 'high', label: 'High', desc: 'More careful reasoning for harder proofs.' },
  { id: 'xhigh', label: 'Extra high', desc: 'Very deep reasoning. Noticeably slower.' },
  { id: 'max', label: 'Max', desc: 'Deepest possible thinking. Slowest, and uses the most of your plan.' }
]

/** "in 2 hr 8 min" / "Sat 4:59 am" for a reset time. */
export function fmtReset(iso: string | null | undefined) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000))
  if (mins < 60) return `in ${mins} min`
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)} hr ${mins % 60} min`
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export const providerOf = (id: string): Provider => {
  const [p] = id.split(':')
  if (p in PROVIDERS) return p as Provider
  return 'claude'
}

export function modelLabel(id: string, models: ModelOption[]) {
  return models.find((m) => m.id === id)?.label ?? id.split(':').pop() ?? id
}

export function groupThreads(threads: ThreadSummary[]) {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const groups: { label: string; items: ThreadSummary[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] }
  ]
  for (const t of threads) {
    const u = t.updatedAt
    const g = u >= startOfDay ? 0 : u >= startOfDay - day ? 1 : u >= startOfDay - 7 * day ? 2 : u >= startOfDay - 30 * day ? 3 : 4
    groups[g].items.push(t)
  }
  return groups.filter((g) => g.items.length)
}

export const isMac = api?.platform === 'darwin'
export const mod = isMac ? '⌘' : 'Ctrl'

export function readImage(file: File): Promise<string | null> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return Promise.resolve(null)
  if (file.size > 8 * 1024 * 1024) return Promise.resolve(null)
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function errorText(e: unknown) {
  const s = e instanceof Error ? e.message : String(e)
  return s.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** A title/label with LaTeX turned into readable symbols (e.g. "\\sqrt{2}" -> "√2"). */
export const plainTitle = (t: string) => cleanMath(t)

/**
 * The selected text as Markdown: rendered maths (KaTeX) is swapped back for its TeX source so a quote
 * doesn't contain every formula twice (KaTeX includes a hidden MathML copy).
 */
export function selectionMarkdown(range: Range): string {
  const div = document.createElement('div')
  div.appendChild(range.cloneContents())
  const tex = (el: Element) => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent
  div.querySelectorAll('.katex-display').forEach((el) => {
    const t = tex(el)
    el.replaceWith(document.createTextNode(t ? `\n$$${t}$$\n` : (el.textContent ?? '')))
  })
  div.querySelectorAll('.katex').forEach((el) => {
    const t = tex(el)
    el.replaceWith(document.createTextNode(t ? `$${t}$` : (el.textContent ?? '')))
  })
  return (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export const quoteMarkdown = (q: string) =>
  q
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n')
