import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChangedModItem, IsoTime, ModFile, ModGroup, Scan, ScanChanges } from '../../shared/model.ts'
import type { Gate } from '../ports.ts'
import { normalizePathForCompare } from './index.ts'

const SNAPSHOT_FORMAT = 1
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOT_GROUPS = 50_000
const SHA256_HEX = /^[0-9a-f]{64}$/
const EMAIL_DELIMITER = /[\s@<>'"`()[\]{},;:]/
const UNICODE_LETTER = /\p{L}/u
const LEADING_NON_WORD = /^[^\p{L}\p{M}\p{N}_]+/u
const NON_WORD_CHAR = /[^\p{L}\p{M}\p{N}_]/u

export interface SnapshotGroup {
  idHash: string
  label: string
  hasScript: boolean
  fileCount: number
  bytes: number
  latestModifiedAt: IsoTime | null
  fileId: number | null
  fileDate: IsoTime | null
  filesDigest: string
}

export interface ScanSnapshot {
  format: 1
  folderHash: string
  at: IsoTime
  gameVersion: string | null
  groups: SnapshotGroup[]
}

export interface RecordScanSnapshotOptions {
  redact?: (text: string) => string
  maxBytes?: number
}

export function folderFingerprint(folderPath: string): string {
  return createHash('sha256').update(normalizePathForCompare(folderPath)).digest('hex')
}

export function groupFingerprint(groupId: string): string {
  return createHash('sha256').update(groupId).digest('hex')
}

export function snapshotPathFor(stateDir: string, folderHash: string): string {
  return join(stateDir, `last-scan-${folderHash.slice(0, 16)}.json`)
}

function redactUnderscoreParts(piece: string, redact: (text: string) => string): string {
  if (!piece.includes('_')) return piece
  return piece
    .split(/(_+)/)
    .map((sub, subIdx) => (subIdx % 2 === 1 || sub.length === 0 ? sub : redact(sub)))
    .join('')
}

function redactDotOrUnderscorePiece(piece: string, redact: (text: string) => string): string {
  const redacted = redact(piece)
  if (redacted !== piece) return redacted
  if (piece.includes('.')) {
    return piece
      .split(/(\.+)/)
      .map((part, idx) => {
        if (idx % 2 === 1 || part.length === 0) return part
        const redactedPart = redact(part)
        if (redactedPart !== part) return redactedPart
        return redactUnderscoreParts(part, redact)
      })
      .join('')
  }
  return redactUnderscoreParts(piece, redact)
}

function redactToken(tok: string, redact: (text: string) => string): string {
  if (tok.length === 0) return tok

  const direct = redact(tok)
  if (direct !== tok) return direct

  const leadMatch = LEADING_NON_WORD.exec(tok)
  const start = leadMatch ? leadMatch[0].length : 0
  if (start === tok.length) return tok

  let end = tok.length
  while (end > start) {
    const code = tok.charCodeAt(end - 1)
    const step =
      code >= 0xdc00 &&
      code <= 0xdfff &&
      end - 2 >= start &&
      tok.charCodeAt(end - 2) >= 0xd800 &&
      tok.charCodeAt(end - 2) <= 0xdbff
        ? 2
        : 1
    if (!NON_WORD_CHAR.test(tok.slice(end - step, end))) break
    end -= step
  }

  if (end > start && end - start < tok.length) {
    const core = tok.slice(start, end)
    const inner = redact(core)
    if (inner !== core) {
      return `${tok.slice(0, start)}${inner}${tok.slice(end)}`
    }
  }

  return tok
    .split(/([^\p{L}\p{M}\p{N}_.]+)/u)
    .map((piece, idx) => {
      if (idx % 2 === 1 || piece.length === 0) return piece
      return redactDotOrUnderscorePiece(piece, redact)
    })
    .join('')
}

function redactSegment(segment: string, redact: (text: string) => string): string {
  if (segment.length === 0) return segment
  return segment
    .split(/(\s+)/)
    .map((piece, idx) => (idx % 2 === 1 ? piece : redactToken(piece, redact)))
    .join('')
}

function redactChunk(chunk: string, redact?: (text: string) => string): string {
  if (!redact || chunk.length === 0) return chunk
  return chunk
    .split(/([\\/]+)/)
    .map((piece, idx) => (idx % 2 === 1 ? piece : redactSegment(piece, redact)))
    .join('')
}

function isValidEmailDomain(domain: string): boolean {
  const parts = domain.split('.')
  if (parts.length < 2) return false
  for (const part of parts) {
    if (part.length === 0) return false
  }
  const tld = parts[parts.length - 1]!
  return tld.length >= 2 && UNICODE_LETTER.test(tld)
}

function maskEmails(text: string, transform?: (chunk: string) => string): string {
  if (!text.includes('@')) {
    return transform ? transform(text) : text
  }

  const out: string[] = []
  let outFrom = 0
  let cursor = 0

  while (cursor < text.length) {
    const at = text.indexOf('@', cursor)
    if (at === -1) break

    let left = at
    while (left > outFrom && !EMAIL_DELIMITER.test(text[left - 1]!)) {
      left -= 1
    }

    let right = at + 1
    while (
      right < text.length &&
      !EMAIL_DELIMITER.test(text[right]!) &&
      !(text[right] === '.' && text[right + 1] === '.')
    ) {
      right += 1
    }

    let domainEnd = right
    while (domainEnd > at + 1 && text[domainEnd - 1] === '.') {
      domainEnd -= 1
    }

    if (left < at && at + 1 < domainEnd && isValidEmailDomain(text.slice(at + 1, domainEnd))) {
      if (left > outFrom) {
        const chunk = text.slice(outFrom, left)
        out.push(transform ? transform(chunk) : chunk)
      }
      out.push('<email>')
      outFrom = domainEnd
      cursor = domainEnd
    } else if (text[right] === '@') {
      cursor = at + 1
    } else {
      cursor = right > at + 1 ? right : at + 1
    }
  }

  if (outFrom < text.length) {
    const tail = text.slice(outFrom)
    out.push(transform ? transform(tail) : tail)
  }

  return out.join('')
}

export function sanitizeSnapshotLabel(label: string, redact?: (text: string) => string): string {
  return maskEmails(label, redact ? (chunk) => redactChunk(chunk, redact) : undefined)
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function computeFilesDigest(files: readonly ModFile[]): string {
  const entries = files.map((file) => `${file.relPath}\0${file.bytes}\0${file.modifiedAt}`).sort(compareCodeUnits)
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function latestModifiedAt(files: readonly ModFile[]): IsoTime | null {
  let latest: IsoTime | null = null
  let latestMs = -Infinity

  for (const file of files) {
    const ms = Date.parse(file.modifiedAt)
    if (!Number.isFinite(ms)) continue
    if (latest === null || ms > latestMs || (ms === latestMs && file.modifiedAt > latest)) {
      latest = file.modifiedAt
      latestMs = ms
    }
  }

  return latest
}

export function buildScanSnapshot(scan: Scan, redact?: (text: string) => string): ScanSnapshot {
  const filesByGroup = new Map<string, ModFile[]>()
  for (const file of scan.inventory.files) {
    const list = filesByGroup.get(file.groupId)
    if (list) {
      list.push(file)
    } else {
      filesByGroup.set(file.groupId, [file])
    }
  }

  const groups: SnapshotGroup[] = scan.inventory.groups
    .map((group) => {
      const groupFiles = filesByGroup.get(group.id) ?? []
      return {
        idHash: groupFingerprint(group.id),
        label: sanitizeSnapshotLabel(group.label, redact),
        hasScript: group.hasScript,
        fileCount: groupFiles.length,
        bytes: group.bytes,
        latestModifiedAt: latestModifiedAt(groupFiles),
        fileId: group.curseForge?.fileId ?? null,
        fileDate: group.curseForge?.fileDate ?? null,
        filesDigest: computeFilesDigest(groupFiles)
      }
    })
    .sort((a, b) => compareCodeUnits(a.idHash, b.idHash))

  return {
    format: SNAPSHOT_FORMAT,
    folderHash: folderFingerprint(scan.folder.path),
    at: scan.at,
    gameVersion: scan.game?.version ?? null,
    groups
  }
}

function isValidIso(value: unknown): value is IsoTime {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function parseSnapshotGroup(value: unknown): SnapshotGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>

  const idHash = obj['idHash']
  const label = obj['label']
  const hasScript = obj['hasScript']
  const fileCount = obj['fileCount']
  const bytes = obj['bytes']
  const latestMod = obj['latestModifiedAt']
  const fileId = obj['fileId']
  const fileDate = obj['fileDate']
  const filesDigest = obj['filesDigest']

  if (typeof idHash !== 'string' || !SHA256_HEX.test(idHash)) return null
  if (typeof label !== 'string') return null
  if (typeof hasScript !== 'boolean') return null
  if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (latestMod !== null && !isValidIso(latestMod)) return null
  if (fileId !== null && (typeof fileId !== 'number' || !Number.isFinite(fileId))) return null
  if (fileDate !== null && !isValidIso(fileDate)) return null
  if (typeof filesDigest !== 'string' || !SHA256_HEX.test(filesDigest)) return null

  return {
    idHash,
    label,
    hasScript,
    fileCount,
    bytes,
    latestModifiedAt: latestMod,
    fileId,
    fileDate,
    filesDigest
  }
}

export function parseScanSnapshot(raw: string, expectedHash: string): ScanSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  if (obj['format'] !== SNAPSHOT_FORMAT) return null
  if (typeof obj['folderHash'] !== 'string' || obj['folderHash'] !== expectedHash) return null
  if (!isValidIso(obj['at'])) return null

  const gameVersion = obj['gameVersion']
  if (gameVersion !== null && typeof gameVersion !== 'string') return null

  const rawGroups = obj['groups']
  if (!Array.isArray(rawGroups) || rawGroups.length > MAX_SNAPSHOT_GROUPS) return null

  const groups: SnapshotGroup[] = []
  const seenIds = new Set<string>()
  for (const item of rawGroups) {
    const group = parseSnapshotGroup(item)
    if (group === null || seenIds.has(group.idHash)) return null
    seenIds.add(group.idHash)
    groups.push(group)
  }

  return {
    format: SNAPSHOT_FORMAT,
    folderHash: expectedHash,
    at: obj['at'],
    gameVersion,
    groups
  }
}

export async function readScanSnapshot(stateDir: string, expectedHash: string): Promise<ScanSnapshot | null> {
  const snapshotPath = snapshotPathFor(stateDir, expectedHash)
  try {
    const dirInfo = await lstat(stateDir)
    if (!dirInfo.isDirectory()) return null

    const fileInfo = await lstat(snapshotPath)
    if (!fileInfo.isFile() || fileInfo.size > MAX_SNAPSHOT_BYTES) return null

    const [realFile, realDir] = await Promise.all([realpath(snapshotPath), realpath(stateDir)])
    if (normalizePathForCompare(realFile) !== normalizePathForCompare(join(realDir, basename(snapshotPath)))) {
      return null
    }

    const raw = await readFile(snapshotPath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) return null

    return parseScanSnapshot(raw, expectedHash)
  } catch {
    return null
  }
}

function compareChangedMod(a: ChangedModItem, b: ChangedModItem): number {
  if (a.hasScript !== b.hasScript) return a.hasScript ? -1 : 1
  const labelCmp = compareCodeUnits(a.label.toLowerCase(), b.label.toLowerCase())
  if (labelCmp !== 0) return labelCmp
  return compareCodeUnits(a.groupId, b.groupId)
}

function groupChanged(prev: SnapshotGroup, next: SnapshotGroup): boolean {
  return (
    prev.fileCount !== next.fileCount ||
    prev.bytes !== next.bytes ||
    prev.latestModifiedAt !== next.latestModifiedAt ||
    prev.fileId !== next.fileId ||
    prev.fileDate !== next.fileDate ||
    prev.filesDigest !== next.filesDigest
  )
}

export function diffScanSnapshots(
  prev: ScanSnapshot,
  next: ScanSnapshot,
  currentGroups?: readonly ModGroup[]
): ScanChanges {
  const gameVersion =
    prev.gameVersion !== null && next.gameVersion !== null && prev.gameVersion !== next.gameVersion
      ? { from: prev.gameVersion, to: next.gameVersion }
      : null

  const prevById = new Map(prev.groups.map((group) => [group.idHash, group]))
  const nextById = new Map(next.groups.map((group) => [group.idHash, group]))
  const liveByHash = new Map((currentGroups ?? []).map((group) => [groupFingerprint(group.id), group]))

  const added: ChangedModItem[] = []
  const updated: ChangedModItem[] = []
  const removed: ChangedModItem[] = []

  for (const nextGroup of next.groups) {
    const prevGroup = prevById.get(nextGroup.idHash)
    const liveGroup = liveByHash.get(nextGroup.idHash)
    const item: ChangedModItem = {
      groupId: liveGroup?.id ?? nextGroup.idHash,
      label: liveGroup?.label ?? nextGroup.label,
      hasScript: nextGroup.hasScript
    }
    if (!prevGroup) {
      added.push(item)
    } else if (groupChanged(prevGroup, nextGroup)) {
      updated.push(item)
    }
  }

  for (const prevGroup of prev.groups) {
    if (!nextById.has(prevGroup.idHash)) {
      removed.push({
        groupId: `removed:${prevGroup.idHash.slice(0, 16)}`,
        label: prevGroup.label,
        hasScript: prevGroup.hasScript
      })
    }
  }

  added.sort(compareChangedMod)
  updated.sort(compareChangedMod)
  removed.sort(compareChangedMod)

  return {
    sinceAt: prev.at,
    gameVersion,
    added,
    updated,
    removed
  }
}

export async function writeScanSnapshot(
  gate: Gate,
  stateDir: string,
  snapshot: ScanSnapshot,
  opts?: { maxBytes?: number }
): Promise<boolean> {
  const maxBytes = opts?.maxBytes ?? MAX_SNAPSHOT_BYTES
  const data = `${JSON.stringify(snapshot)}\n`
  if (Buffer.byteLength(data, 'utf8') > maxBytes || snapshot.groups.length > MAX_SNAPSHOT_GROUPS) {
    return false
  }
  const path = snapshotPathFor(stateDir, snapshot.folderHash)
  await gate.run({
    reason: 'state',
    folderPath: null,
    ops: [
      { op: 'mkdir', path: stateDir },
      { op: 'write', path, data, mode: 'replace' }
    ]
  })
  return true
}

export async function recordScanSnapshot(
  gate: Gate,
  stateDir: string,
  scan: Scan,
  opts?: RecordScanSnapshotOptions
): Promise<ScanChanges | null> {
  try {
    if (scan.inventory.skipped.length > 0 || scan.inventory.modsDirState === 'missing') {
      return null
    }
    const next = buildScanSnapshot(scan, opts?.redact)
    const prev = await readScanSnapshot(stateDir, next.folderHash)
    if (prev !== null) {
      const prevMs = Date.parse(prev.at)
      const nextMs = Date.parse(next.at)
      if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && prevMs > nextMs) {
        return null
      }
    }
    const changes = prev ? diffScanSnapshots(prev, next, scan.inventory.groups) : null
    try {
      await writeScanSnapshot(gate, stateDir, next, { maxBytes: opts?.maxBytes })
    } catch {
      // Best-effort save: never fail a check-up if saving the snapshot fails or is refused.
    }
    return changes
  } catch {
    return null
  }
}
