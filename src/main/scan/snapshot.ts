import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChangedModItem, IsoTime, ModFile, Scan, ScanChanges } from '../../shared/model.ts'
import type { Gate } from '../ports.ts'
import { normalizePathForCompare } from './index.ts'

const SNAPSHOT_FORMAT = 1
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOT_GROUPS = 50_000
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface SnapshotGroup {
  id: string
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

export function folderFingerprint(folderPath: string): string {
  return createHash('sha256').update(normalizePathForCompare(folderPath)).digest('hex')
}

export function snapshotPathFor(stateDir: string, folderHash: string): string {
  return join(stateDir, `last-scan-${folderHash.slice(0, 16)}.json`)
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

export function buildScanSnapshot(scan: Scan): ScanSnapshot {
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
        id: group.id,
        label: group.label,
        hasScript: group.hasScript,
        fileCount: groupFiles.length,
        bytes: group.bytes,
        latestModifiedAt: latestModifiedAt(groupFiles),
        fileId: group.curseForge?.fileId ?? null,
        fileDate: group.curseForge?.fileDate ?? null,
        filesDigest: computeFilesDigest(groupFiles)
      }
    })
    .sort((a, b) => compareCodeUnits(a.id, b.id))

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

  const id = obj['id']
  const label = obj['label']
  const hasScript = obj['hasScript']
  const fileCount = obj['fileCount']
  const bytes = obj['bytes']
  const latestMod = obj['latestModifiedAt']
  const fileId = obj['fileId']
  const fileDate = obj['fileDate']
  const filesDigest = obj['filesDigest']

  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof label !== 'string') return null
  if (typeof hasScript !== 'boolean') return null
  if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (latestMod !== null && !isValidIso(latestMod)) return null
  if (fileId !== null && (typeof fileId !== 'number' || !Number.isFinite(fileId))) return null
  if (fileDate !== null && !isValidIso(fileDate)) return null
  if (typeof filesDigest !== 'string' || !SHA256_HEX.test(filesDigest)) return null

  return {
    id,
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
    if (group === null || seenIds.has(group.id)) return null
    seenIds.add(group.id)
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

export function diffScanSnapshots(prev: ScanSnapshot, next: ScanSnapshot): ScanChanges {
  const gameVersion =
    prev.gameVersion !== null && next.gameVersion !== null && prev.gameVersion !== next.gameVersion
      ? { from: prev.gameVersion, to: next.gameVersion }
      : null

  const prevById = new Map(prev.groups.map((group) => [group.id, group]))
  const nextById = new Map(next.groups.map((group) => [group.id, group]))

  const added: ChangedModItem[] = []
  const updated: ChangedModItem[] = []
  const removed: ChangedModItem[] = []

  for (const nextGroup of next.groups) {
    const prevGroup = prevById.get(nextGroup.id)
    if (!prevGroup) {
      added.push({ groupId: nextGroup.id, label: nextGroup.label, hasScript: nextGroup.hasScript })
    } else if (groupChanged(prevGroup, nextGroup)) {
      updated.push({ groupId: nextGroup.id, label: nextGroup.label, hasScript: nextGroup.hasScript })
    }
  }

  for (const prevGroup of prev.groups) {
    if (!nextById.has(prevGroup.id)) {
      removed.push({ groupId: prevGroup.id, label: prevGroup.label, hasScript: prevGroup.hasScript })
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

export async function writeScanSnapshot(gate: Gate, stateDir: string, snapshot: ScanSnapshot): Promise<void> {
  const path = snapshotPathFor(stateDir, snapshot.folderHash)
  await gate.run({
    reason: 'state',
    folderPath: null,
    ops: [
      { op: 'mkdir', path: stateDir },
      { op: 'write', path, data: `${JSON.stringify(snapshot)}\n`, mode: 'replace' }
    ]
  })
}

export async function recordScanSnapshot(
  gate: Gate,
  stateDir: string,
  scan: Scan
): Promise<ScanChanges | null> {
  try {
    const next = buildScanSnapshot(scan)
    const prev = await readScanSnapshot(stateDir, next.folderHash)
    const changes = prev ? diffScanSnapshots(prev, next) : null
    try {
      await writeScanSnapshot(gate, stateDir, next)
    } catch {
      // Best-effort save: never fail a check-up if saving the snapshot fails or is refused.
    }
    return changes
  } catch {
    return null
  }
}
