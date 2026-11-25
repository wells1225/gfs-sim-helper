import { crc32 } from 'node:zlib'
import { createRng } from './prng.ts'

export interface ZipEntry {
  name: string
  data: Buffer
}

// Fixed DOS timestamp: 2026-11-01 00:00:00 UTC for byte-identical zips across runs.
const FIXED_DOS_TIME = 0x0000
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 1

const SIG_LOCAL_HEADER = 0x04034b50
const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_END_OF_CENTRAL_DIR = 0x06054b50
const ZIP_VERSION = 20
const UTF8_FLAG = 0x0800
const METHOD_STORE = 0

/**
 * Deterministic uncompressed (STORE) ZIP writer with fixed DOS timestamps.
 */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const normalizedName = entry.name.replaceAll('\\', '/')
    const nameBuf = Buffer.from(normalizedName, 'utf8')
    const data = entry.data
    const checksum = crc32(data) >>> 0

    const localHeader = Buffer.alloc(30 + nameBuf.length)
    localHeader.writeUInt32LE(SIG_LOCAL_HEADER, 0)
    localHeader.writeUInt16LE(ZIP_VERSION, 4)
    localHeader.writeUInt16LE(UTF8_FLAG, 6)
    localHeader.writeUInt16LE(METHOD_STORE, 8)
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10)
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(data.length >>> 0, 18)
    localHeader.writeUInt32LE(data.length >>> 0, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    nameBuf.copy(localHeader, 30)

    localParts.push(localHeader, data)

    const centralHeader = Buffer.alloc(46 + nameBuf.length)
    centralHeader.writeUInt32LE(SIG_CENTRAL_HEADER, 0)
    centralHeader.writeUInt16LE(ZIP_VERSION, 4)
    centralHeader.writeUInt16LE(ZIP_VERSION, 6)
    centralHeader.writeUInt16LE(UTF8_FLAG, 8)
    centralHeader.writeUInt16LE(METHOD_STORE, 10)
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12)
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(data.length >>> 0, 20)
    centralHeader.writeUInt32LE(data.length >>> 0, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra length
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number start
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(localOffset >>> 0, 42)
    nameBuf.copy(centralHeader, 46)

    centralParts.push(centralHeader)
    localOffset += localHeader.length + data.length
  }

  const centralDirOffset = localOffset
  let centralDirSize = 0
  for (const part of centralParts) {
    centralDirSize += part.length
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_END_OF_CENTRAL_DIR, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir start disk
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirSize >>> 0, 12)
  eocd.writeUInt32LE(centralDirOffset >>> 0, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

/**
 * Generates deterministic dummy .pyc bytes with a Python 3.7-style 16-byte header.
 */
export function makeDummyPyc(modulePath: string, seed: number): Buffer {
  const rng = createRng(seed)
  const header = Buffer.alloc(16)
  // Python 3.7 bytecode magic (Sims 4 embeds Python 3.7)
  header[0] = 0x42
  header[1] = 0x0d
  header[2] = 0x0d
  header[3] = 0x0a
  const body = Buffer.from(`fixture-pyc:${modulePath}:`, 'utf8')
  const tail = rng.bytes(16)
  return Buffer.concat([header, body, tail])
}
