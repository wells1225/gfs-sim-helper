import type { IsoTime, LogReport } from '../../shared/model.ts'
import {
  capMessage,
  decodeEntities,
  extractPythonFrames,
  extractVersion,
  normalizeFilePath,
  stripHtmlTags
} from './decode.ts'

const GAME_VERSION_LINE_PATTERN = /\bgame\s+version\s*:\s*([^\r\n]*)/i
const TIMESTAMP_PATTERN = /\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\b/
const PYTHON_ERROR_LINE_PATTERN = /^\s*[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)\b/

function extractMcccMessage(lines: readonly string[], lastFrameLineIndex: number): string | null {
  if (lastFrameLineIndex >= 0) {
    let fallback: string | null = null
    for (let i = lastFrameLineIndex + 1; i < lines.length; i += 1) {
      const trimmed = lines[i]!.trim()
      if (trimmed.length === 0) continue
      if (PYTHON_ERROR_LINE_PATTERN.test(trimmed)) {
        return capMessage(trimmed)
      }
      if (fallback === null) {
        fallback = trimmed
      }
    }
    if (fallback !== null) {
      return capMessage(fallback)
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (PYTHON_ERROR_LINE_PATTERN.test(trimmed)) {
      return capMessage(trimmed)
    }
  }

  return null
}

export function parseMccc(html: string, file: string, fileModifiedAt: IsoTime): LogReport[] {
  const plainText = decodeEntities(stripHtmlTags(html))
  const lines = plainText.split(/\r?\n|\r/)

  let gameVersion: string | null = null
  let createdLocal: string | null = null

  for (const line of lines) {
    if (gameVersion === null) {
      const versionLine = GAME_VERSION_LINE_PATTERN.exec(line)
      if (versionLine) {
        gameVersion = extractVersion(versionLine[1]!)
      }
    }
    if (createdLocal === null) {
      const tsMatch = TIMESTAMP_PATTERN.exec(line)
      if (tsMatch) {
        createdLocal = tsMatch[1]!
      }
    }
    if (gameVersion !== null && createdLocal !== null) break
  }

  const { frames, modHints, lastFrameLineIndex } = extractPythonFrames(lines)
  const message = extractMcccMessage(lines, lastFrameLineIndex)

  if (frames.length === 0 && gameVersion === null && message === null && createdLocal === null) {
    return []
  }

  return [
    {
      file: normalizeFilePath(file),
      kind: 'mccc',
      fileModifiedAt,
      createdLocal,
      gameVersion,
      categoryId: null,
      message,
      count: 1,
      frames,
      modHints,
      completeness: 'complete'
    }
  ]
}
