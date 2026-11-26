import { statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Free bytes on the drive that holds `dir`, asked at its nearest existing parent. */
export async function freeBytes(dir: string): Promise<number> {
  let at = resolve(dir)
  for (;;) {
    try {
      const fs = await statfs(at)
      return Number(fs.bavail) * Number(fs.bsize)
    } catch (err) {
      if (!isMissing(err)) throw err
      const parent = dirname(at)
      if (parent === at) throw err
      at = parent
    }
  }
}
