import { randomBytes } from 'node:crypto'

// Wire constants aligned with relay/deliver.mjs, relay/names.mjs, relay/request.mjs and gate.ts.
export const MAX_FILE_BYTES = 200_000_000 // decimal 200 MB, matching relay/deliver.mjs
export const MAX_TEXT_CHARS = 2000
export const MAX_TITLE_CHARS = 80
export const MAX_NOTE_CHARS = 1000
export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_READY_BYTES = 256 * 1024
export const MAX_DELIVERY_FILES = 500
export const MAX_NAME_CHARS = 200
export const MAX_VERSION_CHARS = 40
export const MAX_PACKS = 200
export const MAX_PACK_CHARS = 80
export const MAX_MODS = 1000
export const MAX_MOD_CHARS = 200

export const REQUEST_ID = /^r-\d{8}-\d{6}-[a-z0-9]{4}$/
export const REQUEST_FILE = /^r-\d{8}-\d{6}-[a-z0-9]{4}\.json$/
export const SHA256_HEX = /^[0-9a-f]{64}$/

const ALLOWED_EXTENSIONS = ['.package', '.ts4script'] as const
const WINDOWS_BAD = /[<>:"|?*\\/]/
// Windows device names with or without extension or spaces before the dot (matching relay/names.mjs and gate.ts).
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/i
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const CONTROL_ANY = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const EMAIL_PATTERN = /[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+/g
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function hasControl(text: string, opts?: { allowNewline?: boolean }): boolean {
  return (opts?.allowNewline ? CONTROL_EXCEPT_NEWLINE : CONTROL_ANY).test(text)
}

/** Length in Unicode code points, matching relay/lib.mjs. */
export function charCount(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}

export function truncateCodePoints(text: string, maxChars: number): string {
  if (charCount(text) <= maxChars) return text
  const out: string[] = []
  for (const ch of text) {
    if (out.length >= maxChars) break
    out.push(ch)
  }
  return out.join('')
}

/**
 * Truncates by UTF-16 code units (`.length`, matching relay/request.mjs for version, packs, and mods)
 * without ever splitting a UTF-16 surrogate pair.
 */
export function truncateUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > maxUnits) break
    out += ch
  }
  return out
}

/** Why a delivery file name is refused, or null when it is safe on Windows and matches relay/names.mjs. */
export function badDeliveryFileName(name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return 'empty or too long'
  if (name.includes('/') || name.includes('\\')) return 'contains a slash'
  if (name.includes('..')) return 'contains ".."'
  if (hasControl(name)) return 'contains control characters'
  if (WINDOWS_BAD.test(name) || /[ .]$/.test(name) || name.startsWith('.')) return 'not a safe Windows file name'
  if (WINDOWS_DEVICE.test(name)) return 'Windows reserved device name'
  const lower = name.toLowerCase()
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'unsupported file extension'
  return null
}

/** True when any two file names collide ignoring ASCII/Unicode letter case (Windows collision). */
export function hasCaseDuplicates(names: readonly string[]): boolean {
  const seen = new Set<string>()
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

export const MOD_FOLDER_PREFIX = 'From Tyler - '

/**
 * Turns a delivery title into a safe Windows folder name for Mods/From Tyler - <title>/. The folder sits directly
 * in Mods, so a .ts4script inside is at depth 1, the deepest the game loads scripts from. With the 80-character
 * title cap the whole name stays at most 93 code points (173 UTF-16 units), under the 255-unit Windows limit.
 */
export function safeModFolderName(title: string, requestId: string): string {
  return `${MOD_FOLDER_PREFIX}${safeTitlePart(title, requestId)}`
}

function safeTitlePart(title: string, requestId: string): string {
  let cleaned = title
    .replace(new RegExp(CONTROL_ANY.source, 'g'), ' ')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^[. ]+|[. ]+$/g, '')

  cleaned = truncateCodePoints(cleaned, MAX_TITLE_CHARS).replace(/[. ]+$/g, '')

  if (
    cleaned === '' ||
    cleaned === '.' ||
    cleaned === '..' ||
    cleaned.includes('..') ||
    WINDOWS_BAD.test(cleaned) ||
    WINDOWS_DEVICE.test(cleaned)
  ) {
    return requestId
  }
  return cleaned
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function randomBase36(length: number): string {
  let out = ''
  while (out.length < length) {
    const buf = randomBytes(length * 2)
    for (const byte of buf) {
      // 252 = 36 * 7: unbiased rejection sampling across 36 characters.
      if (byte < 252) {
        out += ID_ALPHABET[byte % 36]!
        if (out.length === length) break
      }
    }
  }
  return out
}

/** Generates r-<yyyymmdd>-<hhmmss>-<4 random a-z0-9>, matching gate.ts and relay/lib.mjs. */
export function newRequestId(now: Date): string {
  const y = now.getUTCFullYear()
  const mo = pad2(now.getUTCMonth() + 1)
  const d = pad2(now.getUTCDate())
  const h = pad2(now.getUTCHours())
  const mi = pad2(now.getUTCMinutes())
  const s = pad2(now.getUTCSeconds())
  return `r-${y}${mo}${d}-${h}${mi}${s}-${randomBase36(4)}`
}

const WIN_DRIVE_PATH = /[A-Za-z]:\\(?:[^\r\n'"<>|*?]+\\)*[^\s'"<>|*?]+/g
const WIN_UNC_PATH = /\\\\[^\s\\'"<>|*?]+\\[^\s'"<>|*?]+/g
const UNIX_ABS_PATH = /(?:^|(?<=[\s'"`(]))\/(?:Users|home|private|var|tmp|Volumes|etc|opt|usr)\/[^\s'"<>)]+/g

/**
 * Cleans line endings, strips control characters, and removes pasted file paths, Windows usernames,
 * and email addresses from her typed request text so none reach the shared request file.
 */
export function sanitizeRequestText(
  raw: string,
  redact?: (text: string) => string,
  userNames: readonly string[] = []
): string {
  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(new RegExp(CONTROL_EXCEPT_NEWLINE.source, 'g'), '')

  if (redact) {
    text = redact(text)
  }

  text = text
    .replace(WIN_DRIVE_PATH, '')
    .replace(WIN_UNC_PATH, '')
    .replace(UNIX_ABS_PATH, '')
    .replace(EMAIL_PATTERN, '')

  for (const user of userNames) {
    if (user.length === 0) continue
    const pat = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(user)}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu')
    text = text.replace(pat, '')
  }

  text = text.replace(/<user>/gi, '')

  return text
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function collectUserNames(env: Record<string, string | undefined>): string[] {
  const names = new Set<string>()
  for (const [k, v] of Object.entries(env)) {
    const key = k.toLowerCase()
    if (typeof v !== 'string' || v.trim() === '') continue
    if (key === 'username' || key === 'user') {
      names.add(v.trim())
    } else if (key === 'userprofile' || key === 'home') {
      const last = v.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.trim()
      if (last) names.add(last)
    }
  }
  return [...names].sort((a, b) => b.length - a.length)
}

/**
 * Strips paths, email addresses, Windows usernames, and control characters from metadata strings
 * (such as mod group labels) before writing a request file. Truncates by UTF-16 `.length` to match relay/request.mjs.
 */
export function sanitizeMetadataLabel(
  value: string,
  maxUtf16Units: number,
  redact: (text: string) => string,
  userNames: readonly string[]
): string | null {
  let clean = value.replace(new RegExp(CONTROL_ANY.source, 'g'), ' ').trim()
  if (clean === '') return null

  clean = redact(clean)
  clean = clean.replace(EMAIL_PATTERN, '').trim()

  // If a label looks like a path, keep only the final non-empty segment if it isn't empty/redacted.
  if (/[\\/]/.test(clean) || /^[A-Za-z]:/.test(clean)) {
    const segments = clean.split(/[\\/]+/).filter((s) => s !== '' && s !== '<user>' && !/^[A-Za-z]:$/.test(s))
    clean = segments[segments.length - 1] ?? ''
  }

  for (const user of userNames) {
    if (user.length === 0) continue
    const pat = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(user)}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu')
    clean = clean.replace(pat, '').trim()
  }

  clean = clean.replace(/<user>/gi, '').replace(/\s+/g, ' ').trim()
  if (clean === '') return null
  return truncateUtf16(clean, maxUtf16Units)
}
