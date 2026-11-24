// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseHexUint32, parseHexUint64, writeDbpf } from './dbpf.ts'
import type { ResourceKey } from './dbpf.ts'
import { generateFixture, loadSpec } from './make-fixture.ts'
import { writeMinimalVersionPe } from './pe.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = join(THIS_DIR, 'specs')

type DbpfCheckResult =
  | { ok: true; major: number; minor: number; keys: ResourceKey[] }
  | {
      ok: false
      code:
        | 'truncated-header'
        | 'bad-magic'
        | 'wrong-version'
        | 'bad-index-bounds'
        | 'bad-index-size'
        | 'bad-entry'
      message: string
      major?: number
      minor?: number
    }

/**
 * Independent DBPF 2.1 header and index sanity checker matching
 * docs/research/fable-files-logs-safety.md section 4.
 */
function checkDbpf21(buf: Buffer): DbpfCheckResult {
  if (buf.length < 96) {
    return { ok: false, code: 'truncated-header', message: `Header shorter than 96 bytes (${buf.length})` }
  }

  const magic = buf.subarray(0, 4).toString('ascii')
  if (magic !== 'DBPF') {
    return { ok: false, code: 'bad-magic', message: `Bad magic: ${JSON.stringify(magic)}` }
  }

  const major = buf.readUInt32LE(4)
  const minor = buf.readUInt32LE(8)
  if (major !== 2 || minor !== 1) {
    return {
      ok: false,
      code: 'wrong-version',
      message: `Expected DBPF 2.1, got ${major}.${minor}`,
      major,
      minor
    }
  }

  const count = buf.readUInt32LE(36)
  const shortOffset = buf.readUInt32LE(40)
  const indexSize = buf.readUInt32LE(44)
  const constantThree = buf.readUInt32LE(60)
  const longOffset = Number(buf.readBigUInt64LE(64))
  const indexOffset = shortOffset !== 0 ? shortOffset : longOffset

  if (constantThree !== 3) {
    return { ok: false, code: 'bad-entry', message: `Expected constant 3 at offset 60, got ${constantThree}` }
  }

  if (indexOffset < 96 || indexOffset + indexSize > buf.length) {
    return {
      ok: false,
      code: 'bad-index-bounds',
      message: `Index [${indexOffset}, ${indexOffset + indexSize}) exceeds file size ${buf.length}`
    }
  }

  if (indexSize < 4) {
    return { ok: false, code: 'bad-index-size', message: `Index size ${indexSize} < 4` }
  }

  let cursor = indexOffset
  const flags = buf.readUInt32LE(cursor)
  cursor += 4

  const hasConstType = (flags & 0x01) !== 0
  const hasConstGroup = (flags & 0x02) !== 0
  const hasConstInstanceHigh = (flags & 0x04) !== 0
  const k = (hasConstType ? 1 : 0) + (hasConstGroup ? 1 : 0) + (hasConstInstanceHigh ? 1 : 0)
  const expectedIndexSize = 4 + 4 * k + count * (32 - 4 * k)

  if (indexSize !== expectedIndexSize) {
    return {
      ok: false,
      code: 'bad-index-size',
      message: `Index size ${indexSize} !== expected ${expectedIndexSize} (k=${k}, count=${count})`
    }
  }

  const constType = hasConstType ? buf.readUInt32LE(cursor) : 0
  if (hasConstType) cursor += 4
  const constGroup = hasConstGroup ? buf.readUInt32LE(cursor) : 0
  if (hasConstGroup) cursor += 4
  const constInstanceHigh = hasConstInstanceHigh ? buf.readUInt32LE(cursor) : 0
  if (hasConstInstanceHigh) cursor += 4

  const keys: ResourceKey[] = []
  for (let i = 0; i < count; i += 1) {
    const type = hasConstType ? constType : buf.readUInt32LE(cursor)
    if (!hasConstType) cursor += 4
    const group = hasConstGroup ? constGroup : buf.readUInt32LE(cursor)
    if (!hasConstGroup) cursor += 4
    const instanceHigh = hasConstInstanceHigh ? constInstanceHigh : buf.readUInt32LE(cursor)
    if (!hasConstInstanceHigh) cursor += 4

    const instanceLow = buf.readUInt32LE(cursor)
    cursor += 4
    const offset = buf.readUInt32LE(cursor)
    cursor += 4
    const rawCompressedSize = buf.readUInt32LE(cursor)
    cursor += 4
    const uncompressedSize = buf.readUInt32LE(cursor)
    cursor += 4
    const compressionType = buf.readUInt16LE(cursor)
    cursor += 2
    cursor += 2 // committed

    if ((rawCompressedSize & 0x80000000) === 0) {
      return { ok: false, code: 'bad-entry', message: `Entry ${i} missing extended-entry bit` }
    }
    const compressedSize = rawCompressedSize & 0x7fffffff
    if (offset < 96 || offset + compressedSize > buf.length) {
      return { ok: false, code: 'bad-entry', message: `Entry ${i} payload out of bounds` }
    }
    if (compressionType === 0 && compressedSize !== uncompressedSize) {
      return { ok: false, code: 'bad-entry', message: `Entry ${i} uncompressed size mismatch` }
    }

    keys.push({
      type,
      group,
      instance: (BigInt(instanceHigh) << 32n) | BigInt(instanceLow)
    })
  }

  return { ok: true, major, minor, keys }
}

/**
 * Independent ZIP parser that checks EOCD, Central Directory, Local Headers, and CRC-32.
 */
function readZipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  if (buf.length < 22) {
    throw new Error('Buffer too small for ZIP')
  }
  const eocdOffset = buf.length - 22
  if (buf.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error('Missing ZIP EOCD signature')
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10)
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16)
  const entries: Array<{ name: string; data: Buffer }> = []

  let cursor = centralDirOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid central header signature at entry ${i}`)
    }
    const method = buf.readUInt16LE(cursor + 10)
    if (method !== 0) {
      throw new Error(`Unexpected compression method ${method}`)
    }
    const expectedCrc = buf.readUInt32LE(cursor + 16)
    const compSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid local header signature for ${name}`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = buf.subarray(dataStart, dataStart + compSize)
    const actualCrc = crc32(data) >>> 0
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC-32 mismatch for ${name}: ${actualCrc} !== ${expectedCrc}`)
    }

    entries.push({ name, data })
    cursor += 46 + nameLen + extraLen + commentLen
  }

  return entries
}

interface WalkedEntry {
  relPath: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
  sha256?: string
}

async function snapshotTree(rootDir: string): Promise<WalkedEntry[]> {
  const results: WalkedEntry[] = []

  async function walk(currentDir: string): Promise<void> {
    const entries = (await readdir(currentDir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      const relPath = relative(rootDir, fullPath).replaceAll('\\', '/')
      const info = await stat(fullPath)
      if (entry.isDirectory()) {
        results.push({ relPath, kind: 'dir', size: 0, mtimeMs: Math.round(info.mtimeMs) })
        await walk(fullPath)
      } else {
        const bytes = await readFile(fullPath)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        results.push({ relPath, kind: 'file', size: bytes.length, mtimeMs: Math.round(info.mtimeMs), sha256 })
      }
    }
  }

  await walk(rootDir)
  return results
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        out.push(full)
      }
    }
  }
  await walk(rootDir)
  return out
}

describe('DBPF 2.1 writer and sanity check', () => {
  it('writes valid DBPF 2.1 packages with 64-bit instances and constant flags', () => {
    const keys: ResourceKey[] = [
      { type: 0x03b33ddf, group: 0x00000003, instance: 0x123456789abcdef0n },
      { type: 0x03b33ddf, group: 0x00000003, instance: 0x1234567800000001n }
    ]

    for (const constantFlags of [0, 1, 2, 3, 4, 7]) {
      const buf = writeDbpf({ keys, constantFlags, seed: 42 })
      const checked = checkDbpf21(buf)
      expect(checked).toEqual({ ok: true, major: 2, minor: 1, keys })
    }
  })

  it('writes the header and index bytes at the offsets in section 4', () => {
    // Pinned from a hand check of good_plain.package against the section 4 tables.
    const buf = writeDbpf({
      keys: [
        { type: 0x03b33ddf, group: 0, instance: 0x0005000000000001n },
        { type: 0x545ac67a, group: 3, instance: 0xfedcba9876543210n }
      ]
    })
    const header =
      '44425046' + '02000000' + '01000000' + '00'.repeat(24) + // magic, major 2, minor 1, unused
      '02000000' + '00000000' + '44000000' + '00'.repeat(12) + // count 2, short offset 0, index size 68
      '03000000' + '8000000000000000' + '00'.repeat(24) // constant 3, long offset 128, padding
    const index =
      '00000000' + // flags: nothing constant
      'df3db303' + '00000000' + '00000500' + '01000000' + '60000000' + '10000080' + '10000000' + '0000' + '0100' +
      '7ac65a54' + '03000000' + '98badcfe' + '10325476' + '70000000' + '10000080' + '10000000' + '0000' + '0100'
    expect(buf.length).toBe(196)
    expect(buf.subarray(0, 96).toString('hex')).toBe(header)
    expect(buf.subarray(128).toString('hex')).toBe(index)
  })

  it('rejects resource key strings with trailing junk', () => {
    expect(() => parseHexUint32('0x03B33DDZ')).toThrow()
    expect(() => parseHexUint32('')).toThrow()
    expect(() => parseHexUint64('')).toThrow()
    expect(parseHexUint32('0x03B33DDF')).toBe(0x03b33ddf)
  })

  it('produces broken variants that fail the DBPF 2.1 sanity check', () => {
    const keys: ResourceKey[] = [{ type: 0x03b33ddf, group: 0, instance: 0x42n }]

    const badMagic = checkDbpf21(writeDbpf({ keys, variant: 'bad-magic' }))
    expect(badMagic.ok).toBe(false)
    if (!badMagic.ok) expect(badMagic.code).toBe('bad-magic')

    const truncatedIndex = checkDbpf21(writeDbpf({ keys, variant: 'truncated-index' }))
    expect(truncatedIndex.ok).toBe(false)
    if (!truncatedIndex.ok) expect(truncatedIndex.code).toBe('bad-index-bounds')

    const sims3 = checkDbpf21(writeDbpf({ keys, variant: 'sims3' }))
    expect(sims3.ok).toBe(false)
    if (!sims3.ok) {
      expect(sims3.code).toBe('wrong-version')
      expect(sims3.major).toBe(2)
      expect(sims3.minor).toBe(0)
    }

    const truncatedHeader = checkDbpf21(writeDbpf({ keys, variant: 'truncated-header' }))
    expect(truncatedHeader.ok).toBe(false)
    if (!truncatedHeader.ok) expect(truncatedHeader.code).toBe('truncated-header')
  })
})

describe('minimal PE version resource writer', () => {
  it('writes a valid PE32+ .rsrc version tree with VS_FIXEDFILEINFO and FileVersion for 1.129.39.1030', () => {
    const pe = writeMinimalVersionPe('1.129.39.1030')

    // DOS header + PE signature + COFF header + PE32+ optional header
    expect(pe.subarray(0, 2).toString('ascii')).toBe('MZ')
    const peOffset = pe.readUInt32LE(0x3c)
    expect(pe.subarray(peOffset, peOffset + 4).toString('ascii')).toBe('PE\0\0')
    expect(pe.readUInt16LE(peOffset + 4)).toBe(0x8664) // AMD64
    expect(pe.readUInt16LE(peOffset + 6)).toBe(1) // 1 section (.rsrc)
    const optSize = pe.readUInt16LE(peOffset + 20)
    const optOffset = peOffset + 24
    expect(pe.readUInt16LE(optOffset)).toBe(0x020b) // PE32+

    // DataDirectory[2] (Resource Table) points at .rsrc section
    const rsrcRva = pe.readUInt32LE(optOffset + 0x80)
    const rsrcSize = pe.readUInt32LE(optOffset + 0x84)
    expect(rsrcRva).toBeGreaterThan(0)
    expect(rsrcSize).toBeGreaterThan(88)

    const secOffset = optOffset + optSize
    expect(pe.subarray(secOffset, secOffset + 5).toString('ascii')).toBe('.rsrc')
    expect(pe.readUInt32LE(secOffset + 12)).toBe(rsrcRva)
    const rsrcRaw = pe.readUInt32LE(secOffset + 20)

    // Resource tree: Type 16 (RT_VERSION) -> ID 1 -> Language -> Data Entry
    expect(pe.readUInt32LE(rsrcRaw + 16)).toBe(16)
    const idDirOff = pe.readUInt32LE(rsrcRaw + 20) & 0x7fffffff
    expect(pe.readUInt32LE(rsrcRaw + idDirOff + 16)).toBe(1)
    const langDirOff = pe.readUInt32LE(rsrcRaw + idDirOff + 20) & 0x7fffffff
    expect(pe.readUInt32LE(rsrcRaw + langDirOff + 16)).toBe(0x0409)
    const dataEntryOff = pe.readUInt32LE(rsrcRaw + langDirOff + 20)
    const dataRva = pe.readUInt32LE(rsrcRaw + dataEntryOff)
    const dataSize = pe.readUInt32LE(rsrcRaw + dataEntryOff + 4)
    const versionInfoOff = rsrcRaw + (dataRva - rsrcRva)

    // VS_VERSIONINFO + VS_FIXEDFILEINFO
    expect(pe.readUInt16LE(versionInfoOff)).toBe(dataSize)
    expect(pe.readUInt16LE(versionInfoOff + 2)).toBe(52)
    expect(pe.subarray(versionInfoOff + 6, versionInfoOff + 38).toString('utf16le')).toBe('VS_VERSION_INFO\0')
    const ffiOff = versionInfoOff + 40
    expect(pe.readUInt32LE(ffiOff)).toBe(0xfeef04bd)
    expect(pe.readUInt32LE(ffiOff + 8)).toBe(0x00010081)
    expect(pe.readUInt32LE(ffiOff + 12)).toBe(0x00270406)

    // StringFileInfo contains UTF-16LE FileVersion string
    const versionBlock = pe.subarray(versionInfoOff, versionInfoOff + dataSize)
    expect(versionBlock.includes(Buffer.from('FileVersion\0', 'utf16le'))).toBe(true)
    expect(versionBlock.includes(Buffer.from('1.129.39.1030\0', 'utf16le'))).toBe(true)
  })
})

describe('fixture generator', () => {
  let workDir = ''

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sims-helper-fixtures-test-'))
  })

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('generates byte-identical trees with identical timestamps when run twice', async () => {
    const specNames = ['clean', 'patch-day', 'nested-scripts', 'duplicates', 'broken-packages', 'onedrive', 'exceptions']
    for (const name of specNames) {
      const spec = await loadSpec(join(SPECS_DIR, `${name}.json`))
      const dirA = join(workDir, `${name}-run-a`)
      const dirB = join(workDir, `${name}-run-b`)

      await generateFixture(spec, dirA)
      await generateFixture(spec, dirB)

      const snapA = await snapshotTree(dirA)
      const snapB = await snapshotTree(dirB)
      expect(snapA.length).toBeGreaterThan(0)
      expect(snapA).toEqual(snapB)

      // Every package not named as broken passes the section 4 sanity checks.
      const packages = (await listFilesRecursive(dirA)).filter((p) => p.endsWith('.package'))
      for (const pkgPath of packages) {
        const fileName = pkgPath.split(/[/\\]/).pop() as string
        if (fileName.startsWith('corrupt_') || fileName.startsWith('wrong_game_')) continue
        const res = checkDbpf21(await readFile(pkgPath))
        expect(res.ok, `Expected valid DBPF 2.1 at ${pkgPath}`).toBe(true)
      }
    }
  })

  it('validates every good package and rejects every broken package in broken-packages', async () => {
    const spec = await loadSpec(join(SPECS_DIR, 'broken-packages.json'))
    const outDir = join(workDir, 'verify-broken-packages')
    await generateFixture(spec, outDir)

    const userFolder = spec.userFolders[0]
    expect(userFolder).toBeDefined()
    const modsDir = join(outDir, userFolder!.relPath, 'Mods')

    const goodPlain = checkDbpf21(await readFile(join(modsDir, 'good_plain.package')))
    expect(goodPlain.ok).toBe(true)
    if (goodPlain.ok) {
      expect(goodPlain.keys).toEqual([
        { type: parseHexUint32('0x03B33DDF'), group: 0, instance: parseHexUint64('0x0005000000000001') },
        { type: parseHexUint32('0x545AC67A'), group: 3, instance: parseHexUint64('0xFEDCBA9876543210') }
      ])
    }

    const goodConst = checkDbpf21(await readFile(join(modsDir, 'good_constant_flags.package')))
    expect(goodConst.ok).toBe(true)
    if (goodConst.ok) {
      expect(goodConst.keys).toEqual([
        { type: 0x034aeecb, group: 0, instance: 0x0005000000000010n },
        { type: 0x034aeecb, group: 0, instance: 0x0005000100000011n }
      ])
    }

    const constHighBytes = await readFile(join(modsDir, 'good_constant_instance_high.package'))
    expect(constHighBytes.readUInt32LE(constHighBytes.readUInt32LE(64))).toBe(4)
    const constHigh = checkDbpf21(constHighBytes)
    expect(constHigh.ok).toBe(true)
    if (constHigh.ok) {
      expect(constHigh.keys).toEqual([
        { type: 0x03b33ddf, group: 0, instance: 0x00050002000000a0n },
        { type: 0x545ac67a, group: 3, instance: 0x00050002000000a1n }
      ])
    }

    const badMagic = checkDbpf21(await readFile(join(modsDir, 'corrupt_bad_magic.package')))
    expect(badMagic.ok).toBe(false)
    if (!badMagic.ok) expect(badMagic.code).toBe('bad-magic')

    const cutOff = checkDbpf21(await readFile(join(modsDir, 'corrupt_truncated_index.package')))
    expect(cutOff.ok).toBe(false)
    if (!cutOff.ok) expect(cutOff.code).toBe('bad-index-bounds')

    const sims3 = checkDbpf21(await readFile(join(modsDir, 'wrong_game_sims3.package')))
    expect(sims3.ok).toBe(false)
    if (!sims3.ok) {
      expect(sims3.code).toBe('wrong-version')
      expect(sims3.major).toBe(2)
      expect(sims3.minor).toBe(0)
    }

    const shortHeader = checkDbpf21(await readFile(join(modsDir, 'corrupt_short_header.package')))
    expect(shortHeader.ok).toBe(false)
    if (!shortHeader.ok) expect(shortHeader.code).toBe('truncated-header')

    const zipEntries = readZipEntries(await readFile(join(modsDir, 'Unextracted_CC_Bundle.zip')))
    expect(zipEntries.map((e) => e.name)).toEqual(['README.txt', 'chair_set.package'])
  })

  it('validates clean, patch-day, nested-scripts (French U+00A0), duplicates, onedrive, and exceptions specs', async () => {
    // clean: every .package in the tree passes DBPF 2.1
    const cleanSpec = await loadSpec(join(SPECS_DIR, 'clean.json'))
    const cleanDir = join(workDir, 'verify-clean')
    await generateFixture(cleanSpec, cleanDir)
    const cleanPackages = (await listFilesRecursive(cleanDir)).filter((p) => p.endsWith('.package'))
    expect(cleanPackages.length).toBeGreaterThanOrEqual(6)
    for (const pkgPath of cleanPackages) {
      const res = checkDbpf21(await readFile(pkgPath))
      expect(res.ok, `Expected valid DBPF 2.1 at ${pkgPath}`).toBe(true)
    }

    // patch-day: Origin default install path + modsdisabled=1, scriptmodsenabled=0, with mods present
    const patchSpec = await loadSpec(join(SPECS_DIR, 'patch-day.json'))
    const patchDir = join(workDir, 'verify-patch-day')
    await generateFixture(patchSpec, patchDir)
    expect(patchSpec.gameInstall.relPath).toBe('Program Files (x86)/Origin Games/The Sims 4')
    const patchExe = await readFile(join(patchDir, patchSpec.gameInstall.relPath, 'Game/Bin/TS4_x64.exe'))
    expect(patchExe.subarray(0, 2).toString('ascii')).toBe('MZ')
    const patchUserRoot = join(patchDir, patchSpec.userFolders[0]!.relPath)
    const patchOptions = await readFile(join(patchUserRoot, 'Options.ini'), 'utf8')
    expect(patchOptions).toContain('modsdisabled=1')
    expect(patchOptions).toContain('scriptmodsenabled=0')
    const patchMods = await listFilesRecursive(join(patchUserRoot, 'Mods'))
    expect(patchMods.some((p) => p.endsWith('.package'))).toBe(true)
    expect(patchMods.some((p) => p.endsWith('.ts4script'))).toBe(true)

    // nested-scripts: French folder name with U+00A0 no-break spaces
    const nestedSpec = await loadSpec(join(SPECS_DIR, 'nested-scripts.json'))
    const nestedDir = join(workDir, 'verify-nested-scripts')
    await generateFixture(nestedSpec, nestedDir)
    const eaEntries = await readdir(join(nestedDir, 'Users/Player/Documents/Electronic Arts'))
    expect(eaEntries).toEqual(['Les\u00A0Sims\u00A04'])

    // duplicates: byte-identical files in two places
    const dupSpec = await loadSpec(join(SPECS_DIR, 'duplicates.json'))
    const dupDir = join(workDir, 'verify-duplicates')
    await generateFixture(dupSpec, dupDir)
    const dupMods = join(dupDir, dupSpec.userFolders[0]!.relPath, 'Mods')
    const hairA = await readFile(join(dupMods, 'CAS/Hair/sample_hair_01.package'))
    const hairB = await readFile(join(dupMods, 'CurseForge/sample_hair_01.package'))
    expect(hairA.equals(hairB)).toBe(true)
    const scriptA = await readFile(join(dupMods, 'HelperMod/helper_mod.ts4script'))
    const scriptB = await readFile(join(dupMods, 'BackupCopy/helper_mod.ts4script'))
    expect(scriptA.equals(scriptB)).toBe(true)
    const lampA = await readFile(join(dupMods, 'BuildBuy/lamp_a.package'))
    const lampB = await readFile(join(dupMods, 'BuildBuy/lamp_b.package'))
    expect(lampA.equals(lampB)).toBe(false)

    // onedrive: active OneDrive/Documents folder + older stale Documents folder
    const odSpec = await loadSpec(join(SPECS_DIR, 'onedrive.json'))
    const odDir = join(workDir, 'verify-onedrive')
    await generateFixture(odSpec, odDir)
    const odActive = await stat(join(odDir, 'Users/Player/OneDrive/Documents/Electronic Arts/The Sims 4/Options.ini'))
    const odStale = await stat(join(odDir, 'Users/Player/Documents/Electronic Arts/The Sims 4/Options.ini'))
    expect(odActive.mtimeMs).toBeGreaterThan(odStale.mtimeMs)
    // Folders inside the stale user folder are as old as the folder itself, so a scan of
    // the stale tree never finds an entry newer than the active folder.
    const staleFolderMs = Date.parse('2026-09-10T10:00:00.000Z')
    for (const dir of ['', 'Mods', 'Mods/CAS', 'saves', 'Tray', 'cache']) {
      const info = await stat(join(odDir, 'Users/Player/Documents/Electronic Arts/The Sims 4', dir))
      expect(info.mtimeMs, `stale dir ${dir || '.'}`).toBe(staleFolderMs)
    }

    // exceptions: game-only LE, mod-matching LE -> ts4script .pyc, cut-off LE, lastCrash, BE HTML, CurseForge JSON
    const exSpec = await loadSpec(join(SPECS_DIR, 'exceptions.json'))
    const exDir = join(workDir, 'verify-exceptions')
    await generateFixture(exSpec, exDir)
    const exUserRoot = join(exDir, exSpec.userFolders[0]!.relPath)

    const gameOnlyLe = await readFile(join(exUserRoot, 'lastException_63887256771.txt'), 'utf8')
    expect(gameOnlyLe).toContain('<root>')
    expect(gameOnlyLe).toContain('T:\\InGame\\Gameplay\\Scripts\\Core\\sims4\\tuning\\tunable.py')

    const modLe = await readFile(join(exUserRoot, 'lastException_63887259912.txt'), 'utf8')
    expect(modLe).toContain('wicked_wardrobe\\outfit_picker.py')
    const ts4scriptEntries = readZipEntries(
      await readFile(join(exUserRoot, 'Mods/WickedWardrobe/wicked_wardrobe.ts4script'))
    )
    expect(ts4scriptEntries.map((e) => e.name)).toContain('wicked_wardrobe/outfit_picker.pyc')

    const cutOffLe = await readFile(join(exUserRoot, 'lastException_63887260105.txt'), 'utf8')
    expect(cutOffLe).toContain('<root>')
    expect(cutOffLe).not.toContain('</root>')

    const crashLog = await readFile(join(exUserRoot, 'lastCrash.txt'), 'utf8')
    expect(crashLog).toContain('<report>')
    expect(crashLog).not.toContain('<root>')
    expect(crashLog).toContain('<type>crash</type>')
    expect(crashLog).not.toContain('Traceback')
    // Section 3 sample: <contextdata> holds a literal <br /> element, not escaped text.
    expect(crashLog).toContain('<contextdata>Current Game State: 0x9b8c93c0<br /></contextdata>')

    const beHtml = await readFile(join(exUserRoot, 'BE-ExceptionReport.html'), 'utf8')
    expect(beHtml).toContain('id="beRawLEData"')
    expect(beHtml).toContain('&lt;report&gt;')

    const cfRaw = await readFile(
      join(exDir, 'Users/Player/AppData/Roaming/CurseForge/agent/GameInstances/AddonGameInstance.json'),
      'utf8'
    )
    const cfParsed = JSON.parse(cfRaw) as Array<{ _comment: string; gameID: number; installedAddons: unknown[] }>
    expect(cfParsed).toHaveLength(1)
    expect(cfParsed[0]!._comment.toLowerCase()).toContain('inferred')
    expect(cfParsed[0]!._comment.toLowerCase()).toContain('unverified')
    expect(cfParsed[0]!.gameID).toBe(78062)
    expect(cfParsed[0]!.installedAddons.length).toBeGreaterThanOrEqual(2)
  })

  it('gives the folder finder a look-alike folder with no Options.ini and a non-text GameVersion.txt', async () => {
    const odSpec = await loadSpec(join(SPECS_DIR, 'onedrive.json'))
    const odDir = join(workDir, 'verify-onedrive-finder')
    await generateFixture(odSpec, odDir)

    // A localized folder name under the local Documents root whose Options.ini is missing.
    // It still holds saves and mods, and it has the newest dates of the three.
    const lookAlike = join(odDir, 'Users/Player/Documents/Electronic Arts/Die Sims 4')
    const lookAlikeEntries = await readdir(lookAlike)
    expect(lookAlikeEntries).toContain('Mods')
    expect(lookAlikeEntries).not.toContain('Options.ini')
    const active = join(odDir, 'Users/Player/OneDrive/Documents/Electronic Arts/The Sims 4')
    const newestActive = Math.max(
      ...(await Promise.all((await listFilesRecursive(active)).map(async (f) => (await stat(f)).mtimeMs)))
    )
    const lookAlikeTimes = await Promise.all(
      (await listFilesRecursive(lookAlike)).map(async (f) => (await stat(f)).mtimeMs)
    )
    expect(Math.max(...lookAlikeTimes)).toBeGreaterThan(newestActive)

    // The stale folder's GameVersion.txt is not plain text, and the version pattern still finds it.
    const staleVersion = await readFile(
      join(odDir, 'Users/Player/Documents/Electronic Arts/The Sims 4/GameVersion.txt')
    )
    expect(staleVersion.some((byte) => byte < 0x09)).toBe(true)
    expect(staleVersion.toString('latin1').match(/\d+\.\d+\.\d+\.\d+/)?.[0]).toBe('1.125.12.1030')
  })

  it('names no real mod creator or developer in generated paths and logs', async () => {
    const bigSpec = await loadSpec(join(SPECS_DIR, 'big.json'))
    const bigDir = join(workDir, 'verify-big-names')
    await generateFixture(bigSpec, bigDir)
    const bigMods = join(bigDir, bigSpec.userFolders[0]!.relPath, 'Mods')
    const scriptFolders = new Set(
      (await listFilesRecursive(bigMods))
        .filter((p) => p.endsWith('.ts4script'))
        .map((p) => relative(bigMods, p).split(/[/\\]/))
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0] as string)
    )
    // Scripts 0 and 5 of every 10 sit at the Mods root, so 8 of the 10 folder names are used.
    expect(scriptFolders.size).toBe(8)
    for (const folder of scriptFolders) {
      expect(folder).toMatch(/^Creator\d{2}$/)
    }

    const exSpec = await loadSpec(join(SPECS_DIR, 'exceptions.json'))
    const exDir = join(workDir, 'verify-exceptions-names')
    await generateFixture(exSpec, exDir)
    const gameOnlyLe = await readFile(
      join(exDir, exSpec.userFolders[0]!.relPath, 'lastException_63887256771.txt'),
      'utf8'
    )
    // The bracketed tag at the start of a game message is a developer's name in real logs.
    expect(gameOnlyLe).toContain('<desyncdata>[maxisdev] Caught exception')
  }, 30_000)

  it('builds big with 5,000 valid packages and 300 valid script mods', async () => {
    const spec = await loadSpec(join(SPECS_DIR, 'big.json'))
    const bigDir = join(workDir, 'verify-big')

    await generateFixture(spec, bigDir)

    const modsDir = join(bigDir, spec.userFolders[0]!.relPath, 'Mods')
    const allModFiles = await listFilesRecursive(modsDir)
    const packages = allModFiles.filter((p) => p.endsWith('.package'))
    const scripts = allModFiles.filter((p) => p.endsWith('.ts4script'))

    expect(packages).toHaveLength(5000)
    expect(scripts).toHaveLength(300)

    // Verify realistic nesting depths
    const pkgDepths = new Set(packages.map((p) => relative(modsDir, p).split(/[/\\]/).length - 1))
    expect(pkgDepths.has(0)).toBe(true)
    expect(pkgDepths.has(5)).toBe(true)
    const scriptDepths = new Set(scripts.map((p) => relative(modsDir, p).split(/[/\\]/).length - 1))
    expect(scriptDepths).toEqual(new Set([0, 1]))

    // Sanity-check every generated package in big
    for (const pkgPath of packages) {
      const checked = checkDbpf21(await readFile(pkgPath))
      expect(checked.ok).toBe(true)
    }

    // Sanity-check every generated .ts4script in big
    for (const scriptPath of scripts) {
      const entries = readZipEntries(await readFile(scriptPath))
      expect(entries.length).toBe(2)
      expect(entries.every((e) => e.name.endsWith('.pyc'))).toBe(true)
    }
  }, 30_000)
})
