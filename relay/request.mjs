// Checks one request file from the shared folder and builds the email about it.
// A request is `{ format: 1, id, at, text, game: { version, packs }, mods: [group labels] }` (docs/plan/briefs/pr-17.md).

import { REQUEST_ID, charCount, hasControl } from './lib.mjs'

export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_TEXT_CHARS = 2000
const MAX_AT_CHARS = 40
const MAX_VERSION_CHARS = 40
const MAX_PACKS = 200
const MAX_PACK_CHARS = 80
const MAX_MODS = 1000
const MAX_MOD_CHARS = 200

/**
 * Returns { ok: true, request } with only the known fields, or { ok: false, reason }.
 * `reason` never quotes anything from the file: it is safe to log.
 */
export function validateRequest(raw, expectedId) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not an object' }
  if (data.format !== 1) return { ok: false, reason: 'format is not 1' }
  if (typeof data.id !== 'string' || !REQUEST_ID.test(data.id)) return { ok: false, reason: 'id is missing or malformed' }
  if (data.id !== expectedId) return { ok: false, reason: 'id does not match the file name' }

  if (typeof data.at !== 'string' || data.at.length > MAX_AT_CHARS || hasControl(data.at) || Number.isNaN(Date.parse(data.at))) {
    return { ok: false, reason: 'at is missing or not a time' }
  }

  if (typeof data.text !== 'string') return { ok: false, reason: 'text is missing' }
  // A Windows text box may send CRLF; treat it as a plain newline.
  const text = data.text.replace(/\r\n/g, '\n')
  if (text.trim().length === 0) return { ok: false, reason: 'text is empty' }
  if (charCount(text) > MAX_TEXT_CHARS) return { ok: false, reason: `text is longer than ${MAX_TEXT_CHARS} characters` }
  if (hasControl(text, { allowNewline: true })) return { ok: false, reason: 'text has control characters' }

  const game = data.game
  if (!game || typeof game !== 'object' || Array.isArray(game)) return { ok: false, reason: 'game is missing' }
  const version = game.version
  if (version !== null && (typeof version !== 'string' || version.length > MAX_VERSION_CHARS || hasControl(version))) {
    return { ok: false, reason: 'game.version is not a short string' }
  }
  const packs = game.packs
  if (!Array.isArray(packs) || packs.length > MAX_PACKS) return { ok: false, reason: 'game.packs is not a short list' }
  for (const p of packs) {
    if (typeof p !== 'string' || p.length > MAX_PACK_CHARS || hasControl(p)) return { ok: false, reason: 'game.packs has a bad entry' }
  }

  const mods = data.mods
  if (!Array.isArray(mods) || mods.length > MAX_MODS) return { ok: false, reason: 'mods is not a short list' }
  for (const m of mods) {
    if (typeof m !== 'string' || m.length > MAX_MOD_CHARS || hasControl(m)) return { ok: false, reason: 'mods has a bad entry' }
  }

  return {
    ok: true,
    request: { format: 1, id: data.id, at: data.at, text, game: { version, packs: [...packs] }, mods: [...mods] },
  }
}

/**
 * Quoted-printable (RFC 2045) for UTF-8 text: every line is at most 76 characters, far under SMTP's 998-byte limit,
 * however long her text or the mod list is. A mail reader shows the original text unchanged.
 */
export function quotedPrintable(text) {
  const out = []
  for (const line of text.split('\n')) {
    const bytes = Buffer.from(line, 'utf8')
    const tokens = []
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      const last = i === bytes.length - 1
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)
      tokens.push(plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`)
    }
    let current = ''
    for (const tok of tokens) {
      if (current.length + tok.length > 75) {
        out.push(`${current}=`)
        current = ''
      }
      current += tok
    }
    out.push(current)
  }
  return out.join('\n')
}

/** The email as one RFC 5322 message for `msmtp -t`. The To address is the only config value in it. */
export function buildEmail(to, request) {
  if (typeof to !== 'string' || /[\r\n]/.test(to) || hasControl(to)) throw new Error('The To address has a line break.')
  const list = (items) => (items.length > 0 ? items.join(', ') : 'none listed')
  const body = [
    'Lila asked for a mod.',
    '',
    'What she wrote:',
    '',
    request.text,
    '',
    `Game version: ${request.game.version ?? 'unknown'}`,
    `Packs: ${list(request.game.packs)}`,
    `Mods she has: ${list(request.mods)}`,
    '',
    `Request: ${request.id} (sent ${request.at})`,
    '',
    'Build it in T3: gfs-sim-helper',
    '',
    'When it is built, deliver it on tyler-M8 with:',
    `  node relay/deliver.mjs ${request.id} <folder with the mod files> --title "..." --note "..." [--has-script]`,
    '',
  ].join('\n')
  const headers = [
    `To: ${to}`,
    'Subject: Lila asked for a mod',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    'Auto-Submitted: auto-generated',
  ].join('\n')
  return `${headers}\n\n${quotedPrintable(body)}`
}
