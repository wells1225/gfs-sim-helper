import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { Inventory, LogReport, ModFile, Scan } from '../../shared/model.ts'
import { sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi } from '../testing/fake-api.ts'
import { CheckUp } from './CheckUp.tsx'
import { CoverageNotice } from './CoverageNotice.tsx'
import { RecentErrorsCard } from './RecentErrorsCard.tsx'

afterEach(() => {
  cleanup()
})

function renderCheckUp(scan: Scan) {
  const api = fakeApi({})
  render(
    <ApiProvider value={api}>
      <SessionProvider initialScan={scan} initialSymptom={scan.symptom}>
        <NavProvider initial={{ screen: 'check-up' }}>
          <CheckUp />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
}

function isBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function expectCleanCopy() {
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/[\u2014\u2013]/)
  expect(text).not.toMatch(/likeliest|the reason/i)
}

function makeLog(overrides: Partial<LogReport> = {}): LogReport {
  return {
    file: 'lastException_63887259912.txt',
    kind: 'exception',
    fileModifiedAt: '2026-11-23T22:14:00.000Z',
    createdLocal: '11/23/26 15:14:00',
    gameVersion: '1.129.39.1030',
    categoryId: 'outfit_picker.py:42',
    message: 'AttributeError: NoneType object has no attribute sim_info',
    count: 1,
    frames: [],
    modHints: [],
    completeness: 'complete',
    ...overrides
  }
}

describe('CoverageNotice', () => {
  it('renders nothing when Mods is present and clean, whether empty or populated', () => {
    const populatedInventory = sampleScan().inventory
    const { container: populatedContainer } = render(<CoverageNotice inventory={populatedInventory} />)
    expect(populatedContainer.firstChild).toBeNull()

    cleanup()
    const emptyInventory: Inventory = {
      ...populatedInventory,
      modsDirState: 'present',
      files: [],
      groups: [],
      skipped: []
    }
    const { container: emptyContainer } = render(<CoverageNotice inventory={emptyInventory} />)
    expect(emptyContainer.firstChild).toBeNull()
  })

  it('renders a calm missing-Mods-folder notice distinctly from an empty Mods folder', () => {
    const missingInventory: Inventory = {
      ...sampleScan().inventory,
      modsDirState: 'missing',
      files: [],
      groups: [],
      resourceCfg: { status: 'missing' },
      skipped: []
    }

    render(<CoverageNotice inventory={missingInventory} />)

    expect(screen.getByText('No Mods folder was found in this Sims 4 folder yet')).toBeInTheDocument()
    expect(screen.getByText(/no mod files were checked/i)).toBeInTheDocument()
    expect(screen.queryByText('Some items could not be checked')).not.toBeInTheDocument()
    expectCleanCopy()
  })

  it('renders counts, starts collapsed, expands with safe relative paths, deduplicates dbpf+hash failures, and hides OS paths', async () => {
    const user = userEvent.setup()
    const files: ModFile[] = [
      {
        kind: 'package',
        relPath: 'CAS/locked_dress.package',
        bytes: 4096,
        modifiedAt: '2026-11-20T10:00:00.000Z',
        // Both dbpf and hash failed on the same file: must count once and show once
        hash: {
          status: 'unreadable',
          detail: "EBUSY: resource busy or locked, open 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\CAS\\locked_dress.package'"
        },
        groupId: 'dir:cas',
        depth: 1,
        dbpf: {
          status: 'unreadable',
          detail: "EBUSY: resource busy or locked, open 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\CAS\\locked_dress.package'"
        }
      },
      {
        kind: 'script',
        relPath: 'Gameplay/broken_lock.ts4script',
        bytes: 8192,
        modifiedAt: '2026-11-20T10:00:00.000Z',
        hash: { status: 'not-needed' },
        groupId: 'dir:gameplay',
        depth: 1,
        script: {
          status: 'unreadable',
          detail: "EPERM: operation not permitted, open 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\Gameplay\\broken_lock.ts4script'"
        }
      },
      {
        kind: 'package',
        relPath: 'My Pack/Mods/dup_a.package',
        bytes: 2048,
        modifiedAt: '2026-11-20T10:00:00.000Z',
        hash: {
          status: 'unreadable',
          detail: "EACCES: permission denied, open 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\My Pack\\Mods\\dup_a.package'"
        },
        groupId: 'dir:my pack',
        depth: 2,
        dbpf: { status: 'ok', keyCount: 4 }
      }
    ]

    const inventory: Inventory = {
      ...sampleScan().inventory,
      modsDirState: 'present',
      files,
      skipped: [
        {
          relPath: 'LockedFolder',
          detail: "EPERM: operation not permitted, scandir 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\LockedFolder'"
        },
        {
          relPath: 'ShortcutOut',
          detail: 'Link points outside Mods folder'
        }
      ]
    }

    render(<CoverageNotice inventory={inventory} />)

    expect(screen.getByText('Some items could not be checked')).toBeInTheDocument()
    expect(screen.getByText('2 folders or files skipped · 3 mod files could not be read')).toBeInTheDocument()
    expect(screen.getByText(/only covers the files that could be read/i)).toBeInTheDocument()

    // Starts collapsed
    const trigger = screen.getByRole('button', { name: 'See what could not be checked' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('CAS/locked_dress.package')).not.toBeInTheDocument()
    expect(screen.queryByText('LockedFolder')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    expect(screen.getByText('LockedFolder')).toBeVisible()
    expect(screen.getByText('ShortcutOut')).toBeVisible()
    expect(screen.getAllByText('Skipped folder or file')).toHaveLength(2)

    // Deduplicated: CAS/locked_dress.package appears once with Package could not be read
    expect(screen.getAllByText('CAS/locked_dress.package')).toHaveLength(1)
    expect(screen.getByText('Package could not be read')).toBeVisible()
    expect(screen.getByText('Gameplay/broken_lock.ts4script')).toBeVisible()
    expect(screen.getByText('Script mod could not be read')).toBeVisible()
    expect(screen.getByText('My Pack/Mods/dup_a.package')).toBeVisible()
    expect(screen.getByText('Could not compare duplicate file')).toBeVisible()

    // Never leaks raw OS paths from error details
    expect(document.body.textContent).not.toContain('C:\\Users\\Lila')
    expect(document.body.textContent).not.toContain('Electronic Arts')
    expectCleanCopy()
  })

  it('caps skipped and unreadable lists at 20 items each with "and N more"', async () => {
    const user = userEvent.setup()
    const skipped = Array.from({ length: 23 }, (_, i) => ({
      relPath: `SkippedDir/folder-${i + 1}`,
      detail: 'EPERM'
    }))
    const files: ModFile[] = Array.from({ length: 22 }, (_, i) => ({
      kind: 'package',
      relPath: `Unreadable/pkg-${i + 1}.package`,
      bytes: 1024,
      modifiedAt: '2026-11-20T10:00:00.000Z',
      hash: { status: 'not-needed' },
      groupId: 'dir:unreadable',
      depth: 1,
      dbpf: { status: 'unreadable', detail: 'EBUSY' }
    }))

    render(
      <CoverageNotice
        inventory={{
          ...sampleScan().inventory,
          modsDirState: 'present',
          skipped,
          files
        }}
      />
    )

    expect(screen.getByText('23 folders or files skipped · 22 mod files could not be read')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'See what could not be checked' }))

    expect(screen.getByText('SkippedDir/folder-20')).toBeVisible()
    expect(screen.queryByText('SkippedDir/folder-21')).not.toBeInTheDocument()
    expect(screen.getByText('and 3 more')).toBeVisible()

    expect(screen.getByText('Unreadable/pkg-20.package')).toBeVisible()
    expect(screen.queryByText('Unreadable/pkg-21.package')).not.toBeInTheDocument()
    expect(screen.getByText('and 2 more')).toBeVisible()
    expectCleanCopy()
  })
})

describe('RecentErrorsCard', () => {
  it('renders nothing when logs is empty', () => {
    const { container } = render(<RecentErrorsCard logs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('starts collapsed and expands to show all 5 log kinds, count > 1, Cut off badge, safe date fallback, and capped mod hints', async () => {
    const user = userEvent.setup()
    const longLine = `RuntimeError: ${'very_long_python_attribute_name_'.repeat(6)}\nSecond line should not show`
    const logs: LogReport[] = [
      makeLog({
        file: 'lastException_001.txt',
        kind: 'exception',
        fileModifiedAt: '2026-11-24T18:00:00.000Z',
        count: 4,
        completeness: 'cut-off',
        message: longLine,
        modHints: [
          'c:/users/lila/documents/electronic arts/the sims 4/mods/wicked_wardrobe/outfit_picker',
          'deaderpool/mc_cmd_center',
          'ui_cheats/ui_core',
          'fourth_mod/not_shown'
        ]
      }),
      makeLog({
        file: 'lastUIException_002.txt',
        kind: 'uiException',
        fileModifiedAt: '2026-11-23T18:00:00.000Z',
        message: 'TypeError: Error #1009 in ActionScript panel — dash scrubbed'
      }),
      makeLog({
        file: 'lastCrash_003.txt',
        kind: 'crash',
        fileModifiedAt: '2026-11-22T18:00:00.000Z',
        message: null
      }),
      makeLog({
        file: 'BE-ExceptionReport_004.html',
        kind: 'betterExceptions',
        fileModifiedAt: '2026-11-21T18:00:00.000Z',
        message: 'KeyError: 99102'
      }),
      makeLog({
        file: 'Mods/mc_cmd_center/mc_lastexception.html',
        kind: 'mccc',
        fileModifiedAt: 'not-a-valid-iso-date',
        message: 'ValueError: invalid tuning id'
      })
    ]

    render(<RecentErrorsCard logs={logs} />)

    expect(screen.getByText('Recent game errors')).toBeInTheDocument()
    expect(screen.getByText('5 crash or exception logs found in your Sims 4 folder.')).toBeInTheDocument()

    // Starts collapsed
    const trigger = screen.getByRole('button', { name: 'See recent logs' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('lastException_001.txt')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    // All 5 plain-English kind labels
    expect(screen.getByText('Last exception')).toBeVisible()
    expect(screen.getByText('UI exception')).toBeVisible()
    expect(screen.getByText('Game crash log')).toBeVisible()
    expect(screen.getByText('Better Exceptions report')).toBeVisible()
    expect(screen.getByText('MC Command Center log')).toBeVisible()

    // Filenames, occurrence count, Cut off badge, and invalid-date fallback
    expect(screen.getByText('lastException_001.txt')).toBeVisible()
    expect(screen.getByText('4 times')).toBeVisible()
    expect(screen.getByText('Cut off')).toBeVisible()
    expect(screen.getByText('Mods/mc_cmd_center/mc_lastexception.html')).toBeVisible()
    expect(screen.getByText('not-a-valid-iso-date')).toBeVisible()

    // Truncates first line to <= 140 chars and ignores second line
    const truncatedEl = screen.getByText(/^RuntimeError: very_long_python_attribute_name_/)
    expect((truncatedEl.textContent ?? '').length).toBeLessThanOrEqual(140)
    expect(screen.queryByText(/Second line should not show/)).not.toBeInTheDocument()

    // Mod hints: strips OS path up to Mods/, shows first 3, omits 4th
    expect(screen.getByText('wicked_wardrobe/outfit_picker')).toBeVisible()
    expect(screen.getByText('deaderpool/mc_cmd_center')).toBeVisible()
    expect(screen.getByText('ui_cheats/ui_core')).toBeVisible()
    expect(screen.queryByText('fourth_mod/not_shown')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('c:/users/lila')

    expectCleanCopy()
  })

  it('caps logs above 20 with "and N more"', async () => {
    const user = userEvent.setup()
    const logs = Array.from({ length: 24 }, (_, i) =>
      makeLog({
        file: `lastException_${String(i + 1).padStart(2, '0')}.txt`,
        categoryId: `cat-${i + 1}`
      })
    )

    render(<RecentErrorsCard logs={logs} />)

    expect(screen.getByText('24 crash or exception logs found in your Sims 4 folder.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'See recent logs' }))

    expect(screen.getByText('lastException_20.txt')).toBeVisible()
    expect(screen.queryByText('lastException_21.txt')).not.toBeInTheDocument()
    expect(screen.getByText('and 4 more')).toBeVisible()
    expectCleanCopy()
  })
})

describe('CheckUp integration for CoverageNotice and RecentErrorsCard', () => {
  it('places CoverageNotice between Verdict and ChangesCard, places RecentErrorsCard after findings and before bottom actions, and adds no h2 headings', () => {
    const scan = sampleScan({
      inventory: {
        ...sampleScan().inventory,
        skipped: [{ relPath: 'LockedSubfolder', detail: 'EACCES' }]
      },
      changes: {
        sinceAt: '2026-11-20T12:00:00.000Z',
        gameVersion: null,
        added: [{ groupId: 'dir:new-hair', label: 'New Hair', hasScript: false }],
        updated: [],
        removed: []
      }
    })

    renderCheckUp(scan)

    const verdictHeading = screen.getByRole('heading', { level: 1 })
    const coverageHeading = screen.getByText('Some items could not be checked')
    const changesHeading = screen.getByText('What changed since your last check-up')
    const lastFindingGroup = screen.getByRole('heading', { level: 2, name: 'Good to know' })
    const recentErrorsHeading = screen.getByText('Recent game errors')
    const sendButton = screen.getByRole('button', { name: /send to tyler/i })

    expect(isBefore(verdictHeading, coverageHeading)).toBe(true)
    expect(isBefore(coverageHeading, changesHeading)).toBe(true)
    expect(isBefore(lastFindingGroup, recentErrorsHeading)).toBe(true)
    expect(isBefore(recentErrorsHeading, sendButton)).toBe(true)

    const level2Headings = screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)
    expect(level2Headings).toEqual(['Do this first', 'Worth fixing', 'Good to know'])

    expectCleanCopy()
  })

  it('omits both cards inside CheckUp when Mods is clean and logs is empty', () => {
    const base = sampleScan()
    renderCheckUp({
      ...base,
      logs: [],
      findings: []
    })

    expect(screen.queryByText('Some items could not be checked')).not.toBeInTheDocument()
    expect(screen.queryByText('No Mods folder was found in this Sims 4 folder yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Recent game errors')).not.toBeInTheDocument()
    expectCleanCopy()
  })
})
