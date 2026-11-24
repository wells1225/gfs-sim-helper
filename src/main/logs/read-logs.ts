import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsoTime, LogReport } from '../../shared/model.ts'
import { openForRead } from '../fs-read.ts'
import { parseBetterExceptions } from './better-exceptions.ts'
import { parseGameLog } from './game-log.ts'
import { parseMccc } from './mccc.ts'

export const MAX_LOG_BYTES = 8 * 1024 * 1024
const MAX_MCCC_SUBFOLDER_DEPTH = 2

type LogParserKind = 'game' | 'betterExceptions' | 'mccc'

interface DiscoveredLog {
  fullPath: string
  relFile: string
  parser: LogParserKind
}

function classifyTopLevelFile(name: string): LogParserKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.txt')) {
    if (
      lower.startsWith('lastexception') ||
      lower.startsWith('lastuiexception') ||
      lower.startsWith('lastcrash')
    ) {
      return 'game'
    }
    return null
  }
  if (lower.endsWith('.html') && lower.startsWith('be-exceptionreport')) {
    return 'betterExceptions'
  }
  return null
}

async function collectMcccLogs(
  dir: string,
  relPrefix: string,
  depth: number,
  out: DiscoveredLog[]
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = `${relPrefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (depth < MAX_MCCC_SUBFOLDER_DEPTH) {
        await collectMcccLogs(fullPath, relPath, depth + 1, out)
      }
      continue
    }
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase() === 'mc_lastexception.html') {
      out.push({ fullPath, relFile: relPath, parser: 'mccc' })
    }
  }
}

async function readBoundedText(
  fullPath: string
): Promise<{ text: string; fileModifiedAt: IsoTime; truncated: boolean } | null> {
  let info
  try {
    info = await stat(fullPath)
    if (!info.isFile()) return null
  } catch {
    return null
  }

  let handle
  try {
    handle = await openForRead(fullPath)
  } catch {
    return null
  }

  try {
    const truncated = handle.size > MAX_LOG_BYTES
    const toRead = Math.min(handle.size, MAX_LOG_BYTES)
    const mtimeMs = info.mtime.getTime()
    const fileModifiedAt = Number.isNaN(mtimeMs) ? new Date(0).toISOString() : info.mtime.toISOString()

    if (toRead === 0) {
      return { text: '', fileModifiedAt, truncated: false }
    }

    const buffer = Buffer.allocUnsafe(toRead)
    const bytesRead = await handle.read(buffer, 0, toRead)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    return { text, fileModifiedAt, truncated }
  } catch {
    return null
  } finally {
    try {
      await handle.close()
    } catch {
      // Ignore close errors on read-only handles.
    }
  }
}

function parseDiscovered(
  parser: LogParserKind,
  text: string,
  relFile: string,
  fileModifiedAt: IsoTime,
  truncated: boolean
): LogReport[] {
  let reports: LogReport[]
  if (parser === 'game') {
    reports = parseGameLog(text, relFile, fileModifiedAt)
  } else if (parser === 'betterExceptions') {
    reports = parseBetterExceptions(text, relFile, fileModifiedAt)
  } else {
    reports = parseMccc(text, relFile, fileModifiedAt)
  }

  if (!truncated) return reports
  return reports.map((report) => ({ ...report, completeness: 'cut-off' }))
}

export async function readLogs(input: { folderPath: string }): Promise<LogReport[]> {
  let topEntries
  try {
    topEntries = await readdir(input.folderPath, { withFileTypes: true })
  } catch {
    return []
  }

  const discovered: DiscoveredLog[] = []
  let modsEntryName: string | null = null

  for (const entry of topEntries) {
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === 'mods') {
        modsEntryName = entry.name
      }
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const parser = classifyTopLevelFile(entry.name)
    if (parser !== null) {
      discovered.push({
        fullPath: join(input.folderPath, entry.name),
        relFile: entry.name,
        parser
      })
    }
  }

  if (modsEntryName !== null) {
    await collectMcccLogs(join(input.folderPath, modsEntryName), modsEntryName, 0, discovered)
  }

  const allReports: LogReport[] = []
  for (const item of discovered) {
    const read = await readBoundedText(item.fullPath)
    if (!read) continue
    allReports.push(...parseDiscovered(item.parser, read.text, item.relFile, read.fileModifiedAt, read.truncated))
  }

  allReports.sort((a, b) => {
    const timeDiff = Date.parse(b.fileModifiedAt) - Date.parse(a.fileModifiedAt)
    if (timeDiff !== 0) return timeDiff
    if (a.file < b.file) return -1
    if (a.file > b.file) return 1
    return 0
  })

  return allReports
}
