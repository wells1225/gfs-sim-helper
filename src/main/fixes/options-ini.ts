interface ParsedLine {
  text: string
  eol: string
}

function splitLinesPreservingEol(source: string): ParsedLine[] {
  if (source === '') return []
  const lines: ParsedLine[] = []
  let i = 0
  while (i < source.length) {
    let end = i
    while (end < source.length && source[end] !== '\r' && source[end] !== '\n') {
      end += 1
    }
    let eol = ''
    if (end < source.length) {
      if (source[end] === '\r' && source[end + 1] === '\n') {
        eol = '\r\n'
      } else {
        eol = source[end]!
      }
    }
    lines.push({ text: source.slice(i, end), eol })
    i = end + eol.length
  }
  return lines
}

function detectEol(source: string): string {
  if (source.includes('\r\n')) return '\r\n'
  if (source.includes('\n')) return '\n'
  return '\r\n'
}

const TARGET_VALUES: Record<string, string> = {
  modsdisabled: '0',
  scriptmodsenabled: '1'
}

const KEY_ORDER = ['modsdisabled', 'scriptmodsenabled'] as const

/**
 * Sets `modsdisabled=0` and `scriptmodsenabled=1` inside `[options]`.
 * Every other byte, unknown key, section, comment, and line ending stays unchanged.
 * Missing keys are added to `[options]` (or a new `[options]` section if absent).
 */
export function editOptionsIni(source: string): string {
  const eol = detectEol(source)
  const lines = splitLinesPreservingEol(source)

  let inOptions = false
  let optionsFound = false
  let optionsLastContentIdx = -1
  let optionsHeaderIdx = -1
  const seenKeys = new Set<string>()

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const textForMatch = i === 0 && line.text.startsWith('\uFEFF') ? line.text.slice(1) : line.text
    const trimmed = textForMatch.trim()

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1]!.trim().toLowerCase()
      inOptions = name === 'options'
      if (inOptions && !optionsFound) {
        optionsFound = true
        optionsHeaderIdx = i
        optionsLastContentIdx = i
      }
      continue
    }

    if (!inOptions) continue

    if (trimmed !== '') {
      optionsLastContentIdx = i
    }

    const kvMatch = line.text.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)([^\r\n]*)$/)
    if (!kvMatch) continue

    const [, indent, rawKey, eq] = kvMatch
    const keyLower = rawKey!.toLowerCase()
    const desired = TARGET_VALUES[keyLower]
    if (desired === undefined) continue

    seenKeys.add(keyLower)
    lines[i] = { text: `${indent!}${rawKey!}${eq!}${desired}`, eol: line.eol }
  }

  const missing = KEY_ORDER.filter((key) => !seenKeys.has(key))

  if (missing.length > 0) {
    if (optionsFound) {
      const insertAfter = optionsLastContentIdx >= 0 ? optionsLastContentIdx : optionsHeaderIdx
      const anchor = lines[insertAfter]!
      const hadFinalEol = anchor.eol !== ''
      if (!hadFinalEol) {
        lines[insertAfter] = { text: anchor.text, eol }
      }
      const additions: ParsedLine[] = missing.map((key, idx) => ({
        text: `${key}=${TARGET_VALUES[key]!}`,
        eol: hadFinalEol || idx < missing.length - 1 ? eol : ''
      }))
      lines.splice(insertAfter + 1, 0, ...additions)
    } else {
      if (lines.length > 0 && lines[lines.length - 1]!.eol === '') {
        lines[lines.length - 1] = { text: lines[lines.length - 1]!.text, eol }
      }
      lines.push({ text: '[options]', eol })
      for (const key of missing) {
        lines.push({ text: `${key}=${TARGET_VALUES[key]!}`, eol })
      }
    }
  }

  return lines.map((l) => l.text + l.eol).join('')
}
