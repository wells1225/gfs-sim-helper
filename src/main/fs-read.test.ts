// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openForRead, readStream, sha256File } from './fs-read.ts'

describe('fs-read', () => {
  it('reads a byte range and computes sha256 without exposing write methods', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-helper-fs-read-'))
    const file = join(dir, 'sample.bin')
    const content = Buffer.from('DBPF-hello-sims-4-world!', 'utf8')
    try {
      await writeFile(file, content)

      const reader = await openForRead(file)
      try {
        expect(reader.size).toBe(content.byteLength)
        expect(Object.keys(reader).sort()).toEqual(['close', 'read', 'size'])
        expect('write' in reader).toBe(false)
        expect('truncate' in reader).toBe(false)

        const slice = new Uint8Array(5)
        const bytesRead = await reader.read(slice, 5)
        expect(bytesRead).toBe(5)
        expect(Buffer.from(slice).toString('utf8')).toBe('hello')
      } finally {
        await reader.close()
        await reader.close()
      }

      const expectedHash = createHash('sha256').update(content).digest('hex')
      expect(await sha256File(file)).toBe(expectedHash)

      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        const stream = readStream(file)
        stream.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        })
        stream.on('error', reject)
        stream.on('end', resolve)
      })
      expect(Buffer.concat(chunks).equals(content)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
