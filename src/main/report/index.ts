import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { GateRefusal, LogKind, ReportResult, Scan, Severity, Symptom } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { sanitizeSnapshotLabel } from '../scan/snapshot.ts'

const MAX_REPORT_FILE_BYTES = 8 * 1024 * 1024
const ALLOWED_CURSEFORGE_BASENAME = 'addongameinstance.json'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Her own clock, not UTC: the name on her Desktop should match the time she made it. */
function formatReportTimestamp(date: Date): string {
  const y = date.getFullYear()
  const mo = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  const h = pad2(date.getHours())
  const mi = pad2(date.getMinutes())
  const s = pad2(date.getSeconds())
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

/** Keeps redacted ZIP entry names valid on Windows Explorer (which forbids <>:"|?*). */
function safeZipEntryName(rawName: string, redact?: (text: string) => string): string {
  return sanitizeSnapshotLabel(rawName, redact)
    .replaceAll('<user>', 'user')
    .replaceAll('<email>', 'email')
    .replace(/[<>:"|?*]/g, '_')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
}

function uniqueEntryName(baseName: string, seenNames: Set<string>): string {
  if (!seenNames.has(baseName.toLowerCase())) return baseName
  const slash = baseName.lastIndexOf('/')
  const dot = baseName.lastIndexOf('.')
  const hasExt = dot > slash + 1
  const stem = hasExt ? baseName.slice(0, dot) : baseName
  const ext = hasExt ? baseName.slice(dot) : ''
  let n = 2
  while (seenNames.has(`${stem} (${n})${ext}`.toLowerCase())) {
    n += 1
  }
  return `${stem} (${n})${ext}`
}

function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return sanitizeSnapshotLabel(value, redact)
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
      out[sanitizeSnapshotLabel(k, redact)] = redactJsonValue(v, redact)
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

export const README_NAME = 'Read me.txt'
const MAX_EVIDENCE_LINES = 5
const MAX_CHANGED_NAMES = 10

const SYMPTOM_TEXT: Record<Symptom, string> = {
  closes: 'The game closes by itself',
  freezes: 'It freezes or gets stuck',
  'wont-load': "It won't open or load at all",
  'one-save-or-lot': 'One save or lot is broken',
  'not-sure': 'Not sure'
}

const SEVERITY_TEXT: Record<Severity, string> = {
  stop: 'Do this first',
  warn: 'Worth fixing',
  info: 'Good to know'
}

const SEVERITY_ORDER: Severity[] = ['stop', 'warn', 'info']

const LOG_KIND_TEXT: Record<LogKind, string> = {
  exception: 'last exception',
  uiException: 'UI exception',
  crash: 'crash log',
  betterExceptions: 'Better Exceptions',
  mccc: 'MC Command Center'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function runningText(state: Scan['gameRunning']): string {
  if (state === 'running') return 'Yes'
  if (state === 'not-running') return 'No'
  return 'Could not tell'
}

function switchText(value: 'on' | 'off' | 'missing'): string {
  return value === 'missing' ? 'not set' : value
}

function changedNames(items: { label: string }[], clean: (text: string) => string): string {
  const names = items.slice(0, MAX_CHANGED_NAMES).map((item) => clean(item.label))
  const extra = items.length - names.length
  return extra > 0 ? `${names.join(', ')}, and ${extra} more` : names.join(', ')
}

/** Swaps her full folder paths for short labels, so the summary never shows a raw drive or user path. */
function makePathScrubber(scan: Scan): (text: string) => string {
  const known: [string, string][] = []
  const add = (path: string | undefined, label: string): void => {
    const trimmed = path?.replace(/[\\/]+$/, '')
    if (!trimmed) return
    known.push([trimmed, label])
    known.push([trimmed.replaceAll('\\', '/'), label])
    known.push([trimmed.replaceAll('/', '\\'), label])
  }
  add(scan.inventory.modsDir, '[Mods folder]')
  add(scan.folder.path, '[Sims 4 folder]')
  add(scan.game?.path, '[game folder]')
  known.sort((a, b) => b[0].length - a[0].length)
  return (text: string) => {
    let out = text
    for (const [path, label] of known) {
      const pattern = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      out = out.replace(pattern, label)
    }
    return out
  }
}

/** The plain-language summary Tyler reads first. Pass deps.redact so every dynamic value is redacted without rewriting fixed headings. */
export function buildReadme(scan: Scan, redact?: (text: string) => string): string {
  const lines: string[] = []
  const inv = scan.inventory
  const scrub = makePathScrubber(scan)
  const clean = (text: string): string => sanitizeSnapshotLabel(scrub(text), redact)

  lines.push('Sims Helper report')
  lines.push(`Check-up time: ${clean(scan.at)}`)
  lines.push('')
  lines.push(`What she picked: ${SYMPTOM_TEXT[scan.symptom] ?? 'Not sure'}`)
  lines.push(`Game version: ${scan.game ? clean(scan.game.version) : 'Unknown'}`)
  lines.push(`Game was running: ${runningText(scan.gameRunning)}`)
  lines.push('')

  lines.push('Mods')
  if (inv.modsDirState === 'missing') {
    lines.push('- No Mods folder was found.')
  }
  const totalBytes = inv.files.reduce((sum, f) => sum + f.bytes, 0)
  const scriptCount = inv.groups.filter((g) => g.hasScript).length
  lines.push(`- Files: ${inv.files.length}`)
  lines.push(`- Mod groups: ${inv.groups.length}`)
  lines.push(`- Script mods: ${scriptCount}`)
  lines.push(`- Mods folder size: ${formatBytes(totalBytes)}`)
  const options = scan.facts.options
  if (options.status === 'ok') {
    lines.push(`- Options.ini: mods ${switchText(options.mods)}, script mods ${switchText(options.scriptMods)}`)
  } else if (options.status === 'missing') {
    lines.push('- Options.ini: not found')
  } else {
    lines.push('- Options.ini: could not be read')
  }
  const cfg = inv.resourceCfg
  if (cfg.status === 'ok') {
    lines.push(`- Resource.cfg: packages load up to ${plural(cfg.maxPackageDepth, 'folder', 'folders')} deep`)
  } else if (cfg.status === 'missing') {
    lines.push('- Resource.cfg: not found')
  } else {
    lines.push('- Resource.cfg: could not be read')
  }
  lines.push('')

  const changes = scan.changes
  if (
    changes &&
    (changes.gameVersion || changes.added.length > 0 || changes.updated.length > 0 || changes.removed.length > 0)
  ) {
    lines.push(`What changed since the last check-up (${clean(changes.sinceAt)})`)
    if (changes.gameVersion) {
      lines.push(`- Game updated from ${clean(changes.gameVersion.from)} to ${clean(changes.gameVersion.to)}`)
    }
    if (changes.added.length > 0) {
      lines.push(`- Added ${plural(changes.added.length, 'mod', 'mods')}: ${changedNames(changes.added, clean)}`)
    }
    if (changes.updated.length > 0) {
      lines.push(`- Updated ${plural(changes.updated.length, 'mod', 'mods')}: ${changedNames(changes.updated, clean)}`)
    }
    if (changes.removed.length > 0) {
      lines.push(`- Removed ${plural(changes.removed.length, 'mod', 'mods')}: ${changedNames(changes.removed, clean)}`)
    }
    lines.push('')
  }

  lines.push('What the check-up found')
  if (scan.findings.length === 0) {
    lines.push('No obvious mod problems were found.')
  } else {
    for (const severity of SEVERITY_ORDER) {
      for (const finding of scan.findings.filter((f) => f.severity === severity)) {
        lines.push(`[${SEVERITY_TEXT[severity]}] ${clean(finding.title)}`)
        lines.push(`  ${clean(finding.detail)}`)
        for (const ev of finding.evidence.slice(0, MAX_EVIDENCE_LINES)) {
          lines.push(`  * ${clean(ev)}`)
        }
        if (finding.evidence.length > MAX_EVIDENCE_LINES) {
          lines.push(`  * and ${finding.evidence.length - MAX_EVIDENCE_LINES} more`)
        }
      }
    }
  }
  lines.push('')

  lines.push('Crash and exception logs')
  if (scan.logs.length === 0) {
    lines.push('No readable crash or exception logs found.')
  } else {
    const logEntryNames = new Map<string, string>()
    const seenLogNames = new Set<string>()
    for (const log of scan.logs) {
      const fileKey = log.file.replaceAll('\\', '/').toLowerCase()
      let logName = logEntryNames.get(fileKey)
      if (!logName) {
        logName = uniqueEntryName(safeZipEntryName(fileBasename(log.file), redact), seenLogNames)
        seenLogNames.add(logName.toLowerCase())
        logEntryNames.set(fileKey, logName)
      }
      lines.push(`- ${logName} (${LOG_KIND_TEXT[log.kind] ?? clean(log.kind)}, ${clean(log.fileModifiedAt)})`)
    }
  }
  lines.push('')
  lines.push('Saves and Tray folders are never included in this report.')

  return `${scrub(lines.join('\n'))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2013\u2014]/g, '-')}\n`
}

export function planReport(
  scan: Scan,
  redact: (text: string) => string
): { name: string; source: { file: string } | { json: unknown } }[] {
  const entries: { name: string; source: { file: string } | { json: unknown } }[] = []
  const seenNames = new Set<string>()
  const seenFiles = new Set<string>()

  const addEntry = (rawName: string, source: { file: string } | { json: unknown }): void => {
    const baseName = safeZipEntryName(rawName, redact)
    if (!baseName) return
    if ('file' in source) {
      const fileKey = source.file.replaceAll('\\', '/').toLowerCase()
      if (seenFiles.has(fileKey)) return
      seenFiles.add(fileKey)
    }
    const name = uniqueEntryName(baseName, seenNames)
    seenNames.add(name.toLowerCase())
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

    // First entry, so it is the first thing Tyler sees when he opens the zip.
    zipEntries[README_NAME] = strToU8(buildReadme(scan, deps.redact))

    for (const entry of planned) {
      if (entry.name.toLowerCase() === README_NAME.toLowerCase()) continue
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
