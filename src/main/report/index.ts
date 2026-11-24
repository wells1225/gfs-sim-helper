import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { GateRefusal, ReportResult, Scan } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'

const MAX_REPORT_FILE_BYTES = 8 * 1024 * 1024
const ALLOWED_CURSEFORGE_BASENAME = 'addongameinstance.json'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatReportTimestamp(date: Date): string {
  const y = date.getUTCFullYear()
  const mo = pad2(date.getUTCMonth() + 1)
  const d = pad2(date.getUTCDate())
  const h = pad2(date.getUTCHours())
  const mi = pad2(date.getUTCMinutes())
  const s = pad2(date.getUTCSeconds())
  return `${y}${mo}${d}-${h}${mi}${s}`
}

function normalizeRelEntry(relPath: string): string | null {
  const normalized = relPath.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized) return null
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  return parts.join('/')
}

function joinFolderPath(folderPath: string, relPosix: string): string {
  if (folderPath.includes('\\') && !folderPath.includes('/')) {
    const trimmed = folderPath.replace(/\\+$/, '')
    return `${trimmed}\\${relPosix.replaceAll('/', '\\')}`
  }
  return join(folderPath, ...relPosix.split('/'))
}

function fileBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return redact(value)
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, redact))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[redact(k)] = redactJsonValue(v, redact)
    }
    return out
  }
  return value
}

function formatGateRefusal(refusal: GateRefusal): string {
  return refusal.reason
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}

export function planReport(
  scan: Scan,
  redact: (text: string) => string
): { name: string; source: { file: string } | { json: unknown } }[] {
  const entries: { name: string; source: { file: string } | { json: unknown } }[] = []
  const seenNames = new Set<string>()

  const addEntry = (rawName: string, source: { file: string } | { json: unknown }): void => {
    const name = redact(rawName).replaceAll('\\', '/').replace(/^\/+/, '')
    const key = name.toLowerCase()
    if (!name || seenNames.has(key)) return
    seenNames.add(key)
    entries.push({ name, source })
  }

  for (const log of scan.logs) {
    const rel = normalizeRelEntry(log.file)
    if (!rel) continue
    addEntry(rel, { file: joinFolderPath(scan.folder.path, rel) })
  }

  addEntry('Options.ini', { file: joinFolderPath(scan.folder.path, 'Options.ini') })
  addEntry('GameVersion.txt', { file: joinFolderPath(scan.folder.path, 'GameVersion.txt') })
  addEntry('scan.json', { json: redactJsonValue(scan, redact) })

  if (scan.inventory.curseForge.status === 'found') {
    const cfFile = scan.inventory.curseForge.file
    if (fileBasename(cfFile).toLowerCase() === ALLOWED_CURSEFORGE_BASENAME) {
      addEntry('AddonGameInstance.json', { file: cfFile })
    }
  }

  return entries
}

export async function buildReport(
  deps: Pick<AppContext, 'gate' | 'paths' | 'clock' | 'redact'>,
  scan: Scan
): Promise<{ result: ReportResult; file: string | null }> {
  try {
    const fileName = `Sims Helper report ${formatReportTimestamp(deps.clock.now())}.zip`
    const destPath = join(deps.paths.desktopDir, fileName)
    const planned = planReport(scan, deps.redact)

    const zipEntries: Record<string, Uint8Array> = {}
    const skippedLines: string[] = []

    for (const entry of planned) {
      if ('json' in entry.source) {
        const text = deps.redact(`${JSON.stringify(entry.source.json, null, 2)}\n`)
        zipEntries[entry.name] = strToU8(text)
        continue
      }

      let fileSize: number
      try {
        const info = await stat(entry.source.file)
        if (!info.isFile()) {
          skippedLines.push(`${entry.name} (skipped: not a regular file)`)
          continue
        }
        fileSize = info.size
      } catch (err) {
        if (isMissingFileError(err)) {
          continue
        }
        skippedLines.push(`${entry.name} (skipped: unreadable)`)
        continue
      }

      if (fileSize > MAX_REPORT_FILE_BYTES) {
        skippedLines.push(`${entry.name} (skipped: larger than 8 MB)`)
        continue
      }

      try {
        const raw = await readFile(entry.source.file)
        if (raw.byteLength > MAX_REPORT_FILE_BYTES) {
          skippedLines.push(`${entry.name} (skipped: larger than 8 MB)`)
          continue
        }
        const redactedText = deps.redact(raw.toString('utf8'))
        zipEntries[entry.name] = strToU8(redactedText)
      } catch (err) {
        if (isMissingFileError(err)) {
          continue
        }
        skippedLines.push(`${entry.name} (skipped: unreadable)`)
      }
    }

    if (skippedLines.length > 0) {
      const skippedText = deps.redact(`${skippedLines.join('\n')}\n`)
      zipEntries['skipped.txt'] = strToU8(skippedText)
    }

    const zipBytes = zipSync(zipEntries, { level: 6 })

    const gateResult = await deps.gate.run({
      reason: 'report',
      folderPath: null,
      ops: [
        {
          op: 'write',
          path: destPath,
          data: zipBytes,
          mode: 'create'
        }
      ]
    })

    if (gateResult.status === 'done') {
      return {
        result: {
          status: 'saved',
          fileName,
          entries: Object.keys(zipEntries)
        },
        file: destPath
      }
    }

    if (gateResult.status === 'refused') {
      return {
        result: {
          status: 'failed',
          why: 'write-refused',
          detail: formatGateRefusal(gateResult.refusal)
        },
        file: null
      }
    }

    return {
      result: {
        status: 'failed',
        why: 'unexpected',
        detail: gateResult.detail
      },
      file: null
    }
  } catch (err) {
    return {
      result: {
        status: 'failed',
        why: 'unexpected',
        detail: err instanceof Error ? err.message : String(err)
      },
      file: null
    }
  }
}
