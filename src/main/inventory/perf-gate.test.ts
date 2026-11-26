import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { baselineLimitMs, timingFailures } from './perf-gate.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))

describe('inventory timing gate', () => {
  it('allows max(2 x baseline, 5000 ms)', () => {
    expect(baselineLimitMs(1668)).toBe(5000)
    expect(baselineLimitMs(2500)).toBe(5000)
    expect(baselineLimitMs(4000)).toBe(8000)
  })

  it('passes a noisy Windows run (2630 ms and 4900 ms against a 1668 ms baseline)', () => {
    expect(timingFailures(2630, 1668)).toEqual([])
    expect(timingFailures(4900, 1668)).toEqual([])
    expect(timingFailures(5000, 1668)).toEqual([])
  })

  it('fails only above the limit', () => {
    expect(timingFailures(5001, 1668)).toHaveLength(1)
    expect(timingFailures(8000, 4000)).toEqual([])
    expect(timingFailures(8001, 4000)).toHaveLength(1)
  })

  it('keeps the 30 s hard limit, with or without a baseline', () => {
    expect(timingFailures(30_000, null)).toEqual([])
    expect(timingFailures(30_001, null)).toHaveLength(1)
    expect(timingFailures(30_001, 20_000)).toHaveLength(1)
    expect(timingFailures(40_001, 20_000)).toHaveLength(2)
  })

  it('keeps the recorded Windows baseline', async () => {
    const raw = await readFile(join(THIS_DIR, 'perf-baseline.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ windowsBigMs: 1668 })
  })
})
