import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Host } from './host.ts'

const RT_VERSION = 16
const VS_VERSION_INFO_ID = 1
const VS_FFI_SIGNATURE = 0xfeef04bd

interface PeSection {
  virtualAddress: number
  virtualSize: number
  rawDataOffset: number
  rawDataSize: number
}

function rvaToFileOffset(rva: number, sections: readonly PeSection[]): number | undefined {
  for (const sec of sections) {
    const span = Math.max(sec.virtualSize, sec.rawDataSize)
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
      return sec.rawDataOffset + (rva - sec.virtualAddress)
    }
  }
  return undefined
}

function findResourceEntryById(buf: Buffer, dirOffset: number, targetId: number): number | undefined {
  if (dirOffset < 0 || dirOffset + 16 > buf.length) return undefined
  const namedCount = buf.readUInt16LE(dirOffset + 12)
  const idCount = buf.readUInt16LE(dirOffset + 14)
  const firstIdEntry = dirOffset + 16 + namedCount * 8
  for (let i = 0; i < idCount; i += 1) {
    const entryOff = firstIdEntry + i * 8
    if (entryOff + 8 > buf.length) return undefined
    if (buf.readUInt32LE(entryOff) === targetId) {
      return buf.readUInt32LE(entryOff + 4)
    }
  }
  return undefined
}

function findFirstResourceEntry(buf: Buffer, dirOffset: number): number | undefined {
  if (dirOffset < 0 || dirOffset + 16 > buf.length) return undefined
  const total = buf.readUInt16LE(dirOffset + 12) + buf.readUInt16LE(dirOffset + 14)
  if (total === 0 || dirOffset + 24 > buf.length) return undefined
  return buf.readUInt32LE(dirOffset + 20)
}

/**
 * Reads the 4-part version from a Windows PE file's RT_VERSION / VS_FIXEDFILEINFO resource.
 * Used by fixture hosts so fixture tests run identically on macOS and Windows.
 */
export function parsePeFileVersion(buf: Buffer): string | undefined {
  if (buf.length < 0x40 || buf.subarray(0, 2).toString('ascii') !== 'MZ') return undefined
  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset + 24 > buf.length || buf.subarray(peOffset, peOffset + 4).toString('ascii') !== 'PE\0\0') {
    return undefined
  }

  const sectionCount = buf.readUInt16LE(peOffset + 6)
  const optSize = buf.readUInt16LE(peOffset + 20)
  const optOffset = peOffset + 24
  if (optOffset + optSize > buf.length || optSize < 0x70) return undefined

  const magic = buf.readUInt16LE(optOffset)
  const dataDirOffset = magic === 0x020b ? optOffset + 0x70 : magic === 0x010b ? optOffset + 0x60 : -1
  if (dataDirOffset < 0 || dataDirOffset + 24 > optOffset + optSize) return undefined

  const rsrcRva = buf.readUInt32LE(dataDirOffset + 16)
  const rsrcSize = buf.readUInt32LE(dataDirOffset + 20)
  if (rsrcRva === 0 || rsrcSize === 0) return undefined

  const sections: PeSection[] = []
  const secTableOffset = optOffset + optSize
  for (let i = 0; i < sectionCount; i += 1) {
    const off = secTableOffset + i * 40
    if (off + 40 > buf.length) return undefined
    sections.push({
      virtualSize: buf.readUInt32LE(off + 8),
      virtualAddress: buf.readUInt32LE(off + 12),
      rawDataSize: buf.readUInt32LE(off + 16),
      rawDataOffset: buf.readUInt32LE(off + 20)
    })
  }

  const rsrcRaw = rvaToFileOffset(rsrcRva, sections)
  if (rsrcRaw === undefined) return undefined

  const typeEntry = findResourceEntryById(buf, rsrcRaw, RT_VERSION)
  if (typeEntry === undefined || (typeEntry & 0x80000000) === 0) return undefined
  const idDirOff = rsrcRaw + (typeEntry & 0x7fffffff)

  const idEntry = findResourceEntryById(buf, idDirOff, VS_VERSION_INFO_ID) ?? findFirstResourceEntry(buf, idDirOff)
  if (idEntry === undefined || (idEntry & 0x80000000) === 0) return undefined
  const langDirOff = rsrcRaw + (idEntry & 0x7fffffff)

  const langEntry = findFirstResourceEntry(buf, langDirOff)
  if (langEntry === undefined || (langEntry & 0x80000000) !== 0) return undefined
  const dataEntryOff = rsrcRaw + langEntry
  if (dataEntryOff + 16 > buf.length) return undefined

  const dataRva = buf.readUInt32LE(dataEntryOff)
  const dataSize = buf.readUInt32LE(dataEntryOff + 4)
  const dataOff = rvaToFileOffset(dataRva, sections)
  if (dataOff === undefined || dataOff + dataSize > buf.length || dataSize < 92) return undefined

  // Locate VS_FIXEDFILEINFO after "VS_VERSION_INFO\0" (6 header + 32 key = 38 -> aligned 40)
  const ffiOff = dataOff + 40
  if (ffiOff + 52 > dataOff + dataSize) return undefined
  if (buf.readUInt32LE(ffiOff) !== VS_FFI_SIGNATURE) return undefined

  const ms = buf.readUInt32LE(ffiOff + 8)
  const ls = buf.readUInt32LE(ffiOff + 12)
  const major = (ms >>> 16) & 0xffff
  const minor = ms & 0xffff
  const build = (ls >>> 16) & 0xffff
  const revision = ls & 0xffff
  return `${major}.${minor}.${build}.${revision}`
}

export async function readPeFileVersion(filePath: string): Promise<string | undefined> {
  try {
    const buf = await readFile(filePath)
    return parsePeFileVersion(buf)
  } catch {
    return undefined
  }
}

export function createFixtureHost(fixtureRoot: string, overrides: Partial<Host> = {}): Host {
  const root = resolve(fixtureRoot)
  const baseEnv: Record<string, string | undefined> = {
    OneDrive: join(root, 'Users', 'Player', 'OneDrive'),
    OneDriveConsumer: undefined,
    OneDriveCommercial: undefined,
    ProgramFiles: join(root, 'Program Files'),
    'ProgramFiles(x86)': join(root, 'Program Files (x86)')
  }

  return {
    documentsDir: overrides.documentsDir ?? join(root, 'Users', 'Player', 'Documents'),
    env: overrides.env ?? baseEnv,
    readRegistry: overrides.readRegistry ?? (async () => undefined),
    listProcesses: overrides.listProcesses ?? (async () => []),
    fileVersion: overrides.fileVersion ?? readPeFileVersion
  }
}
