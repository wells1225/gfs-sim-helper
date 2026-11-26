import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { Scan, ScanResult } from '../../shared/model.ts'
import { sampleFinding, sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi } from '../testing/fake-api.ts'
import { CheckUp } from './CheckUp.tsx'

afterEach(() => {
  cleanup()
})

function Harness() {
  const { route } = useNav()
  return (
    <div>
      <CheckUp />
      <output data-testid="route">{route.screen}</output>
    </div>
  )
}

function renderCheckUp(options: { scan: Scan | null; answers?: Parameters<typeof fakeApi>[0] }) {
  const api = fakeApi(options.answers ?? {})
  render(
    <ApiProvider value={api}>
      <SessionProvider initialScan={options.scan} initialSymptom="closes">
        <NavProvider initial={{ screen: 'check-up' }}>
          <Harness />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
  return api
}

describe('CheckUp', () => {
  it('scans when session.scan is null and shows two-phase progress', async () => {
    let resolveScan!: (res: ScanResult) => void
    const scanPromise = new Promise<ScanResult>((resolve) => {
      resolveScan = resolve
    })

    const scan = sampleScan()
    const api = renderCheckUp({
      scan: null,
      answers: {
        'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
        'scan:run': () => scanPromise
      }
    })

    expect(await screen.findByText('Counting files…')).toBeInTheDocument()

    act(() => {
      api.emitProgress({ task: 'scan', stage: 'mods', done: 1420, total: 5300 })
    })

    expect(screen.getByText('Checking mod 1,420 of 5,300')).toBeInTheDocument()
    // Screen readers hear the stage, not every file count
    const stageStatus = screen.getByText('Checking your mods', { selector: 'p[role="status"]' })
    expect(stageStatus).not.toHaveTextContent('1,420')
    expect(document.body.textContent).not.toContain('—')

    act(() => {
      resolveScan({ status: 'done', scan })
    })

    expect(await screen.findByText('Mods are turned off after an update')).toBeInTheDocument()
  })

  it('groups findings by severity order, renders certainty badges, files, closed technical details, and game-running note', async () => {
    const user = userEvent.setup()
    const scan = sampleScan({
      gameRunning: 'running',
      findings: [
        sampleFinding({
          id: 'stale-thumbnail-cache',
          rule: 'stale-thumbnail-cache',
          severity: 'info',
          certainty: 'worth-testing',
          title: 'The thumbnail cache is older than your latest mod change',
          detail: 'Clearing the cache helps the game show your current mods cleanly.',
          evidence: ['localthumbcache.package: 2026-11-01'],
          files: []
        }),
        sampleFinding({
          id: 'script-too-deep',
          rule: 'script-too-deep',
          severity: 'warn',
          certainty: 'likely',
          title: 'A script mod is buried too deep in folders',
          detail: 'Move this script mod closer to the top of Mods.',
          evidence: ['Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script (depth 3)'],
          files: ['Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script']
        }),
        sampleFinding({
          id: 'mods-off',
          rule: 'mods-off',
          severity: 'stop',
          certainty: 'file-problem',
          title: 'Mods are turned off after an update',
          detail: "Don't save your game until mods are back on.",
          evidence: ['Options.ini: modsdisabled = 1'],
          files: []
        })
      ]
    })

    renderCheckUp({ scan })

    expect(screen.getByText('The Sims 4 is open right now. Looking is completely safe.')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('—')

    const headings = screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)
    expect(headings).toEqual(['Do this first', 'Worth fixing', 'Good to know'])

    expect(screen.getByText('File problem found')).toBeInTheDocument()
    expect(screen.getByText('Likely cause')).toBeInTheDocument()
    expect(screen.getByText('Worth testing')).toBeInTheDocument()
    expect(screen.getByText('Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script')).toBeInTheDocument()

    // Technical details starts closed
    expect(screen.queryByText('Options.ini: modsdisabled = 1')).not.toBeInTheDocument()

    const triggers = screen.getAllByRole('button', { name: /technical details/i })
    await user.click(triggers[0]!)
    expect(screen.getByText('Options.ini: modsdisabled = 1')).toBeVisible()

    await user.click(screen.getByRole('button', { name: /send to tyler/i }))
    expect(screen.getByTestId('route')).toHaveTextContent('send-to-tyler')
  })

  it('keeps the raw error inside a closed Technical details box, under a plain sentence', async () => {
    const user = userEvent.setup()
    const scan = sampleScan()
    const raw = "EPERM: operation not permitted, scandir 'Mods'"
    renderCheckUp({
      scan: null,
      answers: {
        'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
        'scan:run': { status: 'failed', why: 'unexpected', detail: raw }
      }
    })

    expect(await screen.findByText(/Nothing in your game folder was changed/)).toBeInTheDocument()
    const details = screen.getByRole('button', { name: 'Technical details' })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(raw)).not.toBeInTheDocument()

    await user.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(raw)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('shows a calm all-clear verdict when there are no findings', () => {
    const scan = sampleScan({ findings: [] })
    renderCheckUp({ scan })

    expect(screen.getByText(/mods folder looks healthy/i)).toBeInTheDocument()
    expect(screen.queryByText('Do this first')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send to tyler/i })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('—')
  })

  it('does not call a hint from a log the likeliest reason', () => {
    const scan = sampleScan({
      findings: [
        sampleFinding({
          id: 'log-names-mod:g1',
          rule: 'log-names-mod',
          severity: 'warn',
          certainty: 'likely',
          title: 'Your last exception mentions one mod',
          detail: 'This could be a clue.',
          evidence: [],
          files: []
        })
      ]
    })
    renderCheckUp({ scan })

    expect(screen.getByText('Found 1 thing worth fixing')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/likeliest|the reason/i)
  })

  describe('tailors guidance to what happened', () => {
    const sendButton = () => screen.getByRole('button', { name: /send to tyler/i })
    const fiftyLink = () => screen.getByRole('button', { name: /50\/50 test/i })
    const isBefore = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

    it('one save or lot: explains the 50/50 test may not catch it and puts Send to Tyler first', () => {
      renderCheckUp({ scan: sampleScan({ symptom: 'one-save-or-lot', findings: [] }) })

      expect(screen.getByText(/only happens on one save or lot/i)).toBeInTheDocument()
      expect(screen.getByText(/brand new test household/i)).toBeInTheDocument()
      expect(isBefore(sendButton(), fiftyLink())).toBe(true)
      expect(screen.getByText(/mods folder looks healthy/i)).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/is still crashing/i)
      expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
    })

    it('one save or lot with findings still shows the guidance and the report first', () => {
      renderCheckUp({ scan: sampleScan({ symptom: 'one-save-or-lot' }) })

      expect(screen.getByText(/only happens on one save or lot/i)).toBeInTheDocument()
      expect(isBefore(sendButton(), fiftyLink())).toBe(true)
    })

    it('won\'t load: the all-clear talks about a game that will not open, not crashing', () => {
      renderCheckUp({ scan: sampleScan({ symptom: 'wont-load', findings: [] }) })

      expect(screen.getByText(/still will not open/i)).toBeInTheDocument()
      expect(screen.getByText(/game update/i)).toBeInTheDocument()
      expect(screen.getByText(/Repair in the EA app/)).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/is still crashing/i)
      expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
    })

    it('freezes: the all-clear talks about freezing, not crashing', () => {
      renderCheckUp({ scan: sampleScan({ symptom: 'freezes', findings: [] }) })

      expect(screen.getByText(/If your game still freezes or gets stuck/)).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/is still crashing/i)
      expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
    })

    it.each(['closes', 'not-sure'] as const)('%s: keeps the usual wording and order', (symptom) => {
      renderCheckUp({ scan: sampleScan({ symptom, findings: [] }) })

      expect(
        screen.getByText(
          'If your game is still crashing, you can try the 50/50 test or send a report to Tyler so he can take a closer look.'
        )
      ).toBeInTheDocument()
      expect(screen.queryByText(/only happens on one save or lot/i)).not.toBeInTheDocument()
      expect(isBefore(fiftyLink(), sendButton())).toBe(true)
    })
  })

  describe('what changed since last check-up', () => {
    it('renders nothing when changes is null or has no changes', () => {
      renderCheckUp({ scan: sampleScan({ changes: null }) })
      expect(screen.queryByText('What changed since your last check-up')).not.toBeInTheDocument()

      cleanup()
      renderCheckUp({
        scan: sampleScan({
          changes: {
            sinceAt: '2026-11-20T12:00:00.000Z',
            gameVersion: null,
            added: [],
            updated: [],
            removed: []
          }
        })
      })
      expect(screen.queryByText('What changed since your last check-up')).not.toBeInTheDocument()
    })

    it('renders summary counts, expands accordion with script badge, caps >15 items per category, and avoids em/en dashes', async () => {
      const user = userEvent.setup()
      const manyAdded = Array.from({ length: 18 }, (_, i) => ({
        groupId: `dir:added-${i + 1}`,
        label: i === 0 ? 'MC Command Center' : `Added Mod ${i + 1}`,
        hasScript: i === 0
      }))

      renderCheckUp({
        scan: sampleScan({
          changes: {
            sinceAt: '2026-11-20T12:00:00.000Z',
            gameVersion: { from: '1.128.10.1030', to: '1.129.39.1030' },
            added: manyAdded,
            updated: [{ groupId: 'cf:901234', label: 'Wicked Wardrobe', hasScript: true }],
            removed: [{ groupId: 'dir:old-hair', label: 'Old Hair', hasScript: false }]
          }
        })
      })

      expect(screen.getByText('What changed since your last check-up')).toBeInTheDocument()
      expect(screen.getByText(/Game updated from 1\.128\.10\.1030 to 1\.129\.39\.1030/)).toBeInTheDocument()
      expect(screen.getByText(/18 mods added/)).toBeInTheDocument()
      expect(screen.getByText(/1 mod updated/)).toBeInTheDocument()
      expect(screen.getByText(/1 mod removed/)).toBeInTheDocument()
      expect(screen.getByText(/Nov 20, 2026/)).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

      // Mod list starts collapsed
      expect(screen.queryByText('MC Command Center')).not.toBeInTheDocument()

      const trigger = screen.getByRole('button', { name: /changed mods/i })
      await user.click(trigger)

      expect(screen.getByText('MC Command Center')).toBeVisible()
      expect(screen.getByText('Wicked Wardrobe')).toBeVisible()
      expect(screen.getByText('Old Hair')).toBeVisible()
      expect(screen.getAllByText('Script mod')).toHaveLength(2)

      // 18 added mods capped at 15 + "and 3 more"
      expect(screen.getByText('Added Mod 15')).toBeVisible()
      expect(screen.queryByText('Added Mod 16')).not.toBeInTheDocument()
      expect(screen.getByText('and 3 more')).toBeVisible()
      expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
    })
  })
})
