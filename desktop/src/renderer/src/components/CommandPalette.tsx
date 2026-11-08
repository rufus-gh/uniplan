import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from './Icons'

export interface Command {
  id: string
  section: string
  label: string
  icon?: ReactNode
  hint?: ReactNode
  keywords?: string
  run(): void
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return commands
    return commands.filter((c) => {
      const hay = `${c.label} ${c.section} ${c.keywords ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [q, commands])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function run(c?: Command) {
    if (!c) return
    onClose()
    c.run()
  }

  let lastSection = ''
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={17} />
          <input
            autoFocus
            placeholder="Type a command or search chats…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(filtered[sel])
              } else if (e.key === 'Escape') {
                onClose()
              }
            }}
          />
        </div>
        <div className="palette-list" ref={list}>
          {filtered.length === 0 && <div className="palette-empty">No results</div>}
          {filtered.map((c, i) => {
            const header = c.section !== lastSection ? c.section : null
            lastSection = c.section
            return (
              <div key={c.id}>
                {header && <div className="palette-section">{header}</div>}
                <button
                  className={`palette-item ${i === sel ? 'sel' : ''}`}
                  onMouseMove={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  {c.icon && <span className="ico">{c.icon}</span>}
                  <span className="grow">{c.label}</span>
                  {c.hint}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
