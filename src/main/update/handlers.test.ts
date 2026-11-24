// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { UpdateInstall, UpdateState } from '../../shared/model.ts'
import type { AppContext, Updater } from '../ports.ts'
import { CHECK_ON_START_EVERY_MS, updateHandlers } from './handlers.ts'

const IDLE: UpdateState = { state: 'idle', current: '0.2.0', checkedAt: null, justUpdated: false }
const AVAILABLE: UpdateState = { state: 'available', current: '0.2.0', next: '0.3.0' }
const READY: UpdateState = { state: 'ready', current: '0.2.0', next: '0.3.0' }

function setup(options: { state?: UpdateState; busy?: () => boolean } = {}) {
  let now = new Date('2026-11-24T10:00:00.000Z')
  const state = options.state ?? IDLE
  const updater = {
    state: vi.fn((): UpdateState => state),
    check: vi.fn(async (): Promise<UpdateState> => AVAILABLE),
    download: vi.fn(async (): Promise<UpdateState> => READY),
    install: vi.fn((): UpdateInstall => ({ status: 'restarting' }))
  } satisfies Updater
  const ctx = {
    updater,
    busy: options.busy ?? (() => false),
    clock: { now: () => now }
  } as unknown as AppContext
  const later = (ms: number) => {
    now = new Date(now.getTime() + ms)
  }
  return { handlers: updateHandlers(ctx), updater, later }
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
