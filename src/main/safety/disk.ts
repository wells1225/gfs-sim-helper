import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Free bytes on the drive that holds `dir`, asked at its nearest existing parent. */
export async function freeBytes(dir: string): Promise<number> {
  let at = dir
  for (;;) {
    try {
      const fs = await statfs(at)
      return Number(fs.bavail) * Number(fs.bsize)
    } catch (err) {
      const parent = dirname(at)
      if (parent === at) throw err
      at = parent
    }
  }
}
