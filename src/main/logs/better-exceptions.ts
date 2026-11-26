import type { IsoTime, LogReport } from '../../shared/model.ts'
import { decodeEntities } from './decode.ts'
import { parseGameLog } from './game-log.ts'

const RAW_LE_ID = 'beRawLEData'
const RAW_LE_ATTR_PATTERN = /\bid\s*=\s*["']beRawLEData["']/i

// One pass over the <div> open tags, so no search rescans text an earlier one already read.
function extractRawLeBlock(html: string): { content: string; cutOff: boolean } | null {
  const divOpen = /<div\b[^<>]*>/gi
  for (let open = divOpen.exec(html); open !== null; open = divOpen.exec(html)) {
    if (!open[0].includes(RAW_LE_ID) || !RAW_LE_ATTR_PATTERN.test(open[0])) continue
    const contentStart = open.index + open[0].length
    const closeDiv = /<\/div\s*>/gi
    closeDiv.lastIndex = contentStart
    const close = closeDiv.exec(html)
    return close
      ? { content: html.slice(contentStart, close.index), cutOff: false }
      : { content: html.slice(contentStart), cutOff: true }
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
