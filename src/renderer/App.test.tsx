import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_TITLE } from '../shared/app.ts'
import type { StartupRecovery } from '../shared/model.ts'
import { sampleJournalEntry } from '../shared/testing/sample.ts'
import { ApiProvider } from './api.tsx'
import { App } from './App.tsx'
import { FIXES_READY } from './fixes/feature.ts'
import { SHARE_READY } from './share/feature.ts'
import type { Route } from './nav.tsx'
import { fakeApi } from './testing/fake-api.ts'

const FOOTER = 'Your saves and households are never touched · A backup is made before any change'
const SIMS_FOLDER = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// A first run: welcome not seen, no folder chosen, one Sims folder found, nothing backed up or set aside yet.
function firstRunApi() {
  return fakeApi({
    'settings:get': { welcome: 'not-seen', folderPath: null },
    'settings:update': (req) => ({ welcome: 'not-seen', folderPath: null, ...req }),
    'locate:run': {
      folders: [{ path: SIMS_FOLDER, inOneDrive: false, newestFileAt: new Date('2026-11-23T00:00:00.000Z') }],
      game: null,
      gameRunning: 'not-running'
    },
    'game:check': 'not-running',
    'backup:status': { state: 'none' },
    'journal:list': [],
    'groups:disabled': [],
    'fifty:get': null,
    'assist:status': { key: 'not-set', offer: 'hide' }
  })
}

function renderApp(initialRoute?: Route) {
  return render(
    <ApiProvider value={firstRunApi()}>
      <App initialRoute={initialRoute} />
    </ApiProvider>
  )
}

describe('App shell', () => {
  it('opens a first run with the header, the safety footer, and nav items that follow FIXES_READY', async () => {
    renderApp()

    expect(await screen.findByText(FOOTER)).toBeInTheDocument()
    expect(screen.getByText(APP_TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check-up' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'Your mods' })).toHaveLength(FIXES_READY ? 1 : 0)
    expect(screen.queryAllByRole('button', { name: 'History' })).toHaveLength(FIXES_READY ? 1 : 0)
    expect(screen.queryAllByRole('button', { name: 'Share saves' })).toHaveLength(SHARE_READY ? 1 : 0)
  })

  it('opens key setup on Ctrl+Shift+K without throwing', async () => {
    renderApp({ screen: 'about' })

    const about = await screen.findByRole('button', { name: 'About' })
    await waitFor(() => expect(about).not.toBeDisabled())
    expect(about).toHaveAttribute('aria-current', 'page')

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })

    expect(screen.getByRole('button', { name: 'About' })).not.toHaveAttribute('aria-current')
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav.querySelector('[aria-current]')).toBeNull()
    expect(screen.getByText(FOOTER)).toBeInTheDocument()
  })

  it('opens each Share saves route, whose stubs render nothing yet, inside the shell', async () => {
    for (const screenName of ['share', 'share-setup', 'share-old-saves', 'share-settings'] as const) {
      renderApp({ screen: screenName })
      expect(await screen.findByText(FOOTER)).toBeInTheDocument()
      cleanup()
    }
  })

  it('renders immediately without waiting on recovery when mounted without ApiProvider', () => {
    render(<App initialRoute={{ screen: 'about' }} />)
    expect(screen.getByText(FOOTER)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About' })).not.toBeDisabled()
  })

  it('gates screens and nav while startup recovery runs, shows calm wait card after 250 ms with progress, and hands off cleanly', async () => {
    vi.useFakeTimers()

    let resolveRecovery!: (value: StartupRecovery) => void
    const putBack = sampleJournalEntry({
      id: 'e-put-back',
      summary: 'Set aside Hair',
      status: 'undone',
      undo: 'can-undo',
      undoneAt: '2026-11-24T12:20:00.000Z'
    })

    const api = fakeApi({
      'journal:recovery': () =>
        new Promise<StartupRecovery>((resolve) => {
          resolveRecovery = resolve
        }),
      'journal:list': [putBack],
      'settings:get': { welcome: 'not-seen', folderPath: null },
      'fifty:get': null
    })

    const { container } = render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>
    )

    // 0..249 ms quiet gate: header & footer shown, nav disabled, Ctrl+Shift+K ignored, Start/banners unmounted, no wait card yet
    expect(screen.getByText(APP_TITLE)).toBeInTheDocument()
    expect(screen.getByText(FOOTER)).toBeInTheDocument()
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toBeDisabled()
    }

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(api.calls.map((c) => c.channel)).toEqual(['journal:recovery'])
    expect(screen.queryByText(/Getting things ready/)).toBeNull()
    const liveRegion = screen.getByRole('status')
    expect(liveRegion).toHaveAttribute('aria-live', 'polite')
    expect(liveRegion).toBeEmptyDOMElement()
    expect(screen.queryByText('Checking your last session...')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(249)
    })
    expect(screen.getByRole('status')).toBe(liveRegion)
    expect(liveRegion).toBeEmptyDOMElement()
    expect(screen.queryByText('Checking your last session...')).toBeNull()

    // At 250 ms: calm status card populates the same live region with no em/en dashes
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    const statusCard = screen.getByRole('status')
    expect(statusCard).toBe(liveRegion)
    expect(statusCard).toHaveAttribute('aria-live', 'polite')
    expect(statusCard).not.toBeEmptyDOMElement()
    expect(screen.getByText('Checking your last session...')).toBeInTheDocument()
    expect(
      screen.getByText('Making sure your last change finished cleanly. Your saves and households are never touched.')
    ).toBeInTheDocument()
    expect(statusCard.textContent).not.toMatch(/[—–]/)

    // Progress updates from backup and fix events while recoveryPending
    act(() => {
      api.emitProgress({ task: 'backup', stage: 'copying', done: 3, total: 10 })
    })
    expect(screen.getByText('Making a safety copy first...')).toBeInTheDocument()
    expect(screen.getByText('Copying 3 of 10 files')).toBeInTheDocument()

    act(() => {
      api.emitProgress({ task: 'fix', stage: 'moving', done: 1, total: 2 })
    })
    expect(screen.getByText('Putting files back...')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 steps')).toBeInTheDocument()

    // Still gated before resolution
    expect(api.calls.map((c) => c.channel)).toEqual(['journal:recovery'])

    // Resolve recovery and verify clean handoff without a duplicate journal:recovery IPC call
    await act(async () => {
      resolveRecovery({ status: 'finished', touched: [putBack] })
    })

    expect(screen.queryByText('Checking your last session...')).toBeNull()
    expect(api.calls.filter((c) => c.channel === 'journal:recovery')).toHaveLength(1)
    expect(screen.getByText('A change was cut off, so we put things back as they were.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check-up' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'About' })).not.toBeDisabled()

    // Ctrl+Shift+K now works
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(container.textContent).not.toMatch(/Checking your last session/)
  })

  it('treats a rejected journal:recovery call as failed and mounts RecoveryNotice', async () => {
    const api = fakeApi({
      'journal:recovery': () => Promise.reject(new Error('boom')),
      'journal:list': [],
      'settings:get': { welcome: 'seen', folderPath: SIMS_FOLDER },
      'fifty:get': null
    })

    render(
      <ApiProvider value={api}>
        <App initialRoute={{ screen: 'about' }} />
      </ApiProvider>
    )

    expect(await screen.findByText('We could not check for a cut-off change')).toBeInTheDocument()
    expect(api.calls.filter((c) => c.channel === 'journal:recovery')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'About' })).not.toBeDisabled()
  })
})
