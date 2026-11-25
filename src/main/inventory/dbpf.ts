import { openForRead } from '../fs-read.ts'
import type { ReadOnlyFile } from '../fs-read.ts'
import type { DbpfIndex, DbpfSummary, ResourceKey } from '../../shared/model.ts'

const DBPF_HEADER_SIZE = 96
const MAX_INDEX_BYTES = 64 * 1024 * 1024

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

function classifyWrongGame(major: number, minor: number): 'sims2' | 'sims3' | 'simcity' | 'unknown' {
  if (major === 1 && minor === 1) return 'sims2'
  if (major === 2 && minor === 0) return 'sims3'
  if (major === 3 && minor === 0) return 'simcity'
  return 'unknown'
}

type HeaderCheckResult =
  | {
      status: 'needs-index'
      entryCount: number
      indexOffset: bigint
      indexSize: number
    }
  | { status: 'empty-ok' }
  | Exclude<DbpfIndex, { status: 'ok' }>

async function readAndCheckHeader(fh: ReadOnlyFile): Promise<HeaderCheckResult> {
  if (fh.size < DBPF_HEADER_SIZE) {
    return {
      status: 'broken',
      problem: 'too-short',
      detail: `Package is ${fh.size} bytes (minimum header is ${DBPF_HEADER_SIZE} bytes)`
    }
  }

  const header = new Uint8Array(DBPF_HEADER_SIZE)
  let bytesRead: number
  try {
    bytesRead = await fh.read(header, 0, DBPF_HEADER_SIZE)
  } catch (err) {
    return { status: 'unreadable', detail: formatError(err) }
  }

  if (bytesRead < DBPF_HEADER_SIZE) {
    return {
      status: 'broken',
      problem: 'too-short',
      detail: `Read only ${bytesRead} bytes of ${DBPF_HEADER_SIZE}-byte header`
    }
  }

  if (header[0] !== 0x44 || header[1] !== 0x42 || header[2] !== 0x50 || header[3] !== 0x46) {
    return {
      status: 'broken',
      problem: 'bad-magic',
      detail: 'File does not start with DBPF magic bytes'
    }
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const major = view.getUint32(4, true)
  const minor = view.getUint32(8, true)

  if (major !== 2 || minor !== 1) {
    return {
      status: 'wrong-game',
      major,
      minor,
      game: classifyWrongGame(major, minor)
    }
  }

  const entryCount = view.getUint32(36, true)
  if (entryCount === 0) {
    return { status: 'empty-ok' }
  }

  const shortOffset = view.getUint32(40, true)
  const indexSize = view.getUint32(44, true)
  const longOffset = view.getBigUint64(64, true)
  const indexOffset = shortOffset !== 0 ? BigInt(shortOffset) : longOffset

  if (indexSize > MAX_INDEX_BYTES) {
    return {
      status: 'broken',
      problem: 'bad-index',
      detail: `Index size ${indexSize} exceeds 64 MB limit`
    }
  }

  if (indexSize < 4) {
    return {
      status: 'broken',
      problem: 'bad-index',
      detail: `Index size ${indexSize} is smaller than 4-byte flags field`
    }
  }

  const fileSize = BigInt(fh.size)
  if (indexOffset < BigInt(DBPF_HEADER_SIZE) || indexOffset + BigInt(indexSize) > fileSize) {
    return {
      status: 'broken',
      problem: 'bad-index',
      detail: `Index range [${indexOffset}, ${indexOffset + BigInt(indexSize)}) falls outside ${fh.size}-byte file`
    }
  }

  return {
    status: 'needs-index',
    entryCount,
    indexOffset,
    indexSize
  }
}

function validateIndexFlagsAndSize(
  flags: number,
  entryCount: number,
  indexSize: number
):
  | { ok: true; hasConstType: boolean; hasConstGroup: boolean; hasConstInstHigh: boolean }
  | { ok: false; detail: string } {
  if ((flags & ~0x07) !== 0) {
    return { ok: false, detail: `Unsupported DBPF constant flags 0x${hex8(flags)}` }
  }
  const hasConstType = (flags & 0x01) !== 0
  const hasConstGroup = (flags & 0x02) !== 0
  const hasConstInstHigh = (flags & 0x04) !== 0
  const k = (hasConstType ? 1 : 0) + (hasConstGroup ? 1 : 0) + (hasConstInstHigh ? 1 : 0)
  const expectedSize = 4n + 4n * BigInt(k) + BigInt(entryCount) * BigInt(32 - 4 * k)
  if (BigInt(indexSize) !== expectedSize) {
    return {
      ok: false,
      detail: `Index size ${indexSize} does not match expected ${expectedSize} for ${entryCount} entries (k=${k})`
    }
  }
  return { ok: true, hasConstType, hasConstGroup, hasConstInstHigh }
}

export async function readDbpfIndex(file: string): Promise<DbpfIndex> {
  let fh: ReadOnlyFile
  try {
    fh = await openForRead(file)
  } catch (err) {
    return { status: 'unreadable', detail: formatError(err) }
  }

  try {
    const check = await readAndCheckHeader(fh)
    if (check.status === 'empty-ok') {
      return { status: 'ok', keys: [] }
    }
    if (check.status !== 'needs-index') {
      return check
    }

    const indexBuf = new Uint8Array(check.indexSize)
    let bytesRead: number
    try {
      bytesRead = await fh.read(indexBuf, Number(check.indexOffset), check.indexSize)
    } catch (err) {
      return { status: 'unreadable', detail: formatError(err) }
    }

    if (bytesRead < check.indexSize) {
      return {
        status: 'broken',
        problem: 'bad-index',
        detail: `Read only ${bytesRead} of ${check.indexSize} index bytes`
      }
    }

    const view = new DataView(indexBuf.buffer, indexBuf.byteOffset, indexBuf.byteLength)
    const flags = view.getUint32(0, true)
    const validated = validateIndexFlagsAndSize(flags, check.entryCount, check.indexSize)
    if (!validated.ok) {
      return { status: 'broken', problem: 'bad-index', detail: validated.detail }
    }

    let cursor = 4
    let constType = 0
    let constGroup = 0
    let constInstHigh = 0

    if (validated.hasConstType) {
      constType = view.getUint32(cursor, true)
      cursor += 4
    }
    if (validated.hasConstGroup) {
      constGroup = view.getUint32(cursor, true)
      cursor += 4
    }
    if (validated.hasConstInstHigh) {
      constInstHigh = view.getUint32(cursor, true)
      cursor += 4
    }

    const keys: ResourceKey[] = new Array(check.entryCount)
    for (let i = 0; i < check.entryCount; i += 1) {
      let typeVal = constType
      if (!validated.hasConstType) {
        typeVal = view.getUint32(cursor, true)
        cursor += 4
      }

      let groupVal = constGroup
      if (!validated.hasConstGroup) {
        groupVal = view.getUint32(cursor, true)
        cursor += 4
      }

      let instHighVal = constInstHigh
      if (!validated.hasConstInstHigh) {
        instHighVal = view.getUint32(cursor, true)
        cursor += 4
      }

      const instLowVal = view.getUint32(cursor, true)
      // Skip instanceLow (4) + offset (4) + compressedSize (4) + uncompressedSize (4) + compression (2) + committed (2)
      cursor += 20

      keys[i] = {
        type: `0x${hex8(typeVal)}`,
        group: `0x${hex8(groupVal)}`,
        instance: `0x${hex8(instHighVal)}${hex8(instLowVal)}`
      }
    }

    return { status: 'ok', keys }
  } finally {
    await fh.close()
  }
}

export async function readDbpfSummary(file: string): Promise<DbpfSummary> {
  let fh: ReadOnlyFile
  try {
    fh = await openForRead(file)
  } catch (err) {
    return { status: 'unreadable', detail: formatError(err) }
  }

  try {
    const check = await readAndCheckHeader(fh)
    if (check.status === 'empty-ok') {
      return { status: 'ok', keyCount: 0 }
    }
    if (check.status !== 'needs-index') {
      return check
    }

    const flagsBuf = new Uint8Array(4)
    let bytesRead: number
    try {
      bytesRead = await fh.read(flagsBuf, Number(check.indexOffset), 4)
    } catch (err) {
      return { status: 'unreadable', detail: formatError(err) }
    }

    if (bytesRead < 4) {
      return {
        status: 'broken',
        problem: 'bad-index',
        detail: `Read only ${bytesRead} of 4 index flag bytes`
      }
    }

    const flags = new DataView(flagsBuf.buffer, flagsBuf.byteOffset, 4).getUint32(0, true)
    const validated = validateIndexFlagsAndSize(flags, check.entryCount, check.indexSize)
    if (!validated.ok) {
      return { status: 'broken', problem: 'bad-index', detail: validated.detail }
    }

    return { status: 'ok', keyCount: check.entryCount }
  } finally {
    await fh.close()
  }
}
