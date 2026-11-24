import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import type { Sha256 } from '../shared/model.ts'

export interface ReadOnlyFile {
  readonly size: number
  read(buffer: Uint8Array, position: number, length?: number): Promise<number>
  close(): Promise<void>
}

export async function openForRead(file: string): Promise<ReadOnlyFile> {
  const handle = await open(file, 'r')
  let size: number
  try {
    size = (await handle.stat()).size
  } catch (err) {
    await handle.close()
    throw err
  }

  let closed = false

  return {
    size,
    async read(buffer: Uint8Array, position: number, length: number = buffer.byteLength): Promise<number> {
      const want = Math.min(length, buffer.byteLength)
      if (want <= 0) return 0
      let total = 0
      while (total < want) {
        const { bytesRead } = await handle.read(buffer, total, want - total, position + total)
        if (bytesRead === 0) break
        total += bytesRead
      }
      return total
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await handle.close()
    }
  }
}

export function readStream(file: string): Readable {
  return createReadStream(file, { flags: 'r' })
}

export async function sha256File(file: string): Promise<Sha256> {
  return await new Promise<Sha256>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = readStream(file)
    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      resolve(hash.digest('hex'))
    })
  })
}
