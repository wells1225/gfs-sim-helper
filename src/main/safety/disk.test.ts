// @vitest-environment node
import { statfs } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freeBytes } from './disk.ts'

vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }))

beforeEach(() => {
  vi.mocked(statfs).mockReset()
})

describe('freeBytes', () => {
  it('climbs to the nearest existing parent on ENOENT, but fails closed on permission or I/O errors', async () => {
    vi.mocked(statfs)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ bavail: 100n, bsize: 4096n } as unknown as Awaited<ReturnType<typeof statfs>>)
    expect(await freeBytes('/fake/data/backups')).toBe(409_600)

    vi.mocked(statfs).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(freeBytes('/fake/mount/backups')).rejects.toThrow('denied')
    expect(vi.mocked(statfs)).toHaveBeenCalledTimes(3)
  })
})
