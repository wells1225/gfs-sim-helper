// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FiftyResult } from '../../shared/model.ts'
import { sampleFiftyFifty, sampleScan } from '../../shared/testing/sample.ts'
import type { AppContext } from '../ports.ts'
import { fiftyHandlers, makeFiftyHandlers, type FiftyApi } from './handlers.ts'

const OK: FiftyResult = { status: 'ok', state: sampleFiftyFifty() }

function fakeCtx(scan = sampleScan()): AppContext {
  return { session: { scan } } as unknown as AppContext
}

function recordingApi(log: string[], delays: Record<string, number> = {}): FiftyApi {
  const step = (name: string) => async (..._args: unknown[]) => {
    log.push(`${name}:start`)
    await new Promise((r) => setTimeout(r, delays[name] ?? 0))
    log.push(`${name}:end`)
    return OK
  }
  return {
    loadState: async () => {
      log.push('get')
      return OK.status === 'ok' ? OK.state : null
    },
    start: step('start'),
    beginRound: step('beginRound'),
    giveAnswer: step('giveAnswer'),
    stop: step('stop'),
    finish: step('finish')
  }
}

describe('fiftyHandlers', () => {
  it('passes the session scan to start and the checked answer and choice through', async () => {
    const scan = sampleScan()
    const seen: unknown[] = []
    const api: FiftyApi = {
      ...recordingApi([]),
      start: async (_deps, s) => (seen.push(s), OK),
      giveAnswer: async (_deps, a) => (seen.push(a), OK),
      finish: async (_deps, k) => (seen.push(k), OK)
    }
    const h = makeFiftyHandlers(fakeCtx(scan), api)
    await h['fifty:start']()
    await h['fifty:answer']({ answer: 'worked', round: 0 })
    await h['fifty:finish']({ keep: 'keep-set-aside' })
    expect(seen).toEqual([scan, 'worked', 'keep-set-aside'])
  })

  it('refuses answers, bad rounds, and choices it does not know, without calling the driver', async () => {
    const log: string[] = []
    const h = makeFiftyHandlers(fakeCtx(), recordingApi(log))
    for (const bad of [undefined, null, {}, { answer: 'maybe' }, { answer: 1 }, 'crashed', { answer: 'crashed' }, { answer: 'crashed', round: -1 }, { answer: 'crashed', round: '1' }]) {
      await expect(h['fifty:answer'](bad as never)).rejects.toThrow(/answer|round/)
    }
    for (const bad of [undefined, { keep: 'all' }]) {
      await expect(h['fifty:finish'](bad as never)).rejects.toThrow(/keep/)
    }
    expect(log).toEqual([])
  })

  it('ignores a second answer that arrives while a step is in flight, while still running stop next', async () => {
    const log: string[] = []
    const h = makeFiftyHandlers(fakeCtx(), recordingApi(log, { giveAnswer: 20 }))
    const [first, second, stopped] = await Promise.all([
      h['fifty:answer']({ answer: 'crashed', round: 0 }),
      h['fifty:answer']({ answer: 'crashed', round: 0 }),
      h['fifty:stop']()
    ])
    expect(first).toEqual(OK)
    expect(second).toEqual(OK)
    expect(stopped).toEqual(OK)
    expect(log).toEqual(['giveAnswer:start', 'giveAnswer:end', 'get', 'stop:start', 'stop:end'])
  })

  it('ignores a stale answer arriving while begin-round is still setting up the next round', async () => {
    const log: string[] = []
    const h = makeFiftyHandlers(fakeCtx(), recordingApi(log, { beginRound: 20 }))
    await Promise.all([h['fifty:begin-round'](), h['fifty:answer']({ answer: 'worked', round: 0 })])
    expect(log).toEqual(['beginRound:start', 'beginRound:end', 'get'])
  })

  // 'ok' with no session would show her the Start button over a damaged file.
  it('a late answer over a damaged progress file is refused, never ok with no session', async () => {
    const api: FiftyApi = { ...recordingApi([], { beginRound: 20 }), loadState: async () => ({ status: 'damaged' }) }
    const h = makeFiftyHandlers(fakeCtx(), api)
    const [, late] = await Promise.all([h['fifty:begin-round'](), h['fifty:answer']({ answer: 'worked', round: 0 })])
    expect(late).toEqual({ status: 'refused', refusal: { why: 'fifty-fifty-running' } })
  })

  it('forwards the round to giveAnswer', async () => {
    const seen: unknown[] = []
    const api: FiftyApi = {
      ...recordingApi([]),
      giveAnswer: async (_deps, a, r) => (seen.push([a, r]), OK)
    }
    const h = makeFiftyHandlers(fakeCtx(), api)
    await h['fifty:answer']({ answer: 'worked', round: 2 })
    expect(seen).toEqual([['worked', 2]])
  })

  it('a call that throws does not block the next one', async () => {
    const api: FiftyApi = { ...recordingApi([]), beginRound: async () => { throw new Error('boom') } }
    const h = makeFiftyHandlers(fakeCtx(), api)
    await expect(h['fifty:begin-round']()).rejects.toThrow('boom')
    expect(await h['fifty:stop']()).toEqual(OK)
  })

  it('fifty:get returns the saved state', async () => {
    const h = makeFiftyHandlers(fakeCtx(), recordingApi([]))
    expect(await h['fifty:get']()).toEqual(OK.status === 'ok' ? OK.state : null)
  })

  it('the real fifty:get answers the damaged shape when the progress file cannot be read', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'fifty-handlers-'))
    try {
      const h = fiftyHandlers({ session: { scan: null }, paths: { stateDir } } as unknown as AppContext)
      expect(await h['fifty:get']()).toBeNull()
      await writeFile(join(stateDir, 'fiftyfifty.json'), '{"phase": "awaiting')
      expect(await h['fifty:get']()).toEqual({ status: 'damaged' })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
