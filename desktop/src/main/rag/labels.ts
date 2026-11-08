/*
 * Numbered statements in maths notes ("Proposition 3.12", "Theorem 2.4",
 * "Definition 1.5"). Students ask about them by number, which neither keyword
 * nor embedding search handles well, so we index them explicitly.
 */

const KINDS = [
  'theorem',
  'proposition',
  'lemma',
  'corollary',
  'definition',
  'example',
  'remark',
  'exercise',
  'problem',
  'question',
  'claim',
  'conjecture',
  'notation',
  'section',
  'chapter'
] as const
export type LabelKind = (typeof KINDS)[number]

/** Abbreviations a student might type, mapped to the kinds they could mean. */
const ALIASES: Record<string, LabelKind[]> = {
  thm: ['theorem'],
  prop: ['proposition'],
  lem: ['lemma'],
  cor: ['corollary'],
  def: ['definition'],
  defn: ['definition'],
  eg: ['example'],
  ex: ['example', 'exercise'],
  rmk: ['remark'],
  q: ['question', 'problem', 'exercise'],
  qn: ['question'],
  sec: ['section'],
  ch: ['chapter']
}

const NUM = String.raw`(\d+(?:\s?\.\s?\d+)*)`
const normNum = (n: string) => n.replace(/\s+/g, '')

/** Words that, right before a label, mean it is being referred to rather than stated. */
const MENTION_BEFORE = /\b(by|from|using|see|of|in|and|with|following|to|via|cf|as|apply|applying)\s*$/i

const STATEMENT_RE = new RegExp(String.raw`\b(${KINDS.join('|')})\s+${NUM}\s*(?=[.(:])`, 'gi')
const ANY_RE = new RegExp(String.raw`\b(${KINDS.join('|')})\s+${NUM}`, 'gi')

export interface LabelHit {
  key: string // "proposition 3.12"
  index: number
  defining: boolean
}

/** Every numbered label in a passage, flagging the ones that look like the statement itself. */
export function findLabels(text: string): LabelHit[] {
  const out: LabelHit[] = []
  for (const m of text.matchAll(ANY_RE)) {
    const after = text.slice(m.index! + m[0].length).match(/^\s*([.(:])/)
    const before = text.slice(Math.max(0, m.index! - 24), m.index!)
    out.push({
      key: `${m[1].toLowerCase()} ${normNum(m[2])}`,
      index: m.index!,
      defining: !!after && !MENTION_BEFORE.test(before)
    })
  }
  return out
}

/** Offsets where a numbered statement starts, for chunk boundaries. */
export function statementStarts(text: string): number[] {
  const starts: number[] = []
  for (const m of text.matchAll(STATEMENT_RE)) {
    const before = text.slice(Math.max(0, m.index! - 24), m.index!)
    if (!MENTION_BEFORE.test(before)) starts.push(m.index!)
  }
  return starts
}

/**
 * Labels referenced in a question: "prop 3.12", "Theorem 2.4", "ex 5", or a
 * bare dotted number like "3.12". Returns keys like "proposition 3.12", plus
 * "* 3.12" for a number with no kind (matches any kind).
 */
export function queryLabels(q: string): string[] {
  const keys = new Set<string>()
  const words = [...KINDS, ...Object.keys(ALIASES)].sort((a, b) => b.length - a.length).join('|')
  const re = new RegExp(String.raw`\b(${words})\.?\s*${NUM}`, 'gi')
  const covered: [number, number][] = []
  for (const m of q.matchAll(re)) {
    const w = m[1].toLowerCase()
    const kinds: readonly string[] = (KINDS as readonly string[]).includes(w) ? [w] : ALIASES[w] ?? []
    for (const k of kinds) keys.add(`${k} ${normNum(m[2])}`)
    covered.push([m.index!, m.index! + m[0].length])
  }
  for (const m of q.matchAll(/\b\d+\.\d+(?:\.\d+)*\b/g)) {
    if (!covered.some(([a, b]) => m.index! >= a && m.index! < b)) keys.add(`* ${m[0]}`)
  }
  return [...keys]
}

export function labelMatches(queryKey: string, chunkKey: string) {
  if (queryKey.startsWith('* ')) return chunkKey.endsWith(` ${queryKey.slice(2)}`)
  return queryKey === chunkKey
}

/** Remove the reference phrases from a question, leaving what it asks about them. */
export function stripLabels(q: string): string {
  const words = [...KINDS, ...Object.keys(ALIASES)].sort((a, b) => b.length - a.length).join('|')
  return q
    .replace(new RegExp(String.raw`\b(${words})\.?\s*${NUM}`, 'gi'), ' ')
    .replace(/\b\d+\.\d+(?:\.\d+)*\b/g, ' ')
}

// ---------------------------------------------------------------- symbols

/** Maths symbols spelled out, so "epsilon" matches "ε" (and embeddings see words). */
const SYMBOLS: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', Γ: 'gamma', δ: 'delta', Δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta',
  η: 'eta', θ: 'theta', Θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', Λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi',
  π: 'pi', Π: 'product', ρ: 'rho', σ: 'sigma', Σ: 'sum', τ: 'tau', φ: 'phi', ϕ: 'phi', Φ: 'phi', χ: 'chi',
  ψ: 'psi', Ψ: 'psi', ω: 'omega', Ω: 'omega',
  '∀': 'for all', '∃': 'there exists', '∄': 'there does not exist', '∈': 'in', '∉': 'not in', '⊂': 'subset',
  '⊆': 'subset', '⊃': 'superset', '∪': 'union', '∩': 'intersection', '∅': 'empty set', '∞': 'infinity',
  '∑': 'sum', '∏': 'product', '∫': 'integral', '∮': 'contour integral', '∂': 'partial derivative',
  '∇': 'gradient nabla', '√': 'square root', '≤': 'less or equal', '≥': 'greater or equal', '≠': 'not equal',
  '≈': 'approximately', '≡': 'equivalent', '→': 'to', '↦': 'maps to', '⇒': 'implies', '⟹': 'implies',
  '⇔': 'if and only if', '⟺': 'if and only if', '×': 'times', '⊗': 'tensor', '⊕': 'direct sum', '∘': 'composition',
  '⟨': 'inner product', 'ℝ': 'real numbers R', 'ℂ': 'complex numbers C', 'ℕ': 'natural numbers N', 'ℤ': 'integers Z', 'ℚ': 'rationals Q'
}
const SYMBOL_RE = new RegExp(`[${Object.keys(SYMBOLS).join('')}]`, 'gu')

export function spellSymbols(text: string): string {
  return text.replace(SYMBOL_RE, (c) => ` ${SYMBOLS[c]} `)
}
