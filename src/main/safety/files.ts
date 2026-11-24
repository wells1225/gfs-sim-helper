import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKUP_ALSO_SKIPS, CACHE_NAMES } from '../ports.ts'
import { exists, isInside, manifestPath } from './where.ts'

export interface ListedFile {
  path: string // relative to the Sims folder, forward slashes
  abs: string
  bytes: number
  mtimeMs: number
}

const SKIPPED_AT_TOP = new Set([...CACHE_NAMES, ...BACKUP_ALSO_SKIPS].map((name) => name.replace(/\/$/, '').toLowerCase()))

/**
 * The one file lister for both the backup and the backup check, so the two always agree on what is there.
 * Skips the caches at the top of the folder. A link is kept only when it points at a file inside the folder;
 * links to folders are not followed. Any read error is thrown.
 */
export async function listFolderFiles(folderPath: string, only?: 'Mods'): Promise<ListedFile[]> {
  const realRoot = await realpath(folderPath)
  const start = only ? join(folderPath, only) : folderPath
  if (only && !(await exists(start))) return []
  const found: ListedFile[] = []

  async function walk(dir: string, top: boolean): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (top && SKIPPED_AT_TOP.has(entry.name.toLowerCase())) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, false)
      } else if (entry.isFile()) {
        const info = await lstat(full)
        found.push({ path: manifestPath(folderPath, full), abs: full, bytes: info.size, mtimeMs: info.mtimeMs })
      } else if (entry.isSymbolicLink()) {
        let target: string
        try {
          target = await realpath(full)
        } catch {
          continue // a broken link
        }
        if (!isInside(target, realRoot)) continue
        const info = await stat(full)
        if (!info.isFile()) continue
        found.push({ path: manifestPath(folderPath, full), abs: full, bytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }

  await walk(start, !only)
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
