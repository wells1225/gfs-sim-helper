import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, type Handlers, type IpcInvoke } from '../shared/ipc.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import type { AppContext } from './ports.ts'
import { scanHandlers } from './scan/handlers.ts'
import { shareHandlers } from './share/handlers.ts'
import { updateHandlers } from './update/handlers.ts'

export type IpcMainLike = Pick<IpcMain, 'handle'>
export type IsAppWindow = (event: IpcMainInvokeEvent) => boolean

export function collectHandlers(ctx: AppContext): Handlers<keyof IpcInvoke> {
  const groups = [
    scanHandlers(ctx),
    fixHandlers(ctx),
    fiftyHandlers(ctx),
    assistHandlers(ctx),
    updateHandlers(ctx),
    shareHandlers(ctx)
  ]
  const merged: Record<string, (req: unknown) => Promise<unknown>> = {}

  for (const group of groups) {
    for (const [channel, fn] of Object.entries(group)) {
      if (channel in merged) {
        throw new Error(`Duplicate IPC handler for channel: ${channel}`)
      }
      merged[channel] = fn as (req: unknown) => Promise<unknown>
    }
  }

  for (const channel of INVOKE_CHANNELS) {
    if (!(channel in merged)) {
      throw new Error(`Missing IPC handler for channel: ${channel}`)
    }
  }

  if (Object.keys(merged).length !== INVOKE_CHANNELS.length) {
    const allowed = new Set<string>(INVOKE_CHANNELS)
    const extra = Object.keys(merged).filter((c) => !allowed.has(c))
    throw new Error(`Unexpected IPC handlers: ${extra.join(', ')}`)
  }

  return merged as unknown as Handlers<keyof IpcInvoke>
}

/**
 * true: the call can change her files or this app's data, so ctx.busy() holds from its first line to its last and a
 * restart for an update cannot land between two of its steps. Never true for update:*: update:install asks busy()
 * itself, and update:check's one write (the time of the last check, through the gate) is busy-counted by gate.run.
 * The start-up recovery is busy-counted by safety.recover, so the journal reads that wait for it stay false.
 * share:get is false on purpose: its two small housekeeping writes (a link put back after an undone Get, through
 * gate.run, and safety.closeUndo for a slot she has played since) are each busy-counted on their own and each is
 * done again on the next look if the app stops between them. A look every 60 s must not make Restart now answer busy.
 * A new channel fails typecheck until it is named here.
 */
export const CHANGING_CHANNELS = {
  'settings:get': false,
  'settings:update': true,
  'locate:run': false,
  'scan:run': false,
  'game:check': false,
  'report:build': true,
  'report:reveal': false,
  'backup:status': false,
  'fix:apply': true,
  'journal:list': false, // reads only; waits for the start-up recovery
  'journal:recovery': false,
  'journal:undo': true,
  'groups:disabled': false,
  'fifty:get': false,
  'fifty:start': true,
  'fifty:begin-round': true,
  'fifty:answer': true,
  'fifty:stop': true,
  'fifty:finish': true,
  'assist:status': false,
  'assist:preview': false,
  'assist:send': false,
  'assist:set-key': true,
  'assist:clear-key': true,
  'update:get': false,
  'update:check': false,
  'update:download': false,
  'update:install': false,
  'share:get': false,
  'share:set-role': true,
  'share:find-folder': true,
  'share:check': true,
  'share:settings': true,
  'share:local-saves': false,
  'share:send': true,
  'share:receive': true, // so an update cannot restart the app in the middle of a Get
  'share:keep': true,
  'share:old-saves': false,
  'share:restore': true,
  'share:stop': true,
  'share:mod-link': true,
  'share:open-link': false,
  'share:find-preview': false,
  'share:find-send': false
} as const satisfies Record<keyof IpcInvoke, boolean>

const ERRNO_PREFIX = /^[A-Z][A-Z0-9_]{1,30}:\s/
const ASCII_LETTER = /^[A-Za-z]$/
const ASCII_UPPER = /^[A-Z]$/
const ASCII_DIGIT = /^\d$/
const WORD_CHAR = /^\w$/
const WHITESPACE = /^\s$/
const UNIX_ANCHOR_BEFORE = /^[\s'"(\[{=,]$/
const TRAILING_PUNCT = /^[.,;:!?]$/
const FILE_EXT = /^[A-Za-z][A-Za-z0-9]{0,11}$/
const DIGITS_ONLY = /^\d+$/
const VERSION_WORD = /^[vV]\d+(?:\.\d+)*$/

const KNOWN_UNIX_ROOTS = new Set([
  'Users',
  'Volumes',
  'Applications',
  'Library',
  'System',
  'private',
  'home',
  'root',
  'etc',
  'var',
  'tmp',
  'opt',
  'usr',
  'bin',
  'sbin',
  'dev',
  'proc',
  'sys',
  'run',
  'mnt',
  'media',
  'srv',
  'nix',
  'snap'
])

const MAX_BRIDGE_CHARS = 120
const MAX_BRIDGE_WORDS = 8
const MAX_FINAL_WORDS = 4

const isAsciiLetter = (ch: string): boolean => ASCII_LETTER.test(ch)
const isAsciiDigit = (ch: string): boolean => ASCII_DIGIT.test(ch)
const isWordChar = (ch: string): boolean => WORD_CHAR.test(ch)
const isWhitespace = (ch: string): boolean => WHITESPACE.test(ch)
const isLineBreak = (ch: string): boolean => ch === '\n' || ch === '\r'
const isUnixAnchorBefore = (text: string, pos: number): boolean => pos === 0 || UNIX_ANCHOR_BEFORE.test(text[pos - 1]!)
const isTrailingPunct = (ch: string): boolean => TRAILING_PUNCT.test(ch)
const isDigitsOnly = (word: string): boolean => DIGITS_ONLY.test(word)

function hasFileExtension(segment: string): boolean {
  const dot = segment.lastIndexOf('.')
  return dot > 0 && dot < segment.length - 1 && FILE_EXT.test(segment.slice(dot + 1))
}

function isFolderWord(word: string): boolean {
  return (
    ASCII_UPPER.test(word[0] ?? '') ||
    word === '(x86)' ||
    word === 'x86' ||
    word === 'x64' ||
    DIGITS_ONLY.test(word) ||
    VERSION_WORD.test(word)
  )
}

interface BracketCounts {
  parens: number
  brackets: number
}

function consumeSegmentToken(text: string, start: number, counts: BracketCounts): number {
  let i = start
  while (i < text.length) {
    const ch = text[i]!
    if (
      isWhitespace(ch) ||
      ch === '/' ||
      ch === '\\' ||
      ch === '"' ||
      ch === '`' ||
      ch === '|' ||
      ch === '*' ||
      ch === '?' ||
      ch === '{' ||
      ch === '}'
    ) {
      break
    }
    if (ch === '<') {
      if (text.startsWith('<user>', i)) {
        i += 6
        continue
      }
      break
    }
    if (ch === '>') break
    if (ch === "'") {
      if (i > start && i + 1 < text.length && isWordChar(text[i + 1]!)) {
        i += 1
        continue
      }
      break
    }
    if (ch === ':') {
      if (i + 1 < text.length && (isAsciiDigit(text[i + 1]!) || isAsciiLetter(text[i + 1]!))) {
        i += 1
        continue
      }
      break
    }
    if (ch === '(') {
      counts.parens += 1
      i += 1
      continue
    }
    if (ch === ')') {
      if (counts.parens > 0) {
        counts.parens -= 1
        i += 1
        continue
      }
      break
    }
    if (ch === '[') {
      counts.brackets += 1
      i += 1
      continue
    }
    if (ch === ']') {
      if (counts.brackets > 0) {
        counts.brackets -= 1
        i += 1
        continue
      }
      break
    }
    i += 1
  }
  return i
}

function consumeSeparator(text: string, pos: number, kind: 'win' | 'unix' | 'url'): number {
  const ch = text[pos]
  if (ch === '\\') {
    let end = pos + 1
    while (end < text.length && text[end] === '\\') end += 1
    return end
  }
  if (ch === '/' && text[pos + 1] !== '/') {
    return pos + 1
  }
  if (kind === 'url' && ch === '/') {
    let end = pos + 1
    while (end < text.length && text[end] === '/') end += 1
    return end
  }
  return pos
}

function isBridgeSeparator(text: string, pos: number, kind: 'win' | 'unix' | 'url'): number {
  if (kind === 'win') {
    if (text[pos] !== '\\') return pos
    let end = pos + 1
    while (end < text.length && text[end] === '\\') end += 1
    return end
  }
  if (text[pos] === '/' && text[pos + 1] !== '/') {
    return pos + 1
  }
  return pos
}

interface PathStartMatch {
  prefixEnd: number
  kind: 'win' | 'unix' | 'url'
}

function matchPathStart(text: string, pos: number, insideQuotes: boolean): PathStartMatch | null {
  if (pos >= text.length) return null
  const ch = text[pos]!

  // 1. file:// URL
  if (
    (ch === 'f' || ch === 'F') &&
    (insideQuotes || pos === 0 || !isWordChar(text[pos - 1]!)) &&
    text.slice(pos, pos + 7).toLowerCase() === 'file://'
  ) {
    let p = pos + 7
    if (text[p] === '/') p += 1
    if (p + 2 < text.length && isAsciiLetter(text[p]!) && (text[p + 1] === ':' || text[p + 1] === '|') && text[p + 2] === '/') {
      p += 3
    }
    const checkCounts: BracketCounts = { parens: 0, brackets: 0 }
    if (consumeSegmentToken(text, p, checkCounts) > p) {
      return { prefixEnd: p, kind: 'url' }
    }
  }

  // 2. Backslash device or UNC path: \\?\..., \\.\..., \\server\share... (and JSON-escaped \\\\...)
  if (ch === '\\' && text[pos + 1] === '\\' && (insideQuotes || pos === 0 || text[pos - 1] !== '\\')) {
    let p = pos
    while (p < text.length && text[p] === '\\') p += 1
    if ((text[p] === '?' || text[p] === '.') && text[p + 1] === '\\') {
      p += 1
      while (p < text.length && text[p] === '\\') p += 1
      if (text.slice(p, p + 3).toUpperCase() === 'UNC' && text[p + 3] === '\\') {
        p += 3
        while (p < text.length && text[p] === '\\') p += 1
      } else if (isAsciiLetter(text[p] ?? '') && text[p + 1] === ':' && text[p + 2] === '\\') {
        p += 2
        while (p < text.length && text[p] === '\\') p += 1
      }
      const checkCounts: BracketCounts = { parens: 0, brackets: 0 }
      if (insideQuotes || consumeSegmentToken(text, p, checkCounts) > p) {
        return { prefixEnd: p, kind: 'win' }
      }
    } else {
      const serverCounts: BracketCounts = { parens: 0, brackets: 0 }
      const serverEnd = consumeSegmentToken(text, p, serverCounts)
      if (serverEnd > p && text[serverEnd] === '\\') {
        let shareStart = serverEnd
        while (shareStart < text.length && text[shareStart] === '\\') shareStart += 1
        const shareCounts: BracketCounts = { parens: 0, brackets: 0 }
        if (consumeSegmentToken(text, shareStart, shareCounts) > shareStart) {
          return { prefixEnd: shareStart, kind: 'win' }
        }
      }
    }
  }

  // 3. Windows drive path: C:\..., C:\\..., D:/...
  if (isAsciiLetter(ch) && text[pos + 1] === ':' && (insideQuotes || pos === 0 || !isWordChar(text[pos - 1]!))) {
    const slash = text[pos + 2]
    if (slash === '\\') {
      let p = pos + 2
      while (p < text.length && text[p] === '\\') p += 1
      return { prefixEnd: p, kind: 'win' }
    }
    if (slash === '/' && text[pos + 3] !== '/') {
      const p = pos + 3
      const checkCounts: BracketCounts = { parens: 0, brackets: 0 }
      if (insideQuotes || consumeSegmentToken(text, p, checkCounts) > p) {
        return { prefixEnd: p, kind: 'unix' }
      }
    }
  }

  // 4. Forward-slash UNC path: //server/share... (never after ':')
  if (
    ch === '/' &&
    text[pos + 1] === '/' &&
    text[pos + 2] !== '/' &&
    (insideQuotes || (pos === 0 || (text[pos - 1] !== ':' && text[pos - 1] !== '/' && isUnixAnchorBefore(text, pos))))
  ) {
    const p = pos + 2
    const serverCounts: BracketCounts = { parens: 0, brackets: 0 }
    const serverEnd = consumeSegmentToken(text, p, serverCounts)
    if (serverEnd > p && text[serverEnd] === '/' && text[serverEnd + 1] !== '/') {
      const shareStart = serverEnd + 1
      const shareCounts: BracketCounts = { parens: 0, brackets: 0 }
      if (consumeSegmentToken(text, shareStart, shareCounts) > shareStart) {
        return { prefixEnd: shareStart, kind: 'unix' }
      }
    }
  }

  // 5. Home path: ~/... or ~\...
  if (
    ch === '~' &&
    (text[pos + 1] === '/' || text[pos + 1] === '\\') &&
    (insideQuotes || isUnixAnchorBefore(text, pos) || text[pos - 1] === ':')
  ) {
    const isWin = text[pos + 1] === '\\'
    if (isWin || text[pos + 2] !== '/') {
      let p = pos + 2
      while (isWin && p < text.length && text[p] === '\\') p += 1
      const checkCounts: BracketCounts = { parens: 0, brackets: 0 }
      if (insideQuotes || consumeSegmentToken(text, p, checkCounts) > p) {
        return { prefixEnd: p, kind: isWin ? 'win' : 'unix' }
      }
    }
  }

  // 6. Env paths: %LOCALAPPDATA%\..., $HOME/..., ${HOME}/..., $env:APPDATA\...
  if (ch === '%' && (insideQuotes || pos === 0 || !isWordChar(text[pos - 1]!))) {
    let p = pos + 1
    if (p < text.length && (isAsciiLetter(text[p]!) || text[p] === '_')) {
      p += 1
      while (p < text.length && isWordChar(text[p]!)) p += 1
      if (text[p] === '%' && (text[p + 1] === '\\' || (text[p + 1] === '/' && text[p + 2] !== '/'))) {
        const isWin = text[p + 1] === '\\'
        let afterSep = p + 2
        while (isWin && afterSep < text.length && text[afterSep] === '\\') afterSep += 1
        const checkCounts: BracketCounts = { parens: 0, brackets: 0 }
        if (insideQuotes || consumeSegmentToken(text, afterSep, checkCounts) > afterSep) {
          return { prefixEnd: afterSep, kind: isWin ? 'win' : 'unix' }
        }
      }
    }
  }

  if (ch === '$' && (insideQuotes || pos === 0 || !isWordChar(text[pos - 1]!))) {
    let p = pos + 1
    let braced = false
    if (text[p] === '{') {
      braced = true
      p += 1
    } else if (text.slice(p, p + 4).toLowerCase() === 'env:') {
      p += 4
    }
    if (p < text.length && (isAsciiLetter(text[p]!) || text[p] === '_')) {
      p += 1
      while (p < text.length && isWordChar(text[p]!)) p += 1
      if (!braced || text[p] === '}') {
        if (braced) p += 1
        if (text[p] === '\\' || (text[p] === '/' && text[p + 1] !== '/')) {
          const isWin = text[p] === '\\'
          let afterSep = p + 1
          while (isWin && afterSep < text.length && text[afterSep] === '\\') afterSep += 1
          const checkCounts: BracketCounts = { parens: 0, brackets: 0 }
          if (insideQuotes || consumeSegmentToken(text, afterSep, checkCounts) > afterSep) {
            return { prefixEnd: afterSep, kind: isWin ? 'win' : 'unix' }
          }
        }
      }
    }
  }

  // 7. Unix absolute path: anchored (?<=^|[\s'"(\[{=,])\/(?!\/) with 2+ segments or known root/file extension
  if (ch === '/' && text[pos + 1] !== '/' && (insideQuotes || isUnixAnchorBefore(text, pos))) {
    const p = pos + 1
    const firstChar = text[p]
    if (firstChar && (isAsciiLetter(firstChar) || isAsciiDigit(firstChar) || firstChar === '.' || firstChar === '_' || firstChar === '-' || text.startsWith('<user>', p))) {
      const segCounts: BracketCounts = { parens: 0, brackets: 0 }
      const seg1End = consumeSegmentToken(text, p, segCounts)
      const rawSeg1 = text.slice(p, seg1End)
      let cleanSeg1 = rawSeg1
      while (cleanSeg1.length > 0 && isTrailingPunct(cleanSeg1[cleanSeg1.length - 1]!)) {
        cleanSeg1 = cleanSeg1.slice(0, -1)
      }
      if (cleanSeg1.length > 0) {
        const hasSecondSegment =
          text[seg1End] === '/' &&
          text[seg1End + 1] !== '/' &&
          consumeSegmentToken(text, seg1End + 1, { parens: 0, brackets: 0 }) > seg1End + 1
        if (hasSecondSegment || KNOWN_UNIX_ROOTS.has(cleanSeg1) || hasFileExtension(cleanSeg1)) {
          return { prefixEnd: p, kind: 'unix' }
        }
      }
    }
  }

  return null
}

function stripTrailingPunct(text: string, start: number, end: number): number {
  let p = end
  while (p > start && isTrailingPunct(text[p - 1]!)) {
    p -= 1
  }
  return p
}

function scanUnquotedPathEnd(text: string, start: number, match: PathStartMatch): number {
  const counts: BracketCounts = { parens: 0, brackets: 0 }
  let segStart = match.prefixEnd
  let lastEnd = segStart

  while (segStart <= text.length) {
    const tokEnd = consumeSegmentToken(text, segStart, counts)
    if (tokEnd === segStart) {
      break
    }
    lastEnd = tokEnd

    // Immediate next path separator with no intervening space
    const afterSep = consumeSeparator(text, tokEnd, match.kind)
    if (afterSep > tokEnd) {
      lastEnd = afterSep
      segStart = afterSep
      continue
    }

    // Space inside a folder or file name
    if (text[tokEnd] === ' ') {
      const tokHadTrailingPunct = isTrailingPunct(text[tokEnd - 1]!)
      if (!tokHadTrailingPunct) {
        // Subcase A: look ahead (bounded) for a matching separator bridging a multi-word folder segment
        const savedCounts: BracketCounts = { parens: counts.parens, brackets: counts.brackets }
        let look = tokEnd
        let words = 0
        let bridgedTo = -1

        while (
          words < MAX_BRIDGE_WORDS &&
          look - tokEnd < MAX_BRIDGE_CHARS &&
          text[look] === ' ' &&
          text[look + 1] !== ' '
        ) {
          const wordStart = look + 1
          if (wordStart >= text.length || isLineBreak(text[wordStart]!)) break
          if (matchPathStart(text, wordStart, false) !== null) break
          const wordEnd = consumeSegmentToken(text, wordStart, savedCounts)
          if (wordEnd === wordStart) break
          words += 1

          const sepAfterWord = isBridgeSeparator(text, wordEnd, match.kind)
          if (sepAfterWord > wordEnd) {
            const nextTokenEnd = consumeSegmentToken(text, sepAfterWord, {
              parens: savedCounts.parens,
              brackets: savedCounts.brackets
            })
            const prevWord = text.slice(wordStart, wordEnd)
            const nextWord = text.slice(sepAfterWord, stripTrailingPunct(text, sepAfterWord, nextTokenEnd))
            const isProseSlash =
              match.kind !== 'win' &&
              ((prevWord.toLowerCase() === 'and' && nextWord.toLowerCase() === 'or') ||
                (isDigitsOnly(prevWord) && isDigitsOnly(nextWord)))
            if (
              !isProseSlash &&
              (nextTokenEnd > sepAfterWord || text[sepAfterWord] === undefined || isWhitespace(text[sepAfterWord]!))
            ) {
              counts.parens = savedCounts.parens
              counts.brackets = savedCounts.brackets
              bridgedTo = sepAfterWord
              break
            }
          }

          if (isTrailingPunct(text[wordEnd - 1]!)) break
          look = wordEnd
        }

        if (bridgedTo !== -1) {
          lastEnd = bridgedTo
          segStart = bridgedTo
          continue
        }

        // Subcase B: final segment (no further separator)
        const cleanTok0 = text.slice(segStart, stripTrailingPunct(text, segStart, tokEnd))
        if (!hasFileExtension(cleanTok0)) {
          const finalTokens: { end: number; clean: string; hadPunct: boolean }[] = []
          const fCounts: BracketCounts = { parens: counts.parens, brackets: counts.brackets }
          let cursor = tokEnd

          while (finalTokens.length < MAX_FINAL_WORDS && text[cursor] === ' ' && text[cursor + 1] !== ' ') {
            const wStart = cursor + 1
            if (wStart >= text.length || isLineBreak(text[wStart]!)) break
            if (matchPathStart(text, wStart, false) !== null) break
            const wEnd = consumeSegmentToken(text, wStart, fCounts)
            if (wEnd === wStart) break
            const cleanEnd = stripTrailingPunct(text, wStart, wEnd)
            const clean = text.slice(wStart, cleanEnd)
            if (clean.length === 0) break
            const hadPunct = cleanEnd < wEnd
            finalTokens.push({ end: wEnd, clean, hadPunct })
            if (hadPunct) break
            cursor = wEnd
          }

          let extIdx = -1
          for (let k = 0; k < finalTokens.length; k += 1) {
            if (hasFileExtension(finalTokens[k]!.clean)) {
              extIdx = k
              break
            }
          }

          if (extIdx !== -1) {
            lastEnd = finalTokens[extIdx]!.end
          } else {
            for (let k = 0; k < finalTokens.length; k += 1) {
              const item = finalTokens[k]!
              if (!isFolderWord(item.clean)) break
              lastEnd = item.end
              if (item.hadPunct) break
            }
          }
        }
      }
    }

    break
  }

  return stripTrailingPunct(text, start, lastEnd)
}

function findClosingQuote(text: string, openPos: number, quote: "'" | '"'): number {
  let i = openPos + 1
  while (i < text.length && !isLineBreak(text[i]!)) {
    const ch = text[i]!
    if (quote === '"' && ch === '\\' && text[i + 1] === '"') {
      i += 2
      continue
    }
    if (ch === quote) {
      if (quote === "'" && i > openPos + 1 && i + 1 < text.length && isAsciiLetter(text[i - 1]!) && isAsciiLetter(text[i + 1]!)) {
        // Mid-word apostrophe inside a single-quoted path (e.g. 'C:\Users\Lila's Mods\a.package'): keep scanning if another "'" exists on this line.
        let later = i + 1
        let foundLater = false
        while (later < text.length && !isLineBreak(text[later]!)) {
          if (text[later] === "'") {
            foundLater = true
            break
          }
          later += 1
        }
        if (foundLater) {
          i += 1
          continue
        }
      }
      return i
    }
    i += 1
  }
  return -1
}

function redactEmbeddedPaths(text: string): string {
  const out: string[] = []
  let i = 0
  let noSingleCloseUntil = -1
  let noDoubleCloseUntil = -1

  while (i < text.length) {
    const ch = text[i]!

    if (ch === "'" || ch === '"') {
      const noCloseUntil = ch === "'" ? noSingleCloseUntil : noDoubleCloseUntil
      if (i > noCloseUntil && matchPathStart(text, i + 1, true) !== null) {
        const closePos = findClosingQuote(text, i, ch)
        if (closePos !== -1) {
          out.push(ch, '<path>', ch)
          i = closePos + 1
          continue
        }
        let lineEnd = i + 1
        while (lineEnd < text.length && !isLineBreak(text[lineEnd]!)) lineEnd += 1
        if (ch === "'") noSingleCloseUntil = lineEnd
        else noDoubleCloseUntil = lineEnd
      }
    }

    const match = matchPathStart(text, i, false)
    if (match !== null) {
      const end = scanUnquotedPathEnd(text, i, match)
      if (end > i) {
        out.push('<path>')
        i = end
        continue
      }
    }

    out.push(ch)
    i += 1
  }

  return out.join('')
}

function isPathValue(value: unknown): boolean {
  return typeof value === 'string' || value instanceof Uint8Array || Buffer.isBuffer(value) || value instanceof URL
}

function isFsErrorObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { path?: unknown; dest?: unknown; syscall?: unknown }
  return isPathValue(candidate.path) || isPathValue(candidate.dest) || typeof candidate.syscall === 'string'
}

export function sanitizeIpcError(err: unknown, redact?: (text: string) => string): Error {
  if (isFsErrorObject(err)) {
    return new Error('A file operation failed')
  }
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Something went wrong'
  if (ERRNO_PREFIX.test(raw)) {
    return new Error('A file operation failed')
  }
  const userRedacted = redact ? redact(raw) : raw
  return new Error(redactEmbeddedPaths(userRedacted))
}

/** `handlers` is for tests; the app registers collectHandlers(ctx). */
export function registerIpc(
  ipcMain: IpcMainLike,
  ctx: AppContext,
  isAppWindow: IsAppWindow,
  handlers: Handlers<keyof IpcInvoke> = collectHandlers(ctx)
): void {
  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel] as (req: unknown) => Promise<unknown>
    ipcMain.handle(channel, async (event, req) => {
      if (!isAppWindow(event)) {
        throw new Error(`IPC call rejected on channel ${channel}: untrusted sender`)
      }
      const letGo = CHANGING_CHANNELS[channel] ? ctx.holdBusy?.() : undefined
      try {
        return await handler(req)
      } catch (err) {
        throw sanitizeIpcError(err, ctx.redact)
      } finally {
        letGo?.()
      }
    })
  }
}
