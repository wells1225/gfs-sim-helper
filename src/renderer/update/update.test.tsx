import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInstall, UpdateState } from '../../shared/model.ts'
import { ApiProvider } from '../api.tsx'
import { Toaster } from '../components/ui/sonner.tsx'
import { fakeApi, type FakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { UpdateBanner } from './UpdateBanner.tsx'
import { UpdateRow } from './UpdateRow.tsx'

const IDLE: UpdateState = { state: 'idle', current: '0.2.0', checkedAt: '2026-11-24T10:00:00.000Z', justUpdated: false }
const AVAILABLE: UpdateState = { state: 'available', current: '0.2.0', next: '0.3.0' }
const READY: UpdateState = { state: 'ready', current: '0.2.0', next: '0.3.0' }
const FAILED_DOWNLOAD: UpdateState = { state: 'failed', current: '0.2.0', step: 'download', why: 'bad-file' }
const FAILED_CHECK: UpdateState = { state: 'failed', current: '0.2.0', step: 'check', why: 'offline' }
const downloading = (percent: number): UpdateState => ({ state: 'downloading', current: '0.2.0', next: '0.3.0', percent })

const RAW_ERROR = 'net::ERR_NAME_NOT_RESOLVED github.com C:\\Users\\Lila'
const reject = () => Promise.reject(new Error(RAW_ERROR))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function show(answers: FakeApiAnswers, ui: 'banner' | 'row' | 'both' = 'banner') {
  const api = fakeApi(answers)
  const view = render(
    <ApiProvider value={api}>
      {ui !== 'row' && <UpdateBanner />}
      {ui !== 'banner' && <UpdateRow />}
      <Toaster />
    </ApiProvider>
  )
  return { api, ...view }
}

const callsTo = (api: FakeApi, channel: string) => api.calls.filter((call) => call.channel === channel)

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {})
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('UpdateBanner', () => {
  it('checks once, as a start check, when it opens', async () => {
    const { api } = show({ 'update:check': IDLE })
    await settle()
    expect(callsTo(api, 'update:check')).toEqual([{ channel: 'update:check', req: { by: 'start' } }])
  })

  it('asks again every hour as a start check, which the main process lets through once a day', async () => {
    vi.useFakeTimers()
    const { api } = show({ 'update:check': IDLE })
    await settle()
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000))
    expect(callsTo(api, 'update:check').map((call) => call.req)).toEqual([{ by: 'start' }, { by: 'start' }])
  })

  it.each([
    ['off', { state: 'off', why: 'switched-off' } as UpdateState],
    ['idle', IDLE],
    ['checking', { state: 'checking', current: '0.2.0' } as UpdateState],
    ['a failed check', FAILED_CHECK]
  ])('shows nothing for %s', async (_name, state) => {
    const { container } = show({ 'update:check': state })
    await settle()
    expect(container.querySelector('[aria-label="Update"]')).toBeNull()
  })

  it('shows nothing, and no error text, when the check is rejected', async () => {
    const { container } = show({ 'update:check': reject })
    await settle()
    expect(container.querySelector('[aria-label="Update"]')).toBeNull()
    expect(document.body.textContent).not.toContain('ERR_')
  })

  it('says a new version is ready, with Update now and Later', async () => {
    show({ 'update:check': AVAILABLE })
    expect(await screen.findByText('A new version of Sims Helper is ready.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
  })

  it('Later hides it', async () => {
    const user = userEvent.setup()
    show({ 'update:check': AVAILABLE })
    await user.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByText('A new version of Sims Helper is ready.')).toBeNull()
  })

  it('Update now downloads, asks update:get once a second only while downloading, then shows ready', async () => {
    vi.useFakeTimers()
    const download = deferred<UpdateState>()
    let percent = 0
    const { api } = show({
      'update:check': AVAILABLE,
      'update:download': () => download.promise,
      'update:get': () => downloading((percent += 21))
    })
    await settle()
    expect(callsTo(api, 'update:get')).toHaveLength(0)

    act(() => screen.getByRole('button', { name: 'Update now' }).click())
    await settle()
    expect(screen.getByText('Getting the update… 0%')).toBeInTheDocument()
    expect(callsTo(api, 'update:download')).toHaveLength(1)

    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(screen.getByText('Getting the update… 21%')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(screen.getByText('Getting the update… 42%')).toBeInTheDocument()
    expect(callsTo(api, 'update:get')).toHaveLength(2)

    download.resolve(READY)
    await settle()
    expect(screen.getByText('The update is ready. Sims Helper will close and open again to finish.')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(callsTo(api, 'update:get')).toHaveLength(2)
  })

  it('a late progress answer never takes back a finished download', async () => {
    vi.useFakeTimers()
    const download = deferred<UpdateState>()
    const get = deferred<UpdateState>()
    show({ 'update:check': AVAILABLE, 'update:download': () => download.promise, 'update:get': () => get.promise })
    await settle()
    act(() => screen.getByRole('button', { name: 'Update now' }).click())
    await act(() => vi.advanceTimersByTimeAsync(1000)) // update:get asked, not answered yet
    download.resolve(READY)
    await settle()
    get.resolve(downloading(50))
    await settle()
    expect(screen.getByText('The update is ready. Sims Helper will close and open again to finish.')).toBeInTheDocument()
  })

  it('a rejected download shows nothing and no error text', async () => {
    const user = userEvent.setup()
    const { container } = show({ 'update:check': AVAILABLE, 'update:download': reject, 'update:get': reject })
    await user.click(await screen.findByRole('button', { name: 'Update now' }))
    await settle()
    expect(container.querySelector('[aria-label="Update"]')).toBeNull()
    expect(document.body.textContent).not.toContain('ERR_')
  })

  it('a failed download says nothing changed, and Try again checks, then downloads', async () => {
    const user = userEvent.setup()
    const { api } = show({
      'update:check': ({ by }) => (by === 'start' ? FAILED_DOWNLOAD : AVAILABLE),
      'update:download': READY
    })
    expect(await screen.findByText("The update didn't download. Nothing changed.")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('The update is ready. Sims Helper will close and open again to finish.')).toBeInTheDocument()
    expect(api.calls.map((call) => [call.channel, call.req])).toEqual([
      ['update:check', { by: 'start' }],
      ['update:check', { by: 'click' }],
      ['update:download', undefined]
    ])
  })

  it('Try again downloads nothing when the check finds no update', async () => {
    const user = userEvent.setup()
    const { api } = show({ 'update:check': ({ by }) => (by === 'start' ? FAILED_DOWNLOAD : IDLE) })
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    await settle()
    expect(callsTo(api, 'update:download')).toHaveLength(0)
    expect(screen.queryByText("The update didn't download. Nothing changed.")).toBeNull()
  })

  it('Restart now installs, and says Sims Helper is closing', async () => {
    const user = userEvent.setup()
    const { api } = show({ 'update:check': READY, 'update:install': { status: 'restarting' } })
    await user.click(await screen.findByRole('button', { name: 'Restart now' }))
    expect(await screen.findByText('Closing Sims Helper to finish the update…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeDisabled()
    expect(callsTo(api, 'update:install')).toHaveLength(1)
  })

  it('Restart now while a change runs says to wait, and keeps the update ready', async () => {
    const user = userEvent.setup()
    const busy: UpdateInstall = { status: 'refused', why: 'busy' }
    show({ 'update:check': READY, 'update:install': busy })
    await user.click(await screen.findByRole('button', { name: 'Restart now' }))
    expect(
      await screen.findByText('Sims Helper is in the middle of a change. Wait for it to finish, then try again.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeEnabled()
  })

  it('Restart now refused as not ready asks for the state again', async () => {
    const user = userEvent.setup()
    const { api } = show({
      'update:check': READY,
      'update:install': { status: 'refused', why: 'not-ready' },
      'update:get': AVAILABLE
    })
    await user.click(await screen.findByRole('button', { name: 'Restart now' }))
    expect(await screen.findByText('A new version of Sims Helper is ready.')).toBeInTheDocument()
    expect(callsTo(api, 'update:get')).toHaveLength(1)
  })

  it('says "Sims Helper was updated." once after an update', async () => {
    show({ 'update:check': { ...IDLE, justUpdated: true } })
    expect(await screen.findByText('Sims Helper was updated.')).toBeInTheDocument()
    expect(screen.getAllByText('Sims Helper was updated.')).toHaveLength(1)
  })
})

describe('UpdateRow', () => {
  it('shows the version, and "You have the newest version." after Check for updates', async () => {
    const user = userEvent.setup()
    const { api } = show({ 'update:get': IDLE, 'update:check': IDLE }, 'row')
    expect(await screen.findByText('Version 0.2.0')).toBeInTheDocument()
    expect(screen.queryByText('You have the newest version.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('You have the newest version.')).toBeInTheDocument()
    expect(callsTo(api, 'update:check')).toEqual([{ channel: 'update:check', req: { by: 'click' } }])
  })

  it.each([
    ['fails', () => FAILED_CHECK],
    ['is rejected', reject]
  ])('says "Couldn\'t check right now. Try again later." when the check %s', async (_name, check) => {
    const user = userEvent.setup()
    show({ 'update:get': IDLE, 'update:check': check }, 'row')
    await user.click(await screen.findByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText("Couldn't check right now. Try again later.")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('ERR_')
  })

  it.each([
    ['not-installed-app', 'Updates work only in the installed Sims Helper.'],
    ['switched-off', 'Updates are switched off on this PC.'],
    [
      'unsafe-install-folder',
      'Updates are off because Sims Helper is installed in your Documents or OneDrive folder. Reinstall it in the folder Setup suggests to get updates.'
    ]
  ] as const)('with updates off (%s), says why and offers no check', async (why, note) => {
    show({ 'update:get': { state: 'off', why } }, 'row')
    expect(await screen.findByText(note)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
  })

  it('a check from About that finds a version shows the banner, even after Later', async () => {
    const user = userEvent.setup()
    show({ 'update:check': ({ by }) => (by === 'start' ? AVAILABLE : AVAILABLE), 'update:get': AVAILABLE }, 'both')
    await user.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByText('A new version of Sims Helper is ready.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('A new version is ready. You’ll find it at the top of this page.')).toBeInTheDocument()
    expect(screen.getByText('A new version of Sims Helper is ready.')).toBeInTheDocument()
  })
})

describe('UpdateBanner with the real handlers', () => {
  it('checks again within a day of the last check, even when the first check was stamped late', async () => {
    vi.useFakeTimers()
    const { updateHandlers } = await import('../../main/update/handlers.ts')
    let checks = 0
    const updater = {
      state: (): UpdateState => IDLE,
      check: async (): Promise<UpdateState> => {
        checks += 1
        return IDLE
      },
      download: async (): Promise<UpdateState> => IDLE,
      install: (): UpdateInstall => ({ status: 'refused', why: 'not-ready' })
    }
    const handlers = updateHandlers({ updater, busy: () => false, clock: { now: () => new Date() } } as never)
    // The main process answers a few milliseconds after the window asks, as it does in the app.
    const late = async <T,>(call: () => Promise<T>) => {
      await vi.advanceTimersByTimeAsync(5)
      return await call()
    }
    show({
      'update:check': (req) => late(() => handlers['update:check'](req)),
      'update:get': () => handlers['update:get']()
    })
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(checks).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 60 * 60 * 1000))
    expect(checks).toBe(2)
  })
})
