export interface SeededRng {
  nextUint32(): number
  nextInt(min: number, maxExclusive: number): number
  pick<T>(items: readonly T[]): T
  bytes(length: number): Buffer
  hex(byteLength: number): string
}

/**
 * Deterministic Mulberry32 PRNG for reproducible fixture generation.
 */
export function createRng(seed: number): SeededRng {
  let state = seed >>> 0

  function nextUint32(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }

  function nextInt(min: number, maxExclusive: number): number {
    if (maxExclusive <= min) {
      throw new Error(`Invalid range [${min}, ${maxExclusive})`)
    }
    const span = maxExclusive - min
    return min + (nextUint32() % span)
  }

  function pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty array')
    }
    const index = nextInt(0, items.length)
    return items[index] as T
  }

  function bytes(length: number): Buffer {
    const out = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const word = nextUint32()
      const remaining = length - offset
      if (remaining >= 4) {
        out.writeUInt32LE(word, offset)
        offset += 4
      } else {
        for (let i = 0; i < remaining; i += 1) {
          out[offset + i] = (word >>> (i * 8)) & 0xff
        }
        offset += remaining
      }
    }
    return out
  }

  function hex(byteLength: number): string {
    return bytes(byteLength).toString('hex')
  }

  return { nextUint32, nextInt, pick, bytes, hex }
}
