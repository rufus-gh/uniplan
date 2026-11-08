import { useEffect, useState } from 'react'
import type { LibraryState, SearchHit } from '../../../shared/types'
import { api, errorText, fmtSize } from '../lib'
import { Alert, Book, FileIcon, Plus, Search, Trash, Upload } from './Icons'

interface Props {
  lib: LibraryState
  selected: string | null
  onSelect(id: string | null): void
  onToast(text: string): void
}

const STATUS: Record<string, string> = { queued: 'Queued', indexing: 'Indexing…', ready: 'Ready', error: 'Failed' }

function NewCourse({ onCreate, autoFocus }: { onCreate(name: string): void; autoFocus?: boolean }) {
  const [name, setName] = useState('')
  return (
    <form
      className="new-course"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name.trim())
        setName('')
      }}
    >
      <input autoFocus={autoFocus} placeholder="Course name, e.g. MATH2320" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn sm" type="submit" disabled={!name.trim()}>
        <Plus size={13} /> Add
      </button>
    </form>
  )
}

export function Library({ lib, selected, onSelect, onToast }: Props) {
  const course = lib.courses.find((c) => c.id === selected) ?? null
  const files = lib.files.filter((f) => f.courseId === course?.id)
  const [dragging, setDragging] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!selected && lib.courses.length) onSelect(lib.courses[0].id)
  }, [selected, lib.courses, onSelect])

  useEffect(() => {
    setHits(null)
    setQ('')
    setRenaming(false)
  }, [selected])

  async function create(name: string) {
    const c = await api.createCourse(name)
    onSelect(c.id)
  }

  async function add(paths?: string[]) {
    if (!course) return
    try {
      if (paths) await api.addPaths(course.id, paths)
      else await api.pickFiles(course.id)
    } catch (e) {
      onToast(errorText(e))
    }
  }

  async function runSearch() {
    if (!course || !q.trim()) return
    setSearching(true)
    try {
      setHits(await api.search(q, course.id))
    } finally {
      setSearching(false)
    }
  }

  const embedderNote =
    lib.embedder === 'ready'
      ? 'Semantic + keyword search, on this Mac'
      : lib.embedder === 'loading'
        ? 'Preparing local search model… (first time downloads ~33 MB)'
        : lib.embedder === 'unavailable'
          ? 'Keyword search only (semantic model couldn’t load)'
          : 'Search runs entirely on this Mac'

  if (!lib.courses.length) {
    return (
      <div className="lib-empty">
        <Book size={22} />
        <h1>Your course library</h1>
        <p>
          Add lecture notes and lecture transcripts, and Lemma will pull the relevant parts into its answers, using your
          course’s definitions and notation, with citations. Everything is indexed and searched locally.
        </p>
        <NewCourse onCreate={create} autoFocus />
        <div className="lib-formats">PDF · Markdown · LaTeX · TXT · DOCX · VTT/SRT transcripts</div>
      </div>
    )
  }

  return (
    <div className="lib">
      <aside className="lib-courses">
        <div className="lib-label">Courses</div>
        {lib.courses.map((c) => (
          <button key={c.id} className={`lib-course ${c.id === selected ? 'active' : ''}`} onClick={() => onSelect(c.id)}>
            <span className="grow">{c.name}</span>
            <span className="count">{lib.files.filter((f) => f.courseId === c.id).length}</span>
          </button>
        ))}
        <NewCourse onCreate={create} />
        <div className="lib-model">
          <span className={`dot ${lib.embedder === 'ready' ? 'ok' : lib.embedder === 'unavailable' ? 'warn' : ''}`} />
          {embedderNote}
        </div>
      </aside>

      {course && (
        <section
          className={`lib-main ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
            if (paths.length) add(paths)
          }}
        >
          <div className="lib-head">
            {renaming ? (
              <input
                className="header-title-input"
                autoFocus
                defaultValue={course.name}
                onBlur={(e) => {
                  api.renameCourse(course.id, e.target.value)
                  setRenaming(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenaming(false)
                }}
              />
            ) : (
              <h2 onClick={() => setRenaming(true)} title="Rename">
                {course.name}
              </h2>
            )}
            <span className="spacer" />
            <button className="btn sm" onClick={() => add()}>
              <Upload size={13} /> Add files
            </button>
            <button
              className="icon-btn"
              title="Delete course"
              onClick={async () => {
                if (confirm(`Delete “${course.name}” and its ${files.length} indexed file(s)? Your original files are not touched.`)) {
                  await api.deleteCourse(course.id)
                  onSelect(null)
                }
              }}
            >
              <Trash />
            </button>
          </div>

          {files.length === 0 ? (
            <button className="dropzone" onClick={() => add()}>
              <Upload size={20} />
              <strong>Drop lecture notes or transcripts here</strong>
              <span>or click to choose files or a whole folder · PDF, MD, TeX, TXT, DOCX, VTT, SRT</span>
            </button>
          ) : (
            <div className="files">
              {files.map((f) => (
                <div key={f.id} className={`file ${f.status}`}>
                  <FileIcon className="ico" />
                  <button className="fname" onClick={() => api.openFile(f.id)} title="Open">
                    {f.name}
                  </button>
                  <span className="fmeta">{f.kind}</span>
                  <span className="fmeta">{fmtSize(f.size)}</span>
                  <span className={`fstatus ${f.status}`} title={f.error}>
                    {f.status === 'error' && <Alert size={12} />}
                    {f.status === 'ready' ? `${f.chunks} passage${f.chunks === 1 ? '' : 's'}` : STATUS[f.status]}
                  </span>
                  <button className="icon-btn sm" title="Remove" onClick={() => api.removeFile(f.id)}>
                    <Trash size={13} />
                  </button>
                </div>
              ))}
              <div className="files-hint">Drop more files anywhere here</div>
            </div>
          )}

          {files.some((f) => f.status === 'ready') && (
            <div className="try">
              <form
                className="search big"
                onSubmit={(e) => {
                  e.preventDefault()
                  runSearch()
                }}
              >
                <Search />
                <input placeholder={`Test a search in ${course.name}…`} value={q} onChange={(e) => setQ(e.target.value)} />
                {searching && <span className="crumb">Searching…</span>}
              </form>
              {hits && hits.length === 0 && <div className="files-hint">No relevant passages, so chats would answer without notes.</div>}
              {hits?.map((h) => (
                <div key={h.n} className="hit">
                  <div className="hit-head">
                    <span className="n">{h.n}</span>
                    <button className="fname" onClick={() => api.openFile(h.fileId)}>
                      {h.fileName}
                    </button>
                    {h.location && <span className="fmeta">{h.location}</span>}
                    <span className="spacer" />
                    <span className="fmeta">{h.score.toFixed(2)}</span>
                  </div>
                  <p>{h.excerpt.length > 420 ? `${h.excerpt.slice(0, 420)}…` : h.excerpt}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
