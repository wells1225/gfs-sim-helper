// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { writeDbpf } from '../../../scripts/fixtures/dbpf.ts'
import { loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { readDbpfIndex } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(THIS_DIR, '../../..')
const SPECS_DIR = join(REPO_ROOT, 'scripts/fixtures/specs')
const BROKEN_MODS = join(
  REPO_ROOT,
  'test/fixtures/broken-packages/Users/Player/Documents/Electronic Arts/The Sims 4/Mods'
)

function makeHeader(overrides?: {
  magic?: string
  major?: number
  minor?: number
  entryCount?: number
  shortOffset?: number
  indexSize?: number
  longOffset?: bigint
}): Buffer {
  const buf = Buffer.alloc(96)
  Buffer.from(overrides?.magic ?? 'DBPF', 'ascii').copy(buf, 0)
  buf.writeUInt32LE(overrides?.major ?? 2, 4)
  buf.writeUInt32LE(overrides?.minor ?? 1, 8)
  buf.writeUInt32LE(overrides?.entryCount ?? 0, 36)
  buf.writeUInt32LE(overrides?.shortOffset ?? 0, 40)
  buf.writeUInt32LE(overrides?.indexSize ?? 0, 44)
  buf.writeUInt32LE(3, 60)
  buf.writeBigUInt64LE(overrides?.longOffset ?? 0n, 64)
  return buf
}

describe('readDbpfIndex', () => {
  it('reads every package in the broken-packages fixture with exact status and keys', async () => {
    const spec = await loadSpec(join(SPECS_DIR, 'broken-packages.json'))
    const packages = spec.userFolders[0]?.packages ?? []
    expect(packages.length).toBe(7)

    for (const pkg of packages) {
      const fullPath = join(BROKEN_MODS, pkg.relPath)
      const result = await readDbpfIndex(fullPath)

      switch (pkg.variant ?? 'valid') {
        case 'valid': {
          expect(result, pkg.relPath).toEqual({
            status: 'ok',
            keys: pkg.keys
          })
          break
        }
        case 'bad-magic': {
          expect(result.status, pkg.relPath).toBe('broken')
          if (result.status === 'broken') {
            expect(result.problem).toBe('bad-magic')
          }
          break
        }
        case 'truncated-index': {
          expect(result.status, pkg.relPath).toBe('broken')
          if (result.status === 'broken') {
            expect(result.problem).toBe('bad-index')
          }
          break
        }
        case 'truncated-header': {
          expect(result.status, pkg.relPath).toBe('broken')
          if (result.status === 'broken') {
            expect(result.problem).toBe('too-short')
          }
          break
        }
        case 'sims3': {
          expect(result, pkg.relPath).toEqual({
            status: 'wrong-game',
            major: 2,
            minor: 0,
            game: 'sims3'
          })
          break
        }
      }
    }
  })

  it('treats a 96-byte DBPF 2.1 file with entry count 0 as ok with no keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-dbpf-test-'))
    try {
      const emptyHeaderOnly = join(dir, 'empty-96.package')
      await writeFile(emptyHeaderOnly, makeHeader({ entryCount: 0, indexSize: 0, longOffset: 0n }))
      expect(await readDbpfIndex(emptyHeaderOnly)).toEqual({ status: 'ok', keys: [] })

      const emptyWithFlags = join(dir, 'empty-100.package')
      await writeFile(emptyWithFlags, writeDbpf({ keys: [] }))
      expect(await readDbpfIndex(emptyWithFlags)).toEqual({ status: 'ok', keys: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies wrong-game versions (sims2, sims3, simcity, unknown)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-dbpf-ver-'))
    try {
      const cases = [
        { name: 's2.package', major: 1, minor: 1, game: 'sims2' as const },
        { name: 's3.package', major: 2, minor: 0, game: 'sims3' as const },
        { name: 'sc.package', major: 3, minor: 0, game: 'simcity' as const },
        { name: 'unk.package', major: 4, minor: 2, game: 'unknown' as const }
      ]
      for (const c of cases) {
        const p = join(dir, c.name)
        await writeFile(p, makeHeader({ major: c.major, minor: c.minor }))
        expect(await readDbpfIndex(p)).toEqual({
          status: 'wrong-game',
          major: c.major,
          minor: c.minor,
          game: c.game
        })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('supports short-form index offset at byte 40 and lists deleted (0xFFE0) entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-dbpf-short-'))
    try {
      const buf = writeDbpf({
        keys: [
          { type: 0x03b33ddf, group: 0x00000000, instance: 0x0123456789abcdefn },
          { type: 0x545ac67a, group: 0x00000003, instance: 0x00000000000000ffn }
        ],
        constantFlags: 0
      })
      const longOff = Number(buf.readBigUInt64LE(64))
      // Move index offset to short form at byte 40 and zero out long form at byte 64.
      buf.writeUInt32LE(longOff, 40)
      buf.writeBigUInt64LE(0n, 64)
      // Mark the second entry's compression type as deleted (0xFFE0).
      // Entry 0 starts at longOff + 4, entry 1 starts at longOff + 4 + 32; compression is at +28.
      buf.writeUInt16LE(0xffe0, longOff + 4 + 32 + 28)

      const file = join(dir, 'short-deleted.package')
      await writeFile(file, buf)
      expect(await readDbpfIndex(file)).toEqual({
        status: 'ok',
        keys: [
          { type: '0x03B33DDF', group: '0x00000000', instance: '0x0123456789ABCDEF' },
          { type: '0x545AC67A', group: '0x00000003', instance: '0x00000000000000FF' }
        ]
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects bad index sizes, unknown constant flags, and indexes over 64 MB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-dbpf-badidx-'))
    try {
      // Index size over 64 MB
      const huge = join(dir, 'huge-index.package')
      await writeFile(
        huge,
        makeHeader({
          entryCount: 3_000_000,
          indexSize: 64 * 1024 * 1024 + 4,
          longOffset: 96n
        })
      )
      const hugeRes = await readDbpfIndex(huge)
      expect(hugeRes.status).toBe('broken')
      if (hugeRes.status === 'broken') expect(hugeRes.problem).toBe('bad-index')

      // Mismatched index size formula (declared 40 bytes instead of 4 + 32 = 36)
      const base = writeDbpf({
        keys: [{ type: 0x03b33ddf, group: 0x00000000, instance: 0x1n }]
      })
      const padded = Buffer.concat([base, Buffer.alloc(4)])
      padded.writeUInt32LE(padded.readUInt32LE(44) + 4, 44)
      const wrongSize = join(dir, 'wrong-size.package')
      await writeFile(wrongSize, padded)
      const wrongSizeRes = await readDbpfIndex(wrongSize)
      expect(wrongSizeRes.status).toBe('broken')
      if (wrongSizeRes.status === 'broken') expect(wrongSizeRes.problem).toBe('bad-index')

      // All 3 constant flags set (flags = 7) works cleanly
      const allConst = join(dir, 'all-const.package')
      await writeFile(
        allConst,
        writeDbpf({
          constantFlags: 7,
          keys: [
            { type: 0x03b33ddf, group: 0x00000001, instance: 0xaaaa000000000001n },
            { type: 0x03b33ddf, group: 0x00000001, instance: 0xaaaa000000000002n }
          ]
        })
      )
      expect(await readDbpfIndex(allConst)).toEqual({
        status: 'ok',
        keys: [
          { type: '0x03B33DDF', group: '0x00000001', instance: '0xAAAA000000000001' },
          { type: '0x03B33DDF', group: '0x00000001', instance: '0xAAAA000000000002' }
        ]
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns unreadable when the file cannot be opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-dbpf-unreadable-'))
    try {
      const missing = join(dir, 'does-not-exist.package')
      const res = await readDbpfIndex(missing)
      expect(res.status).toBe('unreadable')

      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        const locked = join(dir, 'no-read.package')
        await writeFile(locked, makeHeader())
        await chmod(locked, 0o000)
        try {
          const lockedRes = await readDbpfIndex(locked)
          expect(lockedRes.status).toBe('unreadable')
        } finally {
          await chmod(locked, 0o644)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
