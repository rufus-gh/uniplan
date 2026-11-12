import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, EmbedderKind } from '../shared/types'

/*
 * App settings, stored in <userData>/settings.json.
 *
 * The Hack Club AI key is encrypted with Electron's safeStorage (the macOS
 * Keychain). If encryption isn't available it is kept in memory for this
 * session only, never written to disk in plain text. LEMMA_HACKCLUB_KEY in the
 * environment is used when no key has been saved.
 */

interface Stored {
  embedder: EmbedderKind
  /** base64 of the safeStorage-encrypted key */
  keyEnc?: string
}

const file = () => join(app.getPath('userData'), 'settings.json')

let cache: Stored | null = null
let sessionKey: string | null = null // used only when encryption is unavailable

function read(): Stored {
  if (cache) return cache
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Stored>
    cache = { embedder: s.embedder === 'qwen' ? 'qwen' : 'local', keyEnc: s.keyEnc }
  } catch {
    cache = { embedder: 'local' }
  }
  return cache
}

function write() {
  const p = file()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 1), { mode: 0o600 })
  renameSync(tmp, p)
}

const canEncrypt = () => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** The Hack Club AI key, or null if there isn't one. Main process only. */
export function getApiKey(): string | null {
  if (sessionKey) return sessionKey
  const enc = read().keyEnc
  if (enc && canEncrypt()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      /* unreadable (e.g. moved to another Mac) */
    }
  }
  return process.env.LEMMA_HACKCLUB_KEY?.trim() || null
}

export function getEmbedderKind(): EmbedderKind {
  return read().embedder
}

export function setEmbedderKind(kind: EmbedderKind) {
  read().embedder = kind
  write()
}

/** Saves (or, with an empty string, removes) the key. */
export function setApiKey(key: string) {
  const s = read()
  const k = key.trim()
  sessionKey = null
  delete s.keyEnc
  if (k) {
    if (canEncrypt()) s.keyEnc = safeStorage.encryptString(k).toString('base64')
    else sessionKey = k
  }
  write()
}

/** What the renderer is allowed to see: never the key itself. */
export function publicSettings(): AppSettings {
  return { embedder: read().embedder, hasKey: !!getApiKey(), keySecure: canEncrypt() }
}
