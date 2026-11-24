import { unzipSync } from 'fflate'
import { openForRead } from '../fs-read.ts'
import type { ReadOnlyFile } from '../fs-read.ts'
import type { ScriptRead } from '../../shared/model.ts'

const MAX_SCRIPT_BYTES = 64 * 1024 * 1024
const CENTRAL_ENTRY_MIN_BYTES = 46

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function listScriptEntries(file: string): Promise<ScriptRead> {
  let fh: ReadOnlyFile
  try {
    fh = await openForRead(file)
  } catch (err) {
    return { status: 'unreadable', detail: formatError(err) }
  }

  let data: Uint8Array
  try {
    if (fh.size > MAX_SCRIPT_BYTES) {
      return { status: 'broken', detail: `Script archive is ${fh.size} bytes (limit is 64 MB)` }
    }
    if (fh.size === 0) {
      return { status: 'broken', detail: 'Script archive is empty' }
    }

    data = new Uint8Array(fh.size)
    let bytesRead: number
    try {
      bytesRead = await fh.read(data, 0, fh.size)
    } catch (err) {
      return { status: 'unreadable', detail: formatError(err) }
    }

    if (bytesRead < fh.size) {
      return { status: 'broken', detail: `Read only ${bytesRead} of ${fh.size} bytes` }
    }
  } finally {
    await fh.close()
  }

  // fflate loops over the entry count the zip claims (up to 2^32 with zip64) without checking it against the
  // file. Each central directory entry takes at least 46 bytes, and a real one always has a name.
  const maxEntries = Math.floor(data.length / CENTRAL_ENTRY_MIN_BYTES)
  const entries: string[] = []
  try {
    unzipSync(data, {
      filter(entry) {
        if (entries.length >= maxEntries) {
          throw new Error('Script archive lists more entries than the file can hold')
        }
        if (entry.name === '') {
          throw new Error('Script archive has an entry with no name')
        }
        entries.push(entry.name.replaceAll('\\', '/'))
        return false
      }
    })
  } catch (err) {
    return { status: 'broken', detail: formatError(err) }
  }

  return { status: 'ok', entries }
}
