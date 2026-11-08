// Types shared between the main process, preload and renderer.

export type Provider = 'claude' | 'openai'
export type TutorMode = 'explain' | 'hint' | 'check'
/** Claude reasoning effort (more = deeper thinking, slower, uses more of your plan). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A model the user can pick. `id` is `${provider}:${model}`. */
export interface ModelOption {
  id: string
  provider: Provider
  model: string
  label: string
  desc: string
}

export interface ImageAttachment {
  /** data: URL (image/png, image/jpeg, image/gif, image/webp) */
  dataUrl: string
  name?: string
}

/** A course-material excerpt that was given to the model for a reply. */
export interface Source {
  n: number
  fileId: string
  fileName: string
  location?: string
  excerpt: string
  score: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ImageAttachment[]
  createdAt: number
  /** Set on assistant messages that failed or were stopped. */
  error?: string
  stopped?: boolean
  durationMs?: number
  model?: string
  provider?: Provider
  sources?: Source[]
}

export interface ProviderSession {
  id: string
  /** How many thread messages this session has already seen. */
  upTo: number
}

export interface Thread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** ModelOption id, e.g. "claude:claude-opus-5-5". */
  model: string
  mode: TutorMode
  /** Claude only. */
  effort: Effort
  /** '' = no course materials, 'all' = every course, otherwise a course id. */
  courseId: string
  /** Provider-side session per provider, used to resume conversations. */
  sessions?: Partial<Record<Provider, ProviderSession>>
  messages: ChatMessage[]
}

export type ThreadSummary = Pick<Thread, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'model' | 'mode' | 'courseId' | 'effort'> & {
  preview: string
}

export interface ProviderStatus {
  provider: Provider
  ok: boolean
  /** e.g. "Pro", "Free" */
  plan?: string
  error?: string
  /** Whether the app can open a sign-in flow for this provider. */
  canLogin: boolean
}

export interface UsageWindow {
  /** Percent used, 0–100. */
  percent: number
  resetsAt: string | null
}

/** Claude plan usage, as shown by Claude Code's /usage. */
export interface ClaudeUsage {
  plan?: string
  session?: UsageWindow // rolling 5-hour window
  weekly?: UsageWindow
  weeklyOpus?: UsageWindow
  weeklySonnet?: UsageWindow
  /** Share of this week's usage by surface (Claude Code, chats, …). */
  breakdown?: { name: string; percent: number }[]
  fetchedAt: number
  error?: string
}

export interface Course {
  id: string
  name: string
  createdAt: number
}

export interface LibraryFile {
  id: string
  courseId: string
  name: string
  kind: string
  size: number
  addedAt: number
  status: 'queued' | 'indexing' | 'ready' | 'error'
  chunks: number
  error?: string
}

export interface LibraryState {
  courses: Course[]
  files: LibraryFile[]
  /** State of the local semantic-search model. */
  embedder: 'idle' | 'loading' | 'ready' | 'unavailable'
}

export interface SearchHit extends Source {
  courseId: string
}

export type ChatEvent =
  | { threadId: string; messageId: string; type: 'start'; sources?: Source[] }
  | { threadId: string; messageId: string; type: 'delta'; text: string }
  | { threadId: string; messageId: string; type: 'thinking' }
  /** Claude searched the notes again; `sources` is the full, renumbered list so far. */
  | { threadId: string; messageId: string; type: 'sources'; sources: Source[] }
  | { threadId: string; messageId: string; type: 'status'; text: string }
  | { threadId: string; messageId: string; type: 'done'; message: ChatMessage }
  | { threadId: string; messageId: string; type: 'error'; message: ChatMessage }
  | { threadId: string; type: 'title'; title: string }

export interface SendRequest {
  threadId: string
  text: string
  images?: ImageAttachment[]
  /** Re-run the last user turn, replacing a failed/stopped reply. */
  retry?: boolean
}

export type ThreadPatch = Partial<Pick<Thread, 'title' | 'model' | 'mode' | 'courseId' | 'effort'>>

export interface LemmaApi {
  listThreads(): Promise<ThreadSummary[]>
  getThread(id: string): Promise<Thread | null>
  createThread(init?: Partial<Pick<Thread, 'model' | 'mode' | 'courseId' | 'effort'>>): Promise<Thread>
  updateThread(id: string, patch: ThreadPatch): Promise<Thread | null>
  deleteThread(id: string): Promise<void>
  send(req: SendRequest): Promise<{ userMessage: ChatMessage; assistantId: string }>
  stop(threadId: string): Promise<void>

  listModels(): Promise<ModelOption[]>
  authStatus(): Promise<ProviderStatus[]>
  openLogin(provider: Provider): Promise<void>
  claudeUsage(force?: boolean): Promise<ClaudeUsage>

  library(): Promise<LibraryState>
  createCourse(name: string): Promise<Course>
  renameCourse(id: string, name: string): Promise<void>
  deleteCourse(id: string): Promise<void>
  /** Opens a file picker and indexes the chosen files/folders into the course. */
  pickFiles(courseId: string): Promise<void>
  addPaths(courseId: string, paths: string[]): Promise<void>
  removeFile(fileId: string): Promise<void>
  openFile(fileId: string): Promise<void>
  search(query: string, courseId: string): Promise<SearchHit[]>
  pathForFile(file: File): string

  onChatEvent(cb: (e: ChatEvent) => void): () => void
  onLibrary(cb: (s: LibraryState) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  platform: string
}
