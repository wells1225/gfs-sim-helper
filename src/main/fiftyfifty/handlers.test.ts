// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { FiftyResult } from '../../shared/model.ts'
import { sampleFiftyFifty, sampleScan } from '../../shared/testing/sample.ts'
import type { AppContext } from '../ports.ts'
import { makeFiftyHandlers, type FiftyApi } from './handlers.ts'

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
    await h['fifty:answer']({ answer: 'worked' })
    await h['fifty:finish']({ keep: 'keep-set-aside' })
    expect(seen).toEqual([scan, 'worked', 'keep-set-aside'])
  })

  it('refuses answers and choices it does not know, without calling the driver', async () => {
    const log: string[] = []
    const h = makeFiftyHandlers(fakeCtx(), recordingApi(log))
    for (const bad of [undefined, null, {}, { answer: 'maybe' }, { answer: 1 }, 'crashed']) {
      await expect(h['fifty:answer'](bad as never)).rejects.toThrow(/answer/)
    }
    for (const bad of [undefined, { keep: 'all' }]) {
      await expect(h['fifty:finish'](bad as never)).rejects.toThrow(/keep/)
    }
    expect(log).toEqual([])
  })

  it('runs one call at a time, so a double click cannot answer two rounds at once', async () => {
    const log: string[] = []
    const h = makeFiftyHandlers(fakeCtx(), recordingApi(log, { giveAnswer: 20 }))
    await Promise.all([
      h['fifty:answer']({ answer: 'crashed' }),
      h['fifty:answer']({ answer: 'crashed' }),
      h['fifty:stop']()
    ])
    expect(log).toEqual([
      'giveAnswer:start', 'giveAnswer:end', 'giveAnswer:start', 'giveAnswer:end', 'stop:start', 'stop:end'
    ])
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
})
