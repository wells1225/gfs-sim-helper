import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BackupRecord, Sha256 } from '../../shared/model.ts'
import type { SkippedLink } from './files.ts'
import { isSafeId, samePath } from './where.ts'

export interface ManifestFile {
  path: string // relative to the Sims folder, forward slashes
  bytes: number
  mtimeMs: number
  sha256: Sha256
  storedIn: string // the backup id that holds the bytes
}

export interface Manifest {
  record: BackupRecord
  files: ManifestFile[]
  skipped?: SkippedLink[]
}

export function manifestFile(backupsDir: string, id: string): string {
  return join(backupsDir, id, 'manifest.json')
}

export function storedFile(backupsDir: string, line: ManifestFile): string {
  return join(backupsDir, line.storedIn, 'files', ...line.path.split('/'))
}

const STRICT_ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function isStrictIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = STRICT_ISO_TIME.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (match[7] !== undefined) {
    const offHour = Number(match[8])
    const offMinute = Number(match[9])
    if (offHour > 23 || offMinute > 59) return false
  }
  return Number.isFinite(Date.parse(value))
}

export function normalizeIsoTime(value: string): string {
  return new Date(Date.parse(value)).toISOString()
}

function safeManifestPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.startsWith('/')) return false
  if (path.includes('\\') || path.includes(':') || path.includes('\0')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function storedFileStrictlyInside(backupsDir: string, line: ManifestFile): boolean {
  const filesRoot = resolve(backupsDir, line.storedIn, 'files')
  const resolvedStored = resolve(storedFile(backupsDir, line))
  const rel = relative(filesRoot, resolvedStored)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function validManifestFile(line: unknown, backupsDir: string): line is ManifestFile {
  const item = line as ManifestFile | null
  if (
    !safeManifestPath(item?.path) ||
    typeof item?.bytes !== 'number' ||
    !Number.isFinite(item.bytes) ||
    !Number.isInteger(item.bytes) ||
    item.bytes < 0 ||
    typeof item?.mtimeMs !== 'number' ||
    !Number.isFinite(item.mtimeMs) ||
    typeof item?.sha256 !== 'string' ||
    item.sha256 === '' ||
    typeof item?.storedIn !== 'string' ||
    !isSafeId(item.storedIn)
  ) {
    return false
  }
  return storedFileStrictlyInside(backupsDir, item)
}

/** null when the manifest is missing or cannot be read: such a backup never counts. */
export async function readManifest(backupsDir: string, id: string): Promise<Manifest | null> {
  if (!isSafeId(id)) return null
  try {
    const parsed = JSON.parse(await readFile(manifestFile(backupsDir, id), 'utf8')) as Manifest
    const rec = parsed?.record
    if (!rec || typeof rec !== 'object' || !Array.isArray(parsed.files) || rec.id !== id) return null
    if (!isStrictIsoTime(rec.at)) return null
    if (typeof rec.folderPath !== 'string' || rec.folderPath.length === 0 || rec.folderPath.includes('\0')) return null
    if (rec.state !== 'verified' && rec.state !== 'copying' && rec.state !== 'failed') return null
    if (typeof rec.files !== 'number' || !Number.isFinite(rec.files) || !Number.isInteger(rec.files) || rec.files < 0) {
      return null
    }
    if (typeof rec.bytes !== 'number' || !Number.isFinite(rec.bytes) || !Number.isInteger(rec.bytes) || rec.bytes < 0) {
      return null
    }
    if (!parsed.files.every((line) => validManifestFile(line, backupsDir))) return null
    const sumBytes = parsed.files.reduce((sum, f) => sum + f.bytes, 0)
    if (rec.state === 'verified') {
      if (rec.files !== parsed.files.length || rec.bytes !== sumBytes) return null
    } else {
      if (parsed.files.length > rec.files || sumBytes > rec.bytes) return null
    }
    return {
      ...parsed,
      record: { ...rec, at: normalizeIsoTime(rec.at) }
    }
  } catch {
    return null
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

const TIME_ID = /^\d{8}-\d{6}-/

export function isNewer(a: Manifest, b: Manifest): boolean {
  if (a.record.at !== b.record.at) return a.record.at > b.record.at
  return a.record.id > b.record.id
}

/** The newest `verified` backup of this Sims folder, ordered by timestamp (even within the same second). */
export async function newestVerified(backupsDir: string, folderPath: string): Promise<Manifest | null> {
  let ids: string[]
  try {
    const entries = await readdir(backupsDir, { withFileTypes: true })
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  ids.sort().reverse()
  const allTimeIds = ids.every((id) => TIME_ID.test(id))
  let best: Manifest | null = null
  for (const id of ids) {
    if (best && allTimeIds && id.slice(0, 15) < best.record.id.slice(0, 15)) break
    const manifest = await readManifest(backupsDir, id)
    if (manifest?.record.state === 'verified' && samePath(manifest.record.folderPath, folderPath)) {
      if (!best || isNewer(manifest, best)) best = manifest
    }
  }
  return best
}

export function manifestJson(manifest: Manifest): string {
  return JSON.stringify(manifest)
}
