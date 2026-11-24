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
})
