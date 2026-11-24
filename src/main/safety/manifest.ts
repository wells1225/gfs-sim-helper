import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupRecord, Sha256 } from '../../shared/model.ts'
import { samePath } from './where.ts'

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
}

export function manifestFile(backupsDir: string, id: string): string {
  return join(backupsDir, id, 'manifest.json')
}

export function storedFile(backupsDir: string, line: ManifestFile): string {
  return join(backupsDir, line.storedIn, 'files', ...line.path.split('/'))
}

/** null when the manifest is missing or cannot be read: such a backup never counts. */
export async function readManifest(backupsDir: string, id: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestFile(backupsDir, id), 'utf8')) as Manifest
    if (!parsed?.record || !Array.isArray(parsed.files) || parsed.record.id !== id) return null
    return parsed
  } catch {
    return null
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** The newest `verified` backup of this Sims folder. Backup ids sort by time, so the newest is read first. */
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
  for (const id of ids) {
    const manifest = await readManifest(backupsDir, id)
    if (manifest?.record.state === 'verified' && samePath(manifest.record.folderPath, folderPath)) return manifest
  }
  return null
}

export function manifestJson(manifest: Manifest): string {
  return JSON.stringify(manifest)
}
