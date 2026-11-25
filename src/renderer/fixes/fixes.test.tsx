import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it } from 'vitest'
import type { FixOutcome, FixRefusal, JournalEntry, Scan } from '../../shared/model.ts'
import { sampleFinding, sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { Toaster } from '../components/ui/sonner.tsx'
import { NavProvider, useNav, type Route } from '../nav.tsx'
import { SessionProvider, useSession } from '../session.tsx'
import { fakeApi, type FakeApi } from '../testing/fake-api.ts'
import { FIXES_READY } from './feature.ts'
import { FindingActions } from './FindingActions.tsx'
import { HistoryScreen } from './HistoryScreen.tsx'
import { ModsScreen } from './ModsScreen.tsx'
import { RecoveryNotice } from './RecoveryNotice.tsx'
import { FIX_BUTTON_LABEL, refusalMessage } from './words.ts'

afterEach(() => {
  toast.dismiss()
  cleanup()
})

function Harness({
  api,
  initialRoute = { screen: 'check-up' },
  initialScan = null,
  children
}: {
  api: FakeApi
  initialRoute?: Route
  initialScan?: Scan | null
  children: ReactNode
}) {
  return (
    <ApiProvider value={api}>
      <SessionProvider initialScan={initialScan}>
        <NavProvider initial={initialRoute}>
          {children}
          <Toaster />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
}

function NavAndScanProbe() {
  const { route } = useNav()
  const { scan } = useSession()
  return (
    <div data-testid="probe">
      route={route.screen} scan={scan ? scan.id : 'null'}
    </div>
  )
}

describe('FIXES_READY and words', () => {
  it('enables FIXES_READY and uses gentle verbs only', () => {
    expect(FIXES_READY).toBe(true)
    expect(FIX_BUTTON_LABEL['turn-mods-on']).toBe('Turn mods back on')
    expect(FIX_BUTTON_LABEL['move-script-up']).toBe('Move it up a folder')
    expect(FIX_BUTTON_LABEL['set-aside-files']).toBe('Set aside')
    expect(FIX_BUTTON_LABEL['clear-caches']).toBe('Clear temporary cache')

    for (const label of Object.values(FIX_BUTTON_LABEL)) {
      expect(label.toLowerCase()).not.toContain('delete')
      expect(label.toLowerCase()).not.toContain('quarantine')
    }
  })

  it('provides plain-language copy for every FixRefusal variant', () => {
    const allRefusals: FixRefusal[] = [
      { why: 'gate', refusal: { reason: 'saves-or-tray', path: '/saves' } },
      { why: 'gate', refusal: { reason: 'outside-allowed-area', path: '/other' } },
      { why: 'gate', refusal: { reason: 'link-escape', path: '/link' } },
      { why: 'gate', refusal: { reason: 'not-a-sims-folder', path: '/bad' } },
      { why: 'gate', refusal: { reason: 'game-running' } },
      { why: 'gate', refusal: { reason: 'game-state-unknown' } },
      { why: 'gate', refusal: { reason: 'no-verified-backup', backup: 'stale' } },
      { why: 'gate', refusal: { reason: 'check-failed', path: '/sims/Mods' } },
      { why: 'backup', reason: 'game-running' },
      { why: 'backup', reason: 'game-state-unknown' },
      { why: 'backup', reason: 'backup-folder-in-onedrive' },
      { why: 'backup', reason: 'backup-folder-in-sims-folder' },
      { why: 'backup', reason: 'not-enough-space' },
      { why: 'backup', reason: 'sims-folder-missing' },
      { why: 'backup', reason: 'backup-already-running' },
      { why: 'backup', reason: 'backup-failed' },
      { why: 'out-of-date', detail: 'no-scan' },
      { why: 'out-of-date', detail: 'unknown-finding' },
      { why: 'out-of-date', detail: 'unknown-group' },
      { why: 'out-of-date', detail: 'file-changed' },
      { why: 'out-of-date', detail: 'nothing-to-do' },
      { why: 'fifty-fifty-running' },
      { why: 'not-started' }
    ]

    for (const refusal of allRefusals) {
      const msg = refusalMessage(refusal)
      expect(msg.title.length).toBeGreaterThan(3)
      expect(msg.detail.length).toBeGreaterThan(10)
      expect(msg.detail.toLowerCase()).not.toContain('delete')
      expect(msg.detail.toLowerCase()).not.toContain('quarantine')
    }

    expect(refusalMessage({ why: 'gate', refusal: { reason: 'game-running' } })).toMatchObject({
      detail: 'The Sims 4 is still open. Save and close the game, then try again.',
      canRetry: true
    })
    expect(refusalMessage({ why: 'gate', refusal: { reason: 'game-state-unknown' } })).toMatchObject({
      canRetry: true
    })
    expect(refusalMessage({ why: 'gate', refusal: { reason: 'game-state-unknown' } }).detail).toContain(
      'nothing was changed'
    )
    expect(refusalMessage({ why: 'gate', refusal: { reason: 'check-failed', path: '/sims/Mods' } })).toMatchObject({
      canRetry: true
    })
    expect(refusalMessage({ why: 'fifty-fifty-running' })).toMatchObject({ canRetry: true })
    // Also said after a half-done set-aside was put back, so it promises only what holds then too.
    expect(refusalMessage({ why: 'not-started' })).toMatchObject({ canRetry: true })
    expect(refusalMessage({ why: 'not-started' }).detail).toContain('just as they were')
    expect(
      refusalMessage({ why: 'gate', refusal: { reason: 'saves-or-tray', path: '/saves' } }).detail
    ).toBe('Your saves and households are never touched, so nothing was changed.')
  })
})

describe('FindingActions', () => {
  it('renders each fix button label and returns nothing when a finding has no fixes', () => {
    const api = fakeApi()
    const cases = [
      { fix: { fix: 'turn-mods-on' as const }, label: 'Turn mods back on' },
      { fix: { fix: 'move-script-up' as const, files: ['A/B/x.ts4script'] }, label: 'Move it up a folder' },
      { fix: { fix: 'set-aside-files' as const, files: ['a.zip'] }, label: 'Set aside' },
      { fix: { fix: 'clear-caches' as const }, label: 'Clear temporary cache' }
    ]

    for (const c of cases) {
      const { unmount } = render(
        <Harness api={api}>
          <FindingActions finding={sampleFinding({ fixes: [c.fix] })} />
        </Harness>
      )
      expect(screen.getByRole('button', { name: c.label })).toBeInTheDocument()
      unmount()
    }

    const { container } = render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding({ fixes: [] })} />
      </Harness>
    )
    expect(container.querySelector('button')).toBeNull()
  })

  it('shows backup progress, then done state with Check again and toast Undo', async () => {
    const user = userEvent.setup()
    let resolveFix!: (outcome: FixOutcome) => void
    const entry = sampleJournalEntry({
      id: 'entry-fix-1',
      action: 'turn-mods-on',
      summary: 'Turned mods and script mods back on',
      undo: 'can-undo'
    })

    const api = fakeApi({
      'fix:apply': () =>
        new Promise<FixOutcome>((resolve) => {
          resolveFix = resolve
        }),
      'journal:undo': () => ({
        status: 'done',
        entry: { ...entry, status: 'undone', undoneAt: '2026-11-24T12:12:00.000Z' }
      })
    })

    const scan = sampleScan()
    render(
      <Harness api={api} initialScan={scan} initialRoute={{ screen: 'about' }}>
        <FindingActions finding={sampleFinding()} />
        <NavAndScanProbe />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    expect(screen.getByText('Making a safety copy first…')).toBeInTheDocument()

    act(() => {
      api.emitProgress({ task: 'backup', stage: 'copying', done: 45, total: 100 })
    })
    expect(screen.getByText('Copying 45 of 100 files')).toBeInTheDocument()

    act(() => {
      resolveFix({ status: 'done', entry })
    })

    expect((await screen.findAllByText('Turned mods and script mods back on')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()

    // Both inline card and Sonner toast show Undo; click the toast Undo button
    const undoButtons = await screen.findAllByRole('button', { name: 'Undo' })
    expect(undoButtons.length).toBeGreaterThanOrEqual(2)
    await user.click(undoButtons[undoButtons.length - 1]!)
    await waitFor(() => {
      expect(api.calls.some((c) => c.channel === 'journal:undo')).toBe(true)
    })
    expect(await screen.findByText('Undone. Put back the way it was.')).toBeInTheDocument()

    // Check again clears scan and navigates to check-up
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('route=check-up scan=null')
  })

  it('shows plain refusal text and Try again for game-running', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const api = fakeApi({
      'fix:apply': () => {
        attempt += 1
        if (attempt === 1) {
          return { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
        }
        return {
          status: 'done',
          entry: sampleJournalEntry({ summary: 'Turned mods and script mods back on' })
        }
      }
    })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    expect(
      await screen.findByText('The Sims 4 is still open. Save and close the game, then try again.')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect((await screen.findAllByText('Turned mods and script mods back on')).length).toBeGreaterThanOrEqual(1)
    expect(attempt).toBe(2)
  })
})

describe('RecoveryNotice', () => {
  it('says calmly that a cut-off change could not be finished, and opens History when it has an undo', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'journal:list': [
        sampleJournalEntry({
          id: 'e-interrupted',
          status: 'needs-attention',
          summary: 'Set aside Hair'
        })
      ]
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
        <NavAndScanProbe />
      </Harness>
    )

    expect(await screen.findByText('A change was cut off before it finished')).toBeInTheDocument()
    expect(screen.getByText(/Your saves and households were never touched/)).toBeInTheDocument()
    expect(screen.getByText(/Open History and press Undo/)).toBeInTheDocument()
    expect(screen.queryByText(/Tray/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('route=history')
  })

  it('offers no History or undo when the cut-off change was a cache clear, which has no undo', async () => {
    const api = fakeApi({
      'journal:list': [
        sampleJournalEntry({
          id: 'e-cache',
          action: 'clear-caches',
          summary: 'Cleared 2 temporary cache items',
          steps: [{ kind: 'remove-cache', path: '/sims/localthumbcache.package', state: 'pending' }],
          status: 'needs-attention',
          undo: 'cannot-undo'
        })
      ]
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('A change was cut off before it finished')).toBeInTheDocument()
    expect(screen.getByText(/temporary cache files/)).toBeInTheDocument()
    expect(screen.getByText(/Your saves and households were never touched/)).toBeInTheDocument()
    expect(screen.getByText(/nothing more to do/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open History' })).toBeNull()
    expect(screen.queryByText(/undo/i)).toBeNull()
    expect(screen.queryByText(/Tray/)).toBeNull()
  })

  it('says a cut-off change was put back as it was, with no undo, since it is already undone', async () => {
    const putBack = sampleJournalEntry({
      id: 'e-put-back',
      summary: 'Set aside Hair',
      status: 'undone',
      undo: 'can-undo',
      undoneAt: '2026-11-24T12:20:00.000Z'
    })
    const api = fakeApi({
      'journal:recovery': { status: 'finished', touched: [putBack] },
      'journal:list': [putBack]
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('A change was cut off, so we put things back as they were.')).toBeInTheDocument()
    expect(screen.getByText(/Your saves and households were never touched/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open History' })).toBeNull()
    expect(screen.queryByText(/undo/i)).toBeNull()
    expect(screen.queryByText(/Tray/)).toBeNull()
  })

  it('still says a change was put back when reading the journal fails', async () => {
    const putBack = sampleJournalEntry({ id: 'e-put-back', status: 'undone', undoneAt: '2026-11-24T12:20:00.000Z' })
    const api = fakeApi({
      'journal:recovery': { status: 'finished', touched: [putBack] },
      'journal:list': () => Promise.reject(new Error('not implemented: listJournal'))
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('A change was cut off, so we put things back as they were.')).toBeInTheDocument()
  })

  it('says plainly when the start-up recovery failed, with no paths or error text', async () => {
    const api = fakeApi({
      'journal:recovery': { status: 'failed' },
      'journal:list': []
    })

    const { container } = render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('We could not check for a cut-off change')).toBeInTheDocument()
    expect(screen.getByText(/Your saves and households were never touched/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open History' })).toBeNull()
    expect(container.textContent).not.toMatch(/[A-Z]:\\|\/|error|Tray/i)
  })

  it('after a failed recovery, offers History only for a left-over change that can be undone', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'journal:recovery': { status: 'failed' },
      'journal:list': [sampleJournalEntry({ id: 'e-left', status: 'in-progress', undo: 'can-undo' })]
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
        <NavAndScanProbe />
      </Harness>
    )

    expect(await screen.findByText('We could not check for a cut-off change')).toBeInTheDocument()
    expect(screen.getByText(/Open History and press Undo/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('route=history')
  })

  it('shows the recovery failure notice when journal:recovery rejects, never silent all-good, with no error text', async () => {
    const api = fakeApi({
      'journal:recovery': () => Promise.reject(new Error('C:\\Users\\Lila\\AppData\\journal locked')),
      'journal:list': []
    })

    const { container } = render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('We could not check for a cut-off change')).toBeInTheDocument()
    expect(screen.getByText(/Your saves and households were never touched/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open History' })).toBeNull()
    expect(container.textContent).not.toMatch(/Lila|[A-Z]:\\|error|Tray/i)
  })

  it('keeps needs-attention entries from recovery.touched when journal:list fails, never showing an all-good put-back notice', async () => {
    const putBack = sampleJournalEntry({
      id: 'e-put-back',
      status: 'undone',
      undo: 'can-undo',
      undoneAt: '2026-11-24T12:20:00.000Z'
    })
    const stuck = sampleJournalEntry({
      id: 'e-stuck',
      status: 'needs-attention',
      undo: 'can-undo'
    })
    const api = fakeApi({
      'journal:recovery': { status: 'finished', touched: [putBack, stuck] },
      'journal:list': () => Promise.reject(new Error('journal unreadable'))
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('A change was cut off before it finished')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open History' })).toBeInTheDocument()
    expect(screen.queryByText(/we put things back as they were/i)).toBeNull()
    expect(screen.queryByText(/nothing more to do/i)).toBeNull()
  })

  it('does not call a non-cache cannot-undo entry a temporary cache clear, and still offers no Undo', async () => {
    const api = fakeApi({
      'journal:list': [
        sampleJournalEntry({
          id: 'e-non-cache',
          action: 'share-receive',
          summary: 'Got shared save',
          status: 'needs-attention',
          undo: 'cannot-undo'
        })
      ]
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    expect(await screen.findByText('A change was cut off before it finished')).toBeInTheDocument()
    expect(screen.getByText(/We could not put everything back on our own/)).toBeInTheDocument()
    expect(screen.queryByText(/temporary cache/i)).toBeNull()
    expect(screen.queryByText(/nothing more to do/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open History' })).toBeNull()
    expect(screen.queryByText(/undo/i)).toBeNull()
  })

  it('waits for a late journal:list before saying all is well, then warns about a change it lists as cut off', async () => {
    const putBack = sampleJournalEntry({ id: 'e-put-back', status: 'undone', undoneAt: '2026-11-24T12:20:00.000Z' })
    const stuck = sampleJournalEntry({ id: 'e-stuck', status: 'needs-attention', undo: 'can-undo' })
    let answerList: (entries: JournalEntry[]) => void = () => {}
    const api = fakeApi({
      'journal:recovery': { status: 'finished', touched: [putBack] },
      'journal:list': () => new Promise<JournalEntry[]>((resolve) => (answerList = resolve))
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    await waitFor(() => expect(api.calls.map((call) => call.channel)).toContain('journal:list'))
    await act(async () => {})
    expect(screen.queryByText(/we put things back as they were/i)).toBeNull()
    expect(screen.queryByText(/nothing more to do/i)).toBeNull()

    await act(async () => answerList([putBack, stuck]))

    expect(await screen.findByText('A change was cut off before it finished')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open History' })).toBeInTheDocument()
    expect(screen.queryByText(/nothing more to do/i)).toBeNull()
  })

  it('shows the put-back notice once a late journal:list comes back empty', async () => {
    const putBack = sampleJournalEntry({ id: 'e-put-back', status: 'undone', undoneAt: '2026-11-24T12:20:00.000Z' })
    let answerList: (entries: JournalEntry[]) => void = () => {}
    const api = fakeApi({
      'journal:recovery': { status: 'finished', touched: [putBack] },
      'journal:list': () => new Promise<JournalEntry[]>((resolve) => (answerList = resolve))
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'about' }}>
        <RecoveryNotice />
      </Harness>
    )

    await waitFor(() => expect(api.calls.map((call) => call.channel)).toContain('journal:list'))
    await act(async () => answerList([]))

    expect(await screen.findByText('A change was cut off, so we put things back as they were.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open History' })).toBeNull()
  })

  it('renders nothing when mounted without ApiProvider', () => {
    const { container } = render(
      <NavProvider initial={{ screen: 'about' }}>
        <RecoveryNotice />
      </NavProvider>
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('HistoryScreen', () => {
  it('lists entries newest first, handles Undo -> Undone, cache clear cannot-undo, and folds 50/50 rows', async () => {
    const user = userEvent.setup()
    const zipEntry = sampleJournalEntry({
      id: 'e-zip',
      at: '2026-11-24T12:20:00.000Z',
      action: 'set-aside-files',
      summary: 'Set aside 3 zip files from Mods',
      status: 'done',
      undo: 'can-undo'
    })
    const cacheEntry = sampleJournalEntry({
      id: 'e-cache',
      at: '2026-11-24T12:15:00.000Z',
      action: 'clear-caches',
      summary: 'Cleared 2 temporary cache items',
      steps: [{ kind: 'remove-cache', path: '/sims/localthumbcache.package', state: 'applied' }],
      status: 'done',
      undo: 'cannot-undo'
    })
    const ff1 = sampleJournalEntry({
      id: 'e-ff-1',
      at: '2026-11-24T12:10:00.000Z',
      action: 'disable-group',
      summary: 'Set aside Mod A',
      origin: { by: 'fifty-fifty', sessionId: 'session-9', round: 1 },
      groupId: 'dir:a',
      status: 'undone',
      undoneAt: '2026-11-24T12:12:00.000Z'
    })
    const ff2 = sampleJournalEntry({
      id: 'e-ff-2',
      at: '2026-11-24T12:11:00.000Z',
      action: 'disable-group',
      summary: 'Set aside Mod B',
      origin: { by: 'fifty-fifty', sessionId: 'session-9', round: 2 },
      groupId: 'dir:b',
      status: 'undone',
      undoneAt: '2026-11-24T12:12:00.000Z'
    })

    const entries: JournalEntry[] = [cacheEntry, ff1, zipEntry, ff2]

    const api = fakeApi({
      'journal:list': entries,
      'journal:undo': ({ entryId }) => ({
        status: 'done',
        entry: { ...zipEntry, id: entryId, status: 'undone', undoneAt: '2026-11-24T12:25:00.000Z' }
      })
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'history' }}>
        <HistoryScreen />
      </Harness>
    )

    expect(await screen.findByText('Set aside 3 zip files from Mods')).toBeInTheDocument()
    expect(screen.getByText("Can't be undone")).toBeInTheDocument()
    expect(screen.getByText('50/50 test')).toBeInTheDocument()
    expect(screen.getByText('2 rounds · 2 changes')).toBeInTheDocument()

    // Individual 50/50 entries are folded until expanded
    expect(screen.queryByText('Set aside Mod A')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('Set aside Mod A')).toBeInTheDocument()
    expect(screen.getByText('Set aside Mod B')).toBeInTheDocument()

    // Undo the zip entry -> becomes quiet Undone badge
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    })
    expect(screen.getAllByText('Undone').length).toBeGreaterThanOrEqual(1)
  })
})

describe('ModsScreen', () => {
  it('shows scan groups, script mod badge, search filtering, and toggles a mod off and back on', async () => {
    const user = userEvent.setup()
    const scan = sampleScan()
    const api = fakeApi({
      'journal:list': [],
      'groups:disabled': [],
      'fix:apply': () => ({
        status: 'done',
        entry: sampleJournalEntry({
          id: 'disable-hair-1',
          action: 'disable-group',
          summary: 'Set aside Hair',
          groupId: 'dir:hair',
          status: 'done'
        })
      }),
      'journal:undo': ({ entryId }) => ({
        status: 'done',
        entry: sampleJournalEntry({
          id: entryId,
          action: 'disable-group',
          summary: 'Set aside Hair',
          groupId: 'dir:hair',
          status: 'undone',
          undoneAt: '2026-11-24T12:30:00.000Z'
        })
      })
    })

    render(
      <Harness api={api} initialScan={scan} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.getByText('Hair')).toBeInTheDocument()
    expect(screen.getByText('Script mod')).toBeInTheDocument()

    // Toggle Hair off
    const hairSwitch = screen.getByRole('switch', { name: 'Set Hair aside' })
    expect(hairSwitch).toHaveAttribute('aria-checked', 'true')
    await user.click(hairSwitch)

    const turnBackOn = await screen.findByRole('switch', { name: 'Turn Hair back on' })
    expect(turnBackOn).toHaveAttribute('aria-checked', 'false')

    // Toggle Hair back on
    await user.click(turnBackOn)
    expect(await screen.findByRole('switch', { name: 'Set Hair aside' })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    // Search filters list
    await user.type(screen.getByRole('searchbox', { name: 'Search your mods' }), 'wicked')
    expect(screen.getByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.queryByText('Hair')).not.toBeInTheDocument()
  })

  it('prompts to run a check-up when no scan exists yet while still listing disabled mods', async () => {
    const api = fakeApi({
      'journal:list': [],
      'groups:disabled': [
        {
          groupId: 'cf:901234',
          label: 'Wicked Wardrobe',
          entryId: 'e-1',
          at: '2026-11-24T12:00:00.000Z',
          origin: 'fix'
        }
      ]
    })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText('Run a check-up to see all your mods')).toBeInTheDocument()
    expect(screen.getByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Turn Wicked Wardrobe back on' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })
})

describe('review: retries, failures and focus', () => {
  const doneEntry = sampleJournalEntry({
    id: 'entry-fix-9',
    action: 'turn-mods-on',
    summary: 'Turned mods and script mods back on',
    status: 'done',
    undo: 'can-undo'
  })

  it('Try again after a refused Undo retries the Undo, not the fix', async () => {
    const user = userEvent.setup()
    let undoAttempt = 0
    const api = fakeApi({
      'fix:apply': { status: 'done', entry: doneEntry },
      'journal:undo': () => {
        undoAttempt += 1
        if (undoAttempt === 1) {
          return { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
        }
        return { status: 'done', entry: { ...doneEntry, status: 'undone', undoneAt: '2026-11-24T12:40:00.000Z' } }
      }
    })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    const undoButtons = await screen.findAllByRole('button', { name: 'Undo' })
    await user.click(undoButtons[0]!)
    await user.click(await screen.findByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(undoAttempt).toBe(2))
    expect(api.calls.filter((c) => c.channel === 'fix:apply')).toHaveLength(1)
  })

  it('a fix that fails with an error shows a calm message and Try again instead of a stuck progress bar', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const api = fakeApi({
      'fix:apply': () => {
        attempt += 1
        if (attempt === 1) throw new Error('journal entry could not be written')
        return { status: 'done', entry: doneEntry }
      }
    })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('Making a safety copy first…')).not.toBeInTheDocument()
    expect(screen.queryByText(/journal entry could not be written/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect((await screen.findAllByText('Turned mods and script mods back on')).length).toBeGreaterThanOrEqual(1)
  })

  it('keeps keyboard focus on the card after the clicked button goes away', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ 'fix:apply': { status: 'done', entry: doneEntry } })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByRole('status')).toHaveTextContent('Turned mods and script mods back on')
  })

  it('History shows a calm message and Try again when an undo fails with an error', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const api = fakeApi({
      'journal:list': [doneEntry],
      'journal:undo': () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return { status: 'done', entry: { ...doneEntry, status: 'undone', undoneAt: '2026-11-24T12:40:00.000Z' } }
      }
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'history' }}>
        <HistoryScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument())
    expect(attempt).toBe(2)
  })

  it('Your mods shows a calm message and Try again when a switch fails with an error', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const api = fakeApi({
      'journal:list': [],
      'groups:disabled': [],
      'fix:apply': () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return {
          status: 'done',
          entry: sampleJournalEntry({ id: 'd-1', action: 'disable-group', groupId: 'dir:hair', status: 'done' })
        }
      }
    })

    render(
      <Harness api={api} initialScan={sampleScan()} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('switch', { name: 'Set Hair aside' }))
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('switch', { name: 'Turn Hair back on' })).toBeInTheDocument()
  })
})

describe('review: History keeps focus', () => {
  it('moves keyboard focus to the row when its Undo button turns into the Undone label', async () => {
    const user = userEvent.setup()
    const entry = sampleJournalEntry({ id: 'e-h1', summary: 'Set aside 3 zip files from Mods', status: 'done', undo: 'can-undo' })
    const api = fakeApi({
      'journal:list': [entry],
      'journal:undo': { status: 'done', entry: { ...entry, status: 'undone', undoneAt: '2026-11-24T12:40:00.000Z' } }
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'history' }}>
        <HistoryScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument())
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toHaveTextContent('Set aside 3 zip files from Mods')
  })
})

describe('last check: a list that fails to load does not look empty', () => {
  it('History says it could not load, never "No changes yet", and Try again loads it', async () => {
    const user = userEvent.setup()
    const entry = sampleJournalEntry({ id: 'e-load-1', summary: 'Set aside 2 broken files from Mods' })
    let attempt = 0
    const api = fakeApi({
      'journal:list': () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return [entry]
      }
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'history' }}>
        <HistoryScreen />
      </Harness>
    )

    expect(await screen.findByText("Couldn't load this right now")).toBeInTheDocument()
    expect(screen.queryByText('No changes yet')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Set aside 2 broken files from Mods')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load this right now")).not.toBeInTheDocument()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('Your mods says it could not load, never "No mods are currently set aside", and Try again loads it', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const api = fakeApi({
      'journal:list': [],
      'groups:disabled': () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return [{ groupId: 'cf:901234', label: 'Wicked Wardrobe', entryId: 'e-1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' }]
      }
    })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText("Couldn't load this right now")).toBeInTheDocument()
    expect(screen.queryByText('No mods are currently set aside.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('switch', { name: 'Turn Wicked Wardrobe back on' })).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load this right now")).not.toBeInTheDocument()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('Your mods keeps the check-up list on screen under the notice', async () => {
    const api = fakeApi({
      'journal:list': [],
      'groups:disabled': () => {
        throw new Error('boom')
      }
    })

    render(
      <Harness api={api} initialScan={sampleScan()} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText("Couldn't load this right now")).toBeInTheDocument()
    expect(screen.getByText('Hair')).toBeInTheDocument()
  })
})

describe('last check: a mod whose put-back needs attention stays on Your mods', () => {
  const stuck = sampleJournalEntry({
    id: 'e-stuck',
    action: 'disable-group',
    summary: 'Set aside Wicked Wardrobe',
    groupId: 'cf:901234',
    groupLabel: 'Wicked Wardrobe',
    hasScript: true,
    status: 'needs-attention'
  })

  it('lists it on first load, marked, with a link to History in place of the switch', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ 'groups:disabled': [], 'journal:list': [stuck] })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
        <NavAndScanProbe />
      </Harness>
    )

    expect(await screen.findByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('No mods are currently set aside.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open History for Wicked Wardrobe' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('route=history')
  })

  it('keeps the row when turning it back on stops partway, and does not offer the switch again', async () => {
    const user = userEvent.setup()
    let undone = false
    const api = fakeApi({
      'groups:disabled': () =>
        undone ? [] : [{ groupId: 'cf:901234', label: 'Wicked Wardrobe', entryId: 'e-stuck', at: stuck.at, origin: 'fix' as const }],
      'journal:list': () => (undone ? [stuck] : [{ ...stuck, status: 'done' as const }]),
      'journal:undo': () => {
        undone = true
        return { status: 'stopped-part-way', entry: stuck, detail: '' }
      }
    })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('switch', { name: 'Turn Wicked Wardrobe back on' }))
    expect(await screen.findByRole('button', { name: 'Open History for Wicked Wardrobe' })).toBeInTheDocument()
    expect(screen.getByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('a mod still in the check-up list gets the History link too, so it cannot be set aside twice', async () => {
    const scan = sampleScan()
    const group = scan.inventory.groups.find((g) => g.label === 'Hair')!
    const api = fakeApi({
      'groups:disabled': [],
      'journal:list': [
        { ...stuck, id: 'e-hair', groupId: group.id, groupLabel: 'Hair', summary: 'Set aside Hair', folderPath: scan.folder.path },
        { ...stuck, id: 'e-other', groupId: 'dir:elsewhere', groupLabel: 'Elsewhere', summary: 'Set aside Elsewhere', folderPath: 'D:\\Other\\The Sims 4' }
      ]
    })

    render(
      <Harness api={api} initialScan={scan} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByRole('button', { name: 'Open History for Hair' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Set Hair aside' })).not.toBeInTheDocument()
    // An entry from another Sims folder is not part of this list.
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument()
  })
})

describe('last check: Your mods keeps focus after Try again', () => {
  it('moves keyboard focus back to the switch when the notice goes away', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const api = fakeApi({
      'groups:disabled': [],
      'journal:list': [],
      'fix:apply': () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return {
          status: 'done',
          entry: sampleJournalEntry({ id: 'd-1', action: 'disable-group', groupId: 'dir:hair', status: 'done' })
        }
      }
    })

    render(
      <Harness api={api} initialScan={sampleScan()} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('switch', { name: 'Set Hair aside' }))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    const sw = await screen.findByRole('switch', { name: 'Turn Hair back on' })
    await waitFor(() => expect(document.activeElement).toBe(sw))
  })
})

describe('last check: Your mods keeps the list that did load', () => {
  it('still lists the mods set aside when only the History half of the load fails', async () => {
    const api = fakeApi({
      'groups:disabled': [
        { groupId: 'cf:901234', label: 'Wicked Wardrobe', entryId: 'e-1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' }
      ],
      'journal:list': () => {
        throw new Error('boom')
      }
    })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText("Couldn't load this right now")).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Turn Wicked Wardrobe back on' })).toBeInTheDocument()
  })
})

describe('contract round 3 on Your mods', () => {
  it('a stuck row takes its name and script mark from the entry, never from the summary', async () => {
    const api = fakeApi({
      'groups:disabled': [],
      'journal:list': [
        sampleJournalEntry({
          id: 'e-stuck',
          action: 'disable-group',
          summary: 'Some other words',
          groupId: 'cf:901234',
          groupLabel: 'Wicked Wardrobe',
          hasScript: true,
          status: 'needs-attention'
        })
      ]
    })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.getByText('Script mod')).toBeInTheDocument()
    expect(screen.queryByText('Some other words')).not.toBeInTheDocument()
  })

  it('a set-aside mod that is not in the check-up keeps its script mark from its journal entry', async () => {
    const api = fakeApi({
      'groups:disabled': [
        { groupId: 'cf:901234', label: 'Wicked Wardrobe', entryId: 'e-1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' }
      ],
      'journal:list': [
        sampleJournalEntry({
          id: 'e-1',
          action: 'disable-group',
          groupId: 'cf:901234',
          groupLabel: 'Wicked Wardrobe',
          hasScript: true,
          status: 'done'
        })
      ]
    })

    render(
      <Harness api={api} initialScan={null} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByRole('switch', { name: 'Turn Wicked Wardrobe back on' })).toBeInTheDocument()
    expect(screen.getByText('Script mod')).toBeInTheDocument()
  })

  it('a set-aside that was put back after stopping part way says nothing was set aside', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'groups:disabled': [],
      'journal:list': [],
      'fix:apply': () => ({ status: 'refused', refusal: { why: 'not-started' } })
    })

    render(
      <Harness api={api} initialScan={sampleScan()} initialRoute={{ screen: 'mods' }}>
        <ModsScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('switch', { name: 'Set Hair aside' }))
    expect(await screen.findByText('Hair was not set aside')).toBeInTheDocument()
    expect(screen.getByText(/just as they were/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Set Hair aside' })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('undo of an entry that never ran (nothing-to-do)', () => {
  it('History drops the row with no error and no toast when Undo answers nothing-to-do', async () => {
    const user = userEvent.setup()
    const neverRan = sampleJournalEntry({
      id: 'e-never-ran',
      at: '2026-11-24T12:25:00.000Z',
      action: 'disable-group',
      summary: 'Set aside Hair',
      groupId: 'dir:hair',
      groupLabel: 'Hair',
      status: 'in-progress',
      undo: 'can-undo',
      steps: sampleJournalEntry().steps.map((s) => ({ ...s, state: 'pending' as const }))
    })
    const kept = sampleJournalEntry({
      id: 'e-kept',
      at: '2026-11-24T12:20:00.000Z',
      action: 'turn-mods-on',
      summary: 'Turned mods and script mods back on',
      status: 'done',
      undo: 'can-undo'
    })
    const api = fakeApi({
      'journal:list': [neverRan, kept],
      'journal:undo': () => ({
        status: 'refused',
        refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
      })
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'history' }}>
        <HistoryScreen />
      </Harness>
    )

    expect(await screen.findByText('Set aside Hair')).toBeInTheDocument()
    expect(screen.getByText('Turned mods and script mods back on')).toBeInTheDocument()

    const undoButtons = screen.getAllByRole('button', { name: 'Undo' })
    await user.click(undoButtons[0]!)

    await waitFor(() => {
      expect(screen.queryByText('Set aside Hair')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Turned mods and script mods back on')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Already taken care of')).not.toBeInTheDocument()
    expect(document.querySelector('[data-sonner-toast]')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('FindingActions returns to its fix button with no error and no toast when Undo answers nothing-to-do', async () => {
    const user = userEvent.setup()
    const stoppedEntry = sampleJournalEntry({
      id: 'e-never-ran',
      action: 'turn-mods-on',
      summary: 'Turned mods and script mods back on',
      status: 'needs-attention',
      undo: 'can-undo',
      steps: sampleJournalEntry().steps.map((s) => ({ ...s, state: 'pending' as const }))
    })
    const api = fakeApi({
      'fix:apply': () => ({
        status: 'stopped-part-way',
        entry: stoppedEntry,
        detail: 'This change stopped part way through. You can undo what already moved from History.'
      }),
      'journal:undo': () => ({
        status: 'refused',
        refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
      })
    })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    const undoButton = await screen.findByRole('button', { name: 'Undo' })

    await user.click(undoButton)

    expect(await screen.findByRole('button', { name: 'Turn mods back on' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Already taken care of')).not.toBeInTheDocument()
    expect(document.querySelector('[data-sonner-toast]')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
  })
})

describe('FindingActions resets quietly on nothing-to-do only for a stopped fix that never ran', () => {
  const nothingToDo: FixOutcome = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
  const doneEntry = sampleJournalEntry({
    id: 'e-done',
    action: 'turn-mods-on',
    summary: 'Turned mods and script mods back on',
    status: 'done',
    undo: 'can-undo'
  })

  it('from a done card, says it was already taken care of instead of offering the fix again', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ 'fix:apply': { status: 'done', entry: doneEntry }, 'journal:undo': () => nothingToDo })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    await user.click((await screen.findAllByRole('button', { name: 'Undo' }))[0]!)

    expect(await screen.findByText('Already taken care of')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn mods back on' })).not.toBeInTheDocument()
  })

  it('from the toast after she left the screen, says it was already taken care of in a toast', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ 'fix:apply': { status: 'done', entry: doneEntry }, 'journal:undo': () => nothingToDo })

    const { rerender } = render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )
    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    await screen.findByRole('button', { name: 'Check again' })
    rerender(<Harness api={api}>{null}</Harness>)

    await user.click(await screen.findByRole('button', { name: 'Undo' }))

    expect(await screen.findByText('Already taken care of')).toBeInTheDocument()
  })

  it('from a stopped card where a step already ran, says it was already taken care of', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'fix:apply': () => ({
        status: 'stopped-part-way',
        entry: { ...doneEntry, status: 'needs-attention' },
        detail: 'This change stopped part way through. You can undo what already moved from History.'
      }),
      'journal:undo': () => nothingToDo
    })

    render(
      <Harness api={api}>
        <FindingActions finding={sampleFinding()} />
      </Harness>
    )

    await user.click(screen.getByRole('button', { name: 'Turn mods back on' }))
    await user.click(await screen.findByRole('button', { name: 'Undo' }))

    expect(await screen.findByText('Already taken care of')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn mods back on' })).not.toBeInTheDocument()
  })
})

describe('History drops a row quietly on nothing-to-do only for an in-progress entry that never ran', () => {
  const nothingToDo: FixOutcome = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }

  it.each([
    [
      'done entry',
      sampleJournalEntry({
        id: 'e-done',
        summary: 'Set aside Hair',
        status: 'done',
        undo: 'can-undo'
      })
    ],
    [
      'needs-attention entry with an applied step',
      sampleJournalEntry({
        id: 'e-needs-applied',
        summary: 'Set aside Hair',
        status: 'needs-attention',
        undo: 'can-undo'
      })
    ],
    [
      'needs-attention entry with pending steps',
      sampleJournalEntry({
        id: 'e-needs-pending',
        summary: 'Set aside Hair',
        status: 'needs-attention',
        undo: 'can-undo',
        steps: sampleJournalEntry().steps.map((s) => ({ ...s, state: 'pending' as const }))
      })
    ],
    [
      'in-progress entry where a step already ran',
      sampleJournalEntry({
        id: 'e-in-progress-applied',
        summary: 'Set aside Hair',
        status: 'in-progress',
        undo: 'can-undo'
      })
    ]
  ])('for a %s, keeps the row and says it was already taken care of', async (_label, entry) => {
    const user = userEvent.setup()
    const api = fakeApi({
      'journal:list': [entry],
      'journal:undo': () => nothingToDo
    })

    render(
      <Harness api={api} initialRoute={{ screen: 'history' }}>
        <HistoryScreen />
      </Harness>
    )

    expect(await screen.findByText('Set aside Hair')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))

    expect(await screen.findByText('Already taken care of')).toBeInTheDocument()
    expect(screen.getByText('Set aside Hair')).toBeInTheDocument()
  })
})
