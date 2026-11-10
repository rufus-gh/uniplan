// Turns LaTeX-ish text into plain readable text, for places that can't render maths (titles, labels).

const SYM: Record<string, string> = {
  sqrt: '√', int: '∫', iint: '∬', oint: '∮', sum: 'Σ', prod: 'Π', infty: '∞', pi: 'π', alpha: 'α', beta: 'β',
  gamma: 'γ', Gamma: 'Γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  Theta: 'Θ', kappa: 'κ', lambda: 'λ', Lambda: 'Λ', mu: 'μ', nu: 'ν', xi: 'ξ', rho: 'ρ', sigma: 'σ', Sigma: 'Σ',
  tau: 'τ', phi: 'φ', varphi: 'φ', Phi: 'Φ', chi: 'χ', psi: 'ψ', omega: 'ω', Omega: 'Ω', partial: '∂', nabla: '∇',
  cdot: '·', times: '×', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', to: '→', mapsto: '↦',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  implies: '⇒', iff: '⇔', Rightarrow: '⇒', rightarrow: '→', langle: '⟨', rangle: '⟩', ldots: '…', cdots: '⋯',
  mathbb: '', mathrm: '', mathbf: '', mathcal: '', text: '', operatorname: '', left: '', right: '', frac: ''
}
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', n: 'ⁿ', '-': '⁻' }
const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', n: 'ₙ' }

export function cleanMath(text: string): string {
  return text
    .replace(/\\([a-zA-Z]+)/g, (m, name: string) => SYM[name] ?? m.slice(1))
    .replace(/\^\{?(-?[0-9n])\}?/g, (m, c: string) => (c.length === 1 ? (SUP[c] ?? m) : `${SUP['-']}${SUP[c[1]] ?? c[1]}`))
    .replace(/_\{?([0-9n])\}?/g, (m, c: string) => SUB[c] ?? m)
    .replace(/[{}$]/g, '')
    .replace(/\\[,;!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
