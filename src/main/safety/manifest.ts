import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

function safeManifestPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.startsWith('/')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function validManifestFile(line: unknown): line is ManifestFile {
  const item = line as ManifestFile | null
  return (
    safeManifestPath(item?.path) &&
    typeof item?.bytes === 'number' &&
    typeof item?.mtimeMs === 'number' &&
    typeof item?.sha256 === 'string' &&
    typeof item?.storedIn === 'string' &&
    isSafeId(item.storedIn)
  )
}

/** null when the manifest is missing or cannot be read: such a backup never counts. */
export async function readManifest(backupsDir: string, id: string): Promise<Manifest | null> {
  if (!isSafeId(id)) return null
  try {
    const parsed = JSON.parse(await readFile(manifestFile(backupsDir, id), 'utf8')) as Manifest
    if (!parsed?.record || !Array.isArray(parsed.files) || parsed.record.id !== id) return null
    if (!parsed.files.every(validManifestFile)) return null
    return parsed
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
