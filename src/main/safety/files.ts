import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKUP_ALSO_SKIPS, CACHE_NAMES } from '../ports.ts'
import { manifestPath } from './where.ts'

export interface ListedFile {
  path: string // relative to the Sims folder, forward slashes
  abs: string
  bytes: number
  mtimeMs: number
}

export interface SkippedLink {
  path: string // relative to the Sims folder, forward slashes
  reason: 'link'
}

export interface FolderListing {
  files: ListedFile[]
  skipped: SkippedLink[]
}

const SKIPPED_AT_TOP = new Set([...CACHE_NAMES, ...BACKUP_ALSO_SKIPS].map((name) => name.replace(/\/$/, '').toLowerCase()))

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The one file lister for both the backup and the backup check, so the two always agree on what is there.
 * Skips the caches at the top of the folder. Every symbolic link (file, folder, broken, inside or outside) is
 * skipped and returned in `skipped`, matching the write gate's plain-files-only rule. Any read error is thrown.
 */
export async function listFolderFiles(folderPath: string, only?: 'Mods'): Promise<FolderListing> {
  const start = only ? join(folderPath, only) : folderPath
  if (only) {
    let info
    try {
      info = await lstat(start)
    } catch (err) {
      if (isMissing(err)) return { files: [], skipped: [] }
      throw err
    }
    if (info.isSymbolicLink()) return { files: [], skipped: [{ path: only, reason: 'link' }] }
    if (!info.isDirectory()) throw new Error(`${only} is not a folder`)
  }
  const files: ListedFile[] = []
  const skipped: SkippedLink[] = []

  async function walk(dir: string, top: boolean): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (top && SKIPPED_AT_TOP.has(entry.name.toLowerCase())) continue
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.push({ path: manifestPath(folderPath, full), reason: 'link' })
      } else if (entry.isDirectory()) {
        await walk(full, false)
      } else {
        const info = await lstat(full)
        if (info.isSymbolicLink()) {
          skipped.push({ path: manifestPath(folderPath, full), reason: 'link' })
        } else if (info.isDirectory()) {
          await walk(full, false)
        } else if (info.isFile()) {
          files.push({ path: manifestPath(folderPath, full), abs: full, bytes: info.size, mtimeMs: info.mtimeMs })
        }
      }
    }
  }

  await walk(start, !only)
  const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { files: files.sort(byPath), skipped: skipped.sort(byPath) }
}
