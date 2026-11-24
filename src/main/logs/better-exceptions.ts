import type { IsoTime, LogReport } from '../../shared/model.ts'
import { decodeEntities } from './decode.ts'
import { parseGameLog } from './game-log.ts'

const RAW_LE_ID = 'beRawLEData'
const DIV_OPEN_PATTERN = /^<div\b/i
const RAW_LE_ATTR_PATTERN = /\bid\s*=\s*["']beRawLEData["']/i

function extractRawLeBlock(html: string): { content: string; cutOff: boolean } | null {
  let searchFrom = 0
  while (searchFrom < html.length) {
    const idIdx = html.indexOf(RAW_LE_ID, searchFrom)
    if (idIdx === -1) return null

    const tagStart = html.lastIndexOf('<', idIdx)
    const tagEnd = html.indexOf('>', idIdx)
    if (tagStart !== -1 && tagEnd !== -1 && html.indexOf('>', tagStart) === tagEnd) {
      const openTag = html.slice(tagStart, tagEnd + 1)
      if (DIV_OPEN_PATTERN.test(openTag) && RAW_LE_ATTR_PATTERN.test(openTag)) {
        const contentStart = tagEnd + 1
        const closeDivRe = /<\/div\s*>/gi
        closeDivRe.lastIndex = contentStart
        const closeMatch = closeDivRe.exec(html)
        if (!closeMatch) {
          return { content: html.slice(contentStart), cutOff: true }
        }
        return { content: html.slice(contentStart, closeMatch.index), cutOff: false }
      }
    }

    searchFrom = idIdx + RAW_LE_ID.length
  }

  return null
}

export function parseBetterExceptions(html: string, file: string, fileModifiedAt: IsoTime): LogReport[] {
  const block = extractRawLeBlock(html)
  if (!block) return []

  const decodedXml = decodeEntities(block.content)
  const reports = parseGameLog(decodedXml, file, fileModifiedAt)
  return reports.map((report) => ({
    ...report,
    kind: 'betterExceptions',
    completeness: block.cutOff ? 'cut-off' : report.completeness
  }))
}
