import { createRng } from './prng.ts'

export interface ResourceKey {
  type: number
  group: number
  instance: bigint
}

export type DbpfVariant =
  | 'valid'
  | 'bad-magic'
  | 'truncated-index'
  | 'sims3'
  | 'truncated-header'

export interface WriteDbpfOptions {
  keys: readonly ResourceKey[]
  variant?: DbpfVariant
  constantFlags?: number
  seed?: number
}

const DBPF_HEADER_SIZE = 96
const DBPF_MAGIC = Buffer.from('DBPF', 'ascii')
const BAD_MAGIC = Buffer.from('BAD!', 'ascii')
const COMPRESSION_NONE = 0x0000
const COMMITTED_FLAG = 0x0001
const EXTENDED_SIZE_BIT = 0x80000000

export function parseHexUint32(value: string): number {
  const normalized = value.trim()
  // Number() rejects trailing junk that parseInt would silently drop.
  const parsed = normalized === '' ? Number.NaN : Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`Invalid uint32 string: ${value}`)
  }
  return parsed >>> 0
}

export function parseHexUint64(value: string): bigint {
  const normalized = value.trim()
  if (normalized === '') {
    throw new Error('Invalid uint64 string: empty')
  }
  const parsed = BigInt(normalized)
  if (parsed < 0n || parsed > 0xffffffffffffffffn) {
    throw new Error(`Uint64 out of range: ${value.toString()}`)
  }
  return parsed
}

function countConstantFlags(flags: number): number {
  let count = 0
  if ((flags & 0x01) !== 0) count += 1
  if ((flags & 0x02) !== 0) count += 1
  if ((flags & 0x04) !== 0) count += 1
  return count
}

function makeDefaultPayload(key: ResourceKey, index: number, seed: number): Buffer {
  const rng = createRng((seed ^ (index * 2654435761) ^ key.type ^ key.group) >>> 0)
  const payload = Buffer.alloc(16)
  payload.writeUInt32LE(key.type >>> 0, 0)
  payload.writeUInt32LE(key.group >>> 0, 4)
  payload.writeUInt32LE(rng.nextUint32(), 8)
  payload.writeUInt32LE(rng.nextUint32(), 12)
  return payload
}

/**
 * Writes a DBPF 2.1 (Sims 4) package buffer, or one of the broken variants used for tests.
 * Layout follows docs/research/fable-files-logs-safety.md section 4.
 */
export function writeDbpf(options: WriteDbpfOptions): Buffer {
  const { keys, variant = 'valid', constantFlags = 0, seed = 1 } = options

  if ((constantFlags & ~0x07) !== 0) {
    throw new Error(`Unsupported DBPF constant flags: 0x${constantFlags.toString(16)}`)
  }

  const hasConstType = (constantFlags & 0x01) !== 0
  const hasConstGroup = (constantFlags & 0x02) !== 0
  const hasConstInstanceHigh = (constantFlags & 0x04) !== 0

  if (constantFlags !== 0 && keys.length === 0) {
    throw new Error('Cannot set constantFlags with zero keys')
  }

  const firstKey = keys[0]
  const constType = firstKey ? firstKey.type >>> 0 : 0
  const constGroup = firstKey ? firstKey.group >>> 0 : 0
  const constInstanceHigh = firstKey ? Number((firstKey.instance >> 32n) & 0xffffffffn) >>> 0 : 0

  for (const key of keys) {
    if (hasConstType && (key.type >>> 0) !== constType) {
      throw new Error('constantFlags bit 0 requires all keys to share type')
    }
    if (hasConstGroup && (key.group >>> 0) !== constGroup) {
      throw new Error('constantFlags bit 1 requires all keys to share group')
    }
    const high = Number((key.instance >> 32n) & 0xffffffffn) >>> 0
    if (hasConstInstanceHigh && high !== constInstanceHigh) {
      throw new Error('constantFlags bit 2 requires all keys to share instance high half')
    }
  }

  const entryPayloads: Buffer[] = keys.map((key, idx) => makeDefaultPayload(key, idx, seed))

  const entryOffsets: number[] = []
  let payloadCursor = DBPF_HEADER_SIZE
  for (const payload of entryPayloads) {
    entryOffsets.push(payloadCursor)
    payloadCursor += payload.length
  }

  const indexOffset = payloadCursor
  const k = countConstantFlags(constantFlags)
  const entryStride = 32 - 4 * k
  const indexSize = 4 + 4 * k + keys.length * entryStride
  const totalSize = indexOffset + indexSize

  const buf = Buffer.alloc(totalSize)

  // 96-byte DBPF header (all little-endian)
  const magic = variant === 'bad-magic' ? BAD_MAGIC : DBPF_MAGIC
  magic.copy(buf, 0)
  buf.writeUInt32LE(2, 4) // major version
  buf.writeUInt32LE(variant === 'sims3' ? 0 : 1, 8) // minor version: 1 = Sims 4, 0 = Sims 3
  buf.writeUInt32LE(keys.length, 36) // index entry count
  buf.writeUInt32LE(0, 40) // index offset short form (Maxis always writes 0)
  buf.writeUInt32LE(indexSize, 44) // index size in bytes
  buf.writeUInt32LE(3, 60) // constant 3
  buf.writeBigUInt64LE(BigInt(indexOffset), 64) // index offset long form (absolute)

  // Resource payloads
  for (let i = 0; i < entryPayloads.length; i += 1) {
    const payload = entryPayloads[i] as Buffer
    const offset = entryOffsets[i] as number
    payload.copy(buf, offset)
  }

  // Index block
  let cursor = indexOffset
  buf.writeUInt32LE(constantFlags >>> 0, cursor)
  cursor += 4

  if (hasConstType) {
    buf.writeUInt32LE(constType, cursor)
    cursor += 4
  }
  if (hasConstGroup) {
    buf.writeUInt32LE(constGroup, cursor)
    cursor += 4
  }
  if (hasConstInstanceHigh) {
    buf.writeUInt32LE(constInstanceHigh, cursor)
    cursor += 4
  }

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] as ResourceKey
    const payload = entryPayloads[i] as Buffer
    const offset = entryOffsets[i] as number
    const instanceHigh = Number((key.instance >> 32n) & 0xffffffffn) >>> 0
    const instanceLow = Number(key.instance & 0xffffffffn) >>> 0

    if (!hasConstType) {
      buf.writeUInt32LE(key.type >>> 0, cursor)
      cursor += 4
    }
    if (!hasConstGroup) {
      buf.writeUInt32LE(key.group >>> 0, cursor)
      cursor += 4
    }
    if (!hasConstInstanceHigh) {
      buf.writeUInt32LE(instanceHigh, cursor)
      cursor += 4
    }

    buf.writeUInt32LE(instanceLow, cursor)
    cursor += 4
    buf.writeUInt32LE(offset >>> 0, cursor)
    cursor += 4
    buf.writeUInt32LE(((payload.length & 0x7fffffff) | EXTENDED_SIZE_BIT) >>> 0, cursor)
    cursor += 4
    buf.writeUInt32LE(payload.length >>> 0, cursor)
    cursor += 4
    buf.writeUInt16LE(COMPRESSION_NONE, cursor)
    cursor += 2
    buf.writeUInt16LE(COMMITTED_FLAG, cursor)
    cursor += 2
  }

  if (variant === 'truncated-header') {
    return buf.subarray(0, 32)
  }

  if (variant === 'truncated-index') {
    const cutLength = Math.max(DBPF_HEADER_SIZE, indexOffset + Math.floor(indexSize / 2))
    return buf.subarray(0, cutLength)
  }

  return buf
}
