import type { LogFrame } from '../../shared/model.ts'

export const MAX_FRAMES = 60
export const MAX_MESSAGE_LENGTH = 300

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'ul'
])

const VERSION_PATTERN = /\d+\.\d+\.\d+\.\d+/
const PYTHON_FRAME_PATTERN = /\bFile\s+"([^"\r\n]+)",\s*line\s+(\d+)/
// The name starts with a non-space so `\s+` and the name cannot trade characters (that backtracks quadratically).
const UI_FRAME_PATTERN = /^\s*at\s+([^\s()][^\r\n()]*)\(\)/
const PY_EXTENSION_PATTERN = /\.(?:py|pyc|pyo)$/

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    ENTITY_PATTERN,
    (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec !== undefined) {
        const codePoint = Number.parseInt(dec, 10)
        return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
      }
      if (hex !== undefined) {
        const codePoint = Number.parseInt(hex, 16)
        return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
      }
      if (named !== undefined) {
        const decoded = NAMED_ENTITIES[named.toLowerCase()]
        return decoded ?? match
      }
      return match
    }
  )
}

function stripBlockTag(html: string, tagName: string): string {
  const openRe = new RegExp(`<${tagName}\\b[^<>]*>`, 'gi')
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi')
  let result = ''
  let pos = 0

  while (pos < html.length) {
    openRe.lastIndex = pos
    const openMatch = openRe.exec(html)
    if (!openMatch) {
      return pos === 0 ? html : result + html.slice(pos)
    }
    closeRe.lastIndex = openMatch.index + openMatch[0].length
    const closeMatch = closeRe.exec(html)
    if (!closeMatch) {
      return pos === 0 ? html : result + html.slice(pos)
    }
    result += html.slice(pos, openMatch.index)
    result += '\n'
    pos = closeMatch.index + closeMatch[0].length
  }

  return result
}

export function stripHtmlTags(html: string): string {
  if (!html.includes('<')) return html
  const withoutBlocks = stripBlockTag(stripBlockTag(html, 'script'), 'style')
  return withoutBlocks.replace(/<[^<>]*>/g, (tag) => {
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)
    if (!nameMatch) return ''
    return BLOCK_TAGS.has(nameMatch[1]!.toLowerCase()) ? '\n' : ''
  })
}

export function normalizeFilePath(file: string): string {
  return file.replaceAll('\\', '/')
}

export function extractVersion(text: string | null): string | null {
  if (!text) return null
  const match = VERSION_PATTERN.exec(text)
  return match ? match[0] : null
}

export function capMessage(text: string | null): string | null {
  if (text === null) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > MAX_MESSAGE_LENGTH ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : trimmed
}

export function extractFirstLine(lines: readonly string[]): string | null {
  for (const line of lines) {
    const message = capMessage(line)
    if (message !== null) return message
  }
  return null
}

// Game code lives under T:\InGame\. A pseudo-file such as <frozen importlib._bootstrap> or <string> is the
// interpreter's own, never a file a mod ships.
function isGameFramePath(normalizedPath: string): boolean {
  return normalizedPath.startsWith('t:/ingame/') || normalizedPath.startsWith('<')
}

export function extractPythonFrames(lines: readonly string[]): {
  frames: LogFrame[]
  modHints: string[]
  lastFrameLineIndex: number
} {
  const allFrames: LogFrame[] = []
  const seenHints = new Set<string>()
  const modHints: string[] = []
  let lastFrameLineIndex = -1

  for (let i = 0; i < lines.length; i += 1) {
    const match = PYTHON_FRAME_PATTERN.exec(lines[i]!)
    if (!match) continue
    const framePath = match[1]!
    const lineNum = Number.parseInt(match[2]!, 10)
    const normalized = framePath.replaceAll('\\', '/').toLowerCase()
    const origin: 'game' | 'mod' = isGameFramePath(normalized) ? 'game' : 'mod'
    // Hints come from every frame, before the cap: mod injectors often sit at the outer end of a long traceback.
    if (origin === 'mod') {
      const hint = normalized.replace(PY_EXTENSION_PATTERN, '')
      if (hint.length > 0 && !seenHints.has(hint)) {
        seenHints.add(hint)
        modHints.push(hint)
      }
    }
    allFrames.push({
      path: framePath,
      line: Number.isFinite(lineNum) ? lineNum : null,
      origin
    })
    lastFrameLineIndex = i
  }

  const frames = allFrames.length > MAX_FRAMES ? allFrames.slice(-MAX_FRAMES) : allFrames
  return { frames, modHints, lastFrameLineIndex }
}

// ActionScript lists the innermost call first. Keep the 60 innermost and return them innermost last.
export function extractUiFrames(lines: readonly string[]): LogFrame[] {
  const frames: LogFrame[] = []
  for (const line of lines) {
    const match = UI_FRAME_PATTERN.exec(line)
    if (!match) continue
    const name = match[1]!.trim()
    if (name.length === 0) continue
    frames.push({ path: name, line: null, origin: 'game' })
    if (frames.length >= MAX_FRAMES) break
  }
  return frames.reverse()
}
