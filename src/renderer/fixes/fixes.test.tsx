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
      { why: 'backup', reason: 'game-running' },
      { why: 'backup', reason: 'game-state-unknown' },
      { why: 'backup', reason: 'backup-folder-in-onedrive' },
      { why: 'backup', reason: 'not-enough-space' },
      { why: 'backup', reason: 'sims-folder-missing' },
      { why: 'backup', reason: 'backup-already-running' },
      { why: 'backup', reason: 'backup-failed' },
      { why: 'out-of-date', detail: 'no-scan' },
      { why: 'out-of-date', detail: 'unknown-finding' },
      { why: 'out-of-date', detail: 'unknown-group' },
      { why: 'out-of-date', detail: 'file-changed' },
      { why: 'out-of-date', detail: 'nothing-to-do' },
      { why: 'fifty-fifty-running' }
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
    expect(await screen.findByText('Undone — put back the way it was.')).toBeInTheDocument()

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
  it('shows banner when an entry needs attention and opens History on click', async () => {
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

    expect(await screen.findByText('A previous change stopped partway through')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('route=history')
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
      'groups:disabled': [
        {
          groupId: 'cf:901234',
          label: 'Wicked Wardrobe',
          entryId: 'e-1',
          at: '2026-11-24T12:00:00.000Z'
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
