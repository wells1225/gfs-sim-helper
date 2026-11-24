import { unzipSync } from 'fflate'
import { openForRead } from '../fs-read.ts'
import type { ReadOnlyFile } from '../fs-read.ts'
import type { ScriptRead } from '../../shared/model.ts'

const MAX_SCRIPT_BYTES = 64 * 1024 * 1024

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

  const entries: string[] = []
  try {
    unzipSync(data, {
      filter(entry) {
        entries.push(entry.name.replaceAll('\\', '/'))
        return false
      }
    })
  } catch (err) {
    return { status: 'broken', detail: formatError(err) }
  }

  return { status: 'ok', entries }
}
