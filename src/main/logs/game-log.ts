import type { IsoTime, LogKind, LogReport } from '../../shared/model.ts'
import {
  decodeEntities,
  extractFirstLine,
  extractPythonFrames,
  extractUiFrames,
  extractVersion,
  normalizeFilePath
} from './decode.ts'

const REPORT_OPEN = '<report>'
const REPORT_CLOSE = '</report>'

function extractTag(chunk: string, tag: string, allowUnclosed = false): { value: string | null; unclosed: boolean } {
  const openTag = `<${tag}>`
  const startIdx = chunk.indexOf(openTag)
  if (startIdx === -1) return { value: null, unclosed: false }
  const valueStart = startIdx + openTag.length
  const closeTag = `</${tag}>`
  const endIdx = chunk.indexOf(closeTag, valueStart)
  if (endIdx === -1) {
    return allowUnclosed ? { value: chunk.slice(valueStart), unclosed: true } : { value: null, unclosed: true }
  }
  return { value: chunk.slice(valueStart, endIdx), unclosed: false }
}

function cleanText(raw: string | null): string | null {
  if (raw === null) return null
  const decoded = decodeEntities(raw).trim()
  return decoded.length > 0 ? decoded : null
}

function baseFileName(file: string): string {
  const normalized = normalizeFilePath(file)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

// A lastCrash file is a crash even when its <type> is missing or cut off, so it can never name a mod.
function determineKind(rawType: string | null, file: string): LogKind {
  const name = baseFileName(file).toLowerCase()
  if (rawType?.toLowerCase() === 'crash' || name.startsWith('lastcrash')) return 'crash'
  if (name.startsWith('lastuiexception')) return 'uiException'
  return 'exception'
}

export function parseGameLog(text: string, file: string, fileModifiedAt: IsoTime): LogReport[] {
  const normalizedFile = normalizeFilePath(file)
  const grouped = new Map<string, LogReport>()
  const results: LogReport[] = []

  let pos = 0
  // Reused while still ahead, so many <report> tags with no (or one far) </report> never rescan the text.
  let closeIdx = -2
  while (pos < text.length) {
    const openIdx = text.indexOf(REPORT_OPEN, pos)
    if (openIdx === -1) break

    const contentStart = openIdx + REPORT_OPEN.length
    if (closeIdx !== -1 && closeIdx < contentStart) closeIdx = text.indexOf(REPORT_CLOSE, contentStart)
    const nextOpenIdx = text.indexOf(REPORT_OPEN, contentStart)

    let chunk: string
    let cutOff: boolean
    if (closeIdx !== -1 && (nextOpenIdx === -1 || closeIdx < nextOpenIdx)) {
      chunk = text.slice(contentStart, closeIdx)
      cutOff = false
      pos = closeIdx + REPORT_CLOSE.length
    } else if (nextOpenIdx !== -1) {
      chunk = text.slice(contentStart, nextOpenIdx)
      cutOff = true
      pos = nextOpenIdx
    } else {
      chunk = text.slice(contentStart)
      cutOff = true
      pos = text.length
    }

    const rawType = cleanText(extractTag(chunk, 'type').value)
    const kind = determineKind(rawType, normalizedFile)
    const createdLocal = cleanText(extractTag(chunk, 'createtime').value)
    const buildSignature = cleanText(extractTag(chunk, 'buildsignature').value)
    const gameVersion = extractVersion(buildSignature)
    const categoryId = cleanText(extractTag(chunk, 'categoryid').value)

    const desyncTag = extractTag(chunk, 'desyncdata', true)
    if (desyncTag.unclosed) {
      cutOff = true
    }

    const groupKey = `${kind}\0${categoryId === null ? 'null' : `id:${categoryId}`}`
    const existing = grouped.get(groupKey)
    if (existing) {
      existing.count += 1
      if (cutOff) {
        existing.completeness = 'cut-off'
      }
      continue
    }

    let message: string | null = null
    let frames: LogReport['frames'] = []
    let modHints: string[] = []

    if (kind !== 'crash' && desyncTag.value !== null) {
      const lines = decodeEntities(desyncTag.value).split(/\r?\n|\r/)
      message = extractFirstLine(lines)
      if (kind === 'uiException') {
        frames = extractUiFrames(lines)
        modHints = []
      } else {
        const extracted = extractPythonFrames(lines)
        frames = extracted.frames
        modHints = extracted.modHints
      }
    }

    const report: LogReport = {
      file: normalizedFile,
      kind,
      fileModifiedAt,
      createdLocal,
      gameVersion,
      categoryId,
      message,
      count: 1,
      frames,
      modHints,
      completeness: cutOff ? 'cut-off' : 'complete'
    }
    grouped.set(groupKey, report)
    results.push(report)
  }

  return results
}
