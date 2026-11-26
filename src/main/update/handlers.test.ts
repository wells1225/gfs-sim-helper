// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInstall, UpdateState } from '../../shared/model.ts'
import type { AppContext, Gate, GateResult, Updater, WriteRequest } from '../ports.ts'
import { CHECK_ON_START_EVERY_MS, LAST_CHECK_FILE, updateHandlers } from './handlers.ts'

const IDLE: UpdateState = { state: 'idle', current: '0.2.0', checkedAt: null, justUpdated: false }
const AVAILABLE: UpdateState = { state: 'available', current: '0.2.0', next: '0.3.0' }
const READY: UpdateState = { state: 'ready', current: '0.2.0', next: '0.3.0' }

let dataDir = ''
let stateDir = ''

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sims-helper-update-'))
  stateDir = join(dataDir, 'state')
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/** A stand-in for the write gate: it records each request and does the app-data writes for real. */
function diskGate(answer?: () => Promise<GateResult>) {
  const requests: WriteRequest[] = []
  const gate: Gate = {
    run: vi.fn(async (request: WriteRequest): Promise<GateResult> => {
      requests.push(request)
      if (answer) return await answer()
      for (const op of request.ops) {
        if (op.op !== 'write') throw new Error(`unexpected op ${op.op}`)
        await mkdir(dirname(op.path), { recursive: true })
        await writeFile(op.path, op.data)
      }
      return { status: 'done' }
    })
  }
  return { gate, requests }
}

function setup(
  options: { state?: UpdateState; busy?: () => boolean; gate?: Gate; start?: Date } = {}
) {
  let now = options.start ?? new Date('2026-11-24T10:00:00.000Z')
  const state = options.state ?? IDLE
  const updater = {
    state: vi.fn((): UpdateState => state),
    check: vi.fn(async (): Promise<UpdateState> => AVAILABLE),
    download: vi.fn(async (): Promise<UpdateState> => READY),
    install: vi.fn((): UpdateInstall => ({ status: 'restarting' }))
  } satisfies Updater
  const gate = options.gate ?? diskGate().gate
  const ctx = {
    updater,
    gate,
    paths: { dataDir, stateDir },
    busy: options.busy ?? (() => false),
    clock: { now: () => now }
  } as unknown as AppContext
  const later = (ms: number) => {
    now = new Date(now.getTime() + ms)
  }
  return { handlers: updateHandlers(ctx), updater, later, now: () => now }
}

describe('update:get', () => {
  it("answers the updater's state", async () => {
    const { handlers } = setup({ state: AVAILABLE })
    expect(await handlers['update:get']()).toEqual(AVAILABLE)
  })
})

describe('update:check', () => {
  it('checks on the first start, then at most once in 24 hours', async () => {
    const { handlers, updater, later } = setup()
    expect(await handlers['update:check']({ by: 'start' })).toEqual(AVAILABLE)
    expect(updater.check).toHaveBeenCalledTimes(1)

    later(CHECK_ON_START_EVERY_MS - 1)
    expect(await handlers['update:check']({ by: 'start' })).toEqual(IDLE)
    expect(updater.check).toHaveBeenCalledTimes(1)

    later(1)
    await handlers['update:check']({ by: 'start' })
    expect(updater.check).toHaveBeenCalledTimes(2)
  })

  it('checks on every click, even right after a start check', async () => {
    const { handlers, updater } = setup()
    await handlers['update:check']({ by: 'start' })
    await handlers['update:check']({ by: 'click' })
    await handlers['update:check']({ by: 'click' })
    expect(updater.check).toHaveBeenCalledTimes(3)
  })

  it('a click check also counts toward the 24 hours', async () => {
    const { handlers, updater } = setup()
    await handlers['update:check']({ by: 'click' })
    expect(await handlers['update:check']({ by: 'start' })).toEqual(IDLE)
    expect(updater.check).toHaveBeenCalledTimes(1)
  })

  it('keeps the 24 hours across closing and reopening the app', async () => {
    const first = setup()
    await first.handlers['update:check']({ by: 'start' })
    expect(first.updater.check).toHaveBeenCalledTimes(1)

    const reopened = setup({ start: new Date(first.now().getTime() + CHECK_ON_START_EVERY_MS - 1) })
    expect(await reopened.handlers['update:check']({ by: 'start' })).toEqual(IDLE)
    expect(reopened.updater.check).not.toHaveBeenCalled()

    const nextDay = setup({ start: new Date(first.now().getTime() + CHECK_ON_START_EVERY_MS) })
    await nextDay.handlers['update:check']({ by: 'start' })
    expect(nextDay.updater.check).toHaveBeenCalledTimes(1)
  })

  it('writes the check time to the app data folder through the gate', async () => {
    const { gate, requests } = diskGate()
    const { handlers, now } = setup({ gate })
    await handlers['update:check']({ by: 'start' })
    expect(requests).toEqual([
      {
        reason: 'state',
        folderPath: null,
        ops: [
          {
            op: 'write',
            path: join(stateDir, LAST_CHECK_FILE),
            data: JSON.stringify({ lastCheckAt: now().toISOString() }),
            mode: 'replace'
          }
        ]
      }
    ])
    expect(JSON.parse(await readFile(join(stateDir, LAST_CHECK_FILE), 'utf8'))).toEqual({
      lastCheckAt: now().toISOString()
    })
  })

  it('a click is never held back by a saved time, and its time is saved too', async () => {
    const first = setup()
    await first.handlers['update:check']({ by: 'click' })
    const reopened = setup({ start: new Date(first.now().getTime() + 1000) })
    await reopened.handlers['update:check']({ by: 'click' })
    expect(reopened.updater.check).toHaveBeenCalledTimes(1)
    expect(await reopened.handlers['update:check']({ by: 'start' })).toEqual(IDLE)
    expect(reopened.updater.check).toHaveBeenCalledTimes(1)
  })

  it('a missing, unreadable or future-dated saved time checks now, once', async () => {
    const saved = [
      null,
      'not json',
      JSON.stringify({ lastCheckAt: 12 }),
      JSON.stringify({ lastCheckAt: 'not a date' }),
      JSON.stringify({}),
      JSON.stringify(null),
      JSON.stringify({ lastCheckAt: '2026-11-25T10:00:00.000Z' })
    ]
    for (const text of saved) {
      await rm(stateDir, { recursive: true, force: true })
      if (text !== null) {
        await mkdir(stateDir, { recursive: true })
        await writeFile(join(stateDir, LAST_CHECK_FILE), text)
      }
      const { handlers, updater } = setup()
      await handlers['update:check']({ by: 'start' })
      await handlers['update:check']({ by: 'start' })
      expect(updater.check, String(text)).toHaveBeenCalledTimes(1)
    }
  })

  it('a gate that refuses, fails or throws still checks, and keeps the 24 hours while the app is open', async () => {
    const answers: (() => Promise<GateResult>)[] = [
      async () => ({ status: 'refused', refusal: { reason: 'check-failed' } }) as GateResult,
      async () => ({ status: 'failed', opsDone: 0, detail: 'disk full' }),
      async () => {
        throw new Error('not implemented: runGate')
      }
    ]
    for (const answer of answers) {
      const { handlers, updater } = setup({ gate: diskGate(answer).gate })
      expect(await handlers['update:check']({ by: 'start' })).toEqual(AVAILABLE)
      expect(await handlers['update:check']({ by: 'start' })).toEqual(IDLE)
      expect(updater.check).toHaveBeenCalledTimes(1)
    }
  })

  it('a request of the wrong shape checks nothing and answers the state', async () => {
    const { handlers, updater } = setup()
    const bad: unknown[] = [undefined, null, 'start', {}, { by: 'auto' }, { by: 'click', extra: 1 }, ['click']]
    for (const req of bad) {
      expect(await handlers['update:check'](req as never)).toEqual(IDLE)
    }
    expect(updater.check).not.toHaveBeenCalled()
  })
})

describe('update:download', () => {
  it('asks the updater to download', async () => {
    const { handlers, updater } = setup({ state: AVAILABLE })
    expect(await handlers['update:download']()).toEqual(READY)
    expect(updater.download).toHaveBeenCalledTimes(1)
  })

  it('a request that carries anything downloads nothing', async () => {
    const { handlers, updater } = setup({ state: AVAILABLE })
    expect(await handlers['update:download']({ url: 'http://x' } as never)).toEqual(AVAILABLE)
    expect(updater.download).not.toHaveBeenCalled()
  })
})

describe('update:install', () => {
  it('starts the install when nothing else is running', async () => {
    const { handlers, updater } = setup({ state: READY })
    expect(await handlers['update:install']()).toEqual({ status: 'restarting' })
    expect(updater.install).toHaveBeenCalledTimes(1)
  })

  it("answers busy while a change runs, and never asks the updater", async () => {
    const { handlers, updater } = setup({ state: READY, busy: () => true })
    expect(await handlers['update:install']()).toEqual({ status: 'refused', why: 'busy' })
    expect(updater.install).not.toHaveBeenCalled()
  })

  it('counts a busy() that throws as busy', async () => {
    const { handlers, updater } = setup({
      state: READY,
      busy: () => {
        throw new Error('boom')
      }
    })
    expect(await handlers['update:install']()).toEqual({ status: 'refused', why: 'busy' })
    expect(updater.install).not.toHaveBeenCalled()
  })

  it('a request that carries anything installs nothing', async () => {
    const { handlers, updater } = setup({ state: READY })
    expect(await handlers['update:install']({ silent: false } as never)).toEqual({ status: 'refused', why: 'not-ready' })
    expect(updater.install).not.toHaveBeenCalled()
  })
})

describe('logging', () => {
  it('logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {})
    )
    const { handlers } = setup({ state: READY })
    await handlers['update:get']()
    await handlers['update:check']({ by: 'click' })
    await handlers['update:check']('bad' as never)
    await handlers['update:download']()
    await handlers['update:install']()
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })
})
