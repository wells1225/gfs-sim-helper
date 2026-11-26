import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModFile, ModGroup, Scan } from '../../shared/model.ts'
import { sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { Toaster } from '../components/ui/sonner.tsx'
import { NavProvider } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi, type FakeApi } from '../testing/fake-api.ts'
import { ModsScreen } from './ModsScreen.tsx'

afterEach(() => {
  toast.dismiss()
  cleanup()
})

function Harness({ api, scan, children }: { api: FakeApi; scan: Scan | null; children: ReactNode }) {
  return (
    <ApiProvider value={api}>
      <SessionProvider initialScan={scan}>
        <NavProvider initial={{ screen: 'mods' }}>
          {children}
          <Toaster />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
}

function packageFile(relPath: string, groupId: string, bytes: number, modifiedAt: string): ModFile {
  return {
    kind: 'package',
    relPath,
    bytes,
    modifiedAt,
    hash: { status: 'not-needed' },
    groupId,
    depth: relPath.split('/').length - 1,
    dbpf: { status: 'ok', keyCount: 3 }
  }
}

/**
 * The sample scan (Wicked Wardrobe, a script mod from Oct 10, and Hair from Nov 18) plus BuildBuy, the biggest and
 * oldest. The game updated on Nov 15, so BuildBuy and Wicked Wardrobe are older than the update.
 */
function explorerScan(gameUpdatedAt: string | null = '2026-11-15T17:00:00.000Z'): Scan {
  const base = sampleScan()
  const fern = packageFile('BuildBuy/Plants/fern_pot.package', 'dir:buildbuy', 3_000_000, '2026-09-01T08:00:00.000Z')
  const buildBuy: ModGroup = {
    id: 'dir:buildbuy',
    label: 'BuildBuy',
    source: 'folder',
    files: [fern.relPath],
    bytes: 3_000_000,
    hasScript: false,
    curseForge: null
  }
  return {
    ...base,
    facts: { ...base.facts, gameUpdatedAt },
    inventory: {
      ...base.inventory,
      files: [fern, ...base.inventory.files],
      groups: [...base.inventory.groups, buildBuy]
    }
  }
}

function api(overrides: Parameters<typeof fakeApi>[0] = {}): FakeApi {
  return fakeApi({ 'journal:list': [], 'groups:disabled': [], ...overrides })
}

/** The order of the rows on screen, read from their switches. */
function visibleOrder(): string[] {
  return screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label') ?? '')
}

describe('Your mods: search by file name', () => {
  it('finds the group that holds a pasted .ts4script file and says which file matched', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    await user.type(await screen.findByRole('searchbox', { name: 'Search your mods' }), 'WARDROBE.ts4script')
    expect(visibleOrder()).toEqual(['Set Wicked Wardrobe aside'])
    expect(screen.getByText('Matched file: wardrobe.ts4script')).toBeInTheDocument()
  })

  it('finds the group that holds a .package file, and a subfolder name', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    const search = await screen.findByRole('searchbox', { name: 'Search your mods' })
    await user.type(search, 'cozy_braids.package')
    expect(visibleOrder()).toEqual(['Set Hair aside'])
    expect(screen.getByText('Matched file: cozy_braids.package')).toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'plants')
    expect(visibleOrder()).toEqual(['Set BuildBuy aside'])
    expect(screen.getByText('Matched file: BuildBuy/Plants/fern_pot.package')).toBeInTheDocument()
  })

  it('shows no file hint when the name of the mod matched', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    await user.type(await screen.findByRole('searchbox', { name: 'Search your mods' }), 'wicked')
    expect(visibleOrder()).toEqual(['Set Wicked Wardrobe aside'])
    expect(screen.queryByText(/Matched file/)).not.toBeInTheDocument()
  })
})

describe('Your mods: filters, sort and summary', () => {
  it('shows a summary of the whole folder', async () => {
    render(
      <Harness
        api={api({
          'groups:disabled': [
            { groupId: 'dir:hair', label: 'Hair', entryId: 'e-1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' }
          ]
        })}
        scan={explorerScan()}
      >
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByText('3 mods · 1 script mod · 4.1 MB · 1 set aside')).toBeInTheDocument()
  })

  it('filter buttons change which mods show', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        api={api({
          'groups:disabled': [
            { groupId: 'dir:hair', label: 'Hair', entryId: 'e-1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' }
          ]
        })}
        scan={explorerScan()}
      >
        <ModsScreen />
      </Harness>
    )

    await screen.findByRole('switch', { name: 'Turn Hair back on' })
    expect(visibleOrder()).toEqual(['Set BuildBuy aside', 'Turn Hair back on', 'Set Wicked Wardrobe aside'])

    await user.click(screen.getByRole('button', { name: 'Script mods' }))
    expect(screen.getByRole('button', { name: 'Script mods' })).toHaveAttribute('aria-pressed', 'true')
    expect(visibleOrder()).toEqual(['Set Wicked Wardrobe aside'])

    await user.click(screen.getByRole('button', { name: 'Older than game update' }))
    expect(visibleOrder()).toEqual(['Set BuildBuy aside', 'Set Wicked Wardrobe aside'])

    await user.click(screen.getByRole('button', { name: 'Set aside' }))
    expect(visibleOrder()).toEqual(['Turn Hair back on'])

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(visibleOrder()).toHaveLength(3)
  })

  it('hides the game update filter when the update date is unknown', async () => {
    render(
      <Harness api={api()} scan={explorerScan(null)}>
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByRole('button', { name: 'Script mods' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Older than game update' })).not.toBeInTheDocument()
  })

  it('the sort changes the order', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    const sort = await screen.findByRole('combobox', { name: 'Sort your mods' })
    expect(visibleOrder()).toEqual(['Set BuildBuy aside', 'Set Hair aside', 'Set Wicked Wardrobe aside'])

    await user.selectOptions(sort, 'Largest first')
    expect(visibleOrder()).toEqual(['Set BuildBuy aside', 'Set Hair aside', 'Set Wicked Wardrobe aside'])

    await user.selectOptions(sort, 'Oldest first')
    expect(visibleOrder()).toEqual(['Set BuildBuy aside', 'Set Wicked Wardrobe aside', 'Set Hair aside'])

    await user.selectOptions(sort, 'Name (A-Z)')
    expect(visibleOrder()).toEqual(['Set BuildBuy aside', 'Set Hair aside', 'Set Wicked Wardrobe aside'])
  })

  it('says so calmly when a filter leaves nothing to show', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('button', { name: 'Set aside' }))
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.getByText('No mods match this filter.')).toBeInTheDocument()
  })
})

describe('Your mods: the file list', () => {
  it('expanding a row lists its files with size and date', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    const toggle = await screen.findByRole('button', { name: 'Files (1) in Hair' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Hair/cozy_braids.package')).not.toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'Files in Hair' })
    expect(within(list).getByText('Hair/cozy_braids.package')).toBeInTheDocument()
    expect(within(list).getByText('1.2 MB · Nov 18, 2026')).toBeInTheDocument()

    await user.click(toggle)
    expect(screen.queryByText('Hair/cozy_braids.package')).not.toBeInTheDocument()
  })

  it('lists 25 files at most and says how many more there are', async () => {
    const user = userEvent.setup()
    const base = sampleScan()
    const files = Array.from({ length: 30 }, (_, i) =>
      packageFile(`CC Pack/item_${String(i).padStart(2, '0')}.package`, 'dir:cc pack', 1000, '2026-11-01T10:00:00.000Z')
    )
    const scan: Scan = {
      ...base,
      inventory: {
        ...base.inventory,
        files,
        groups: [
          {
            id: 'dir:cc pack',
            label: 'CC Pack',
            source: 'folder',
            files: files.map((f) => f.relPath),
            bytes: 30_000,
            hasScript: false,
            curseForge: null
          }
        ]
      }
    }

    render(
      <Harness api={api()} scan={scan}>
        <ModsScreen />
      </Harness>
    )

    await user.click(await screen.findByRole('button', { name: 'Files (30) in CC Pack' }))
    const list = screen.getByRole('list', { name: 'Files in CC Pack' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(25)
    expect(within(list).getByText('CC Pack/item_24.package')).toBeInTheDocument()
    expect(within(list).queryByText('CC Pack/item_25.package')).not.toBeInTheDocument()
    expect(screen.getByText('and 5 more')).toBeInTheDocument()
  })

  it('a set-aside row known only from History has no file list', async () => {
    render(
      <Harness
        api={api({
          'groups:disabled': [
            { groupId: 'cf:901234', label: 'Wicked Wardrobe', entryId: 'e-1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' }
          ]
        })}
        scan={null}
      >
        <ModsScreen />
      </Harness>
    )

    expect(await screen.findByRole('switch', { name: 'Turn Wicked Wardrobe back on' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Files/ })).not.toBeInTheDocument()
  })
})

describe('Your mods: what was there stays the same', () => {
  it('the switch still sets a mod aside through the same call, with a filter and sort in use', async () => {
    const user = userEvent.setup()
    const fake = api({
      'fix:apply': () => ({
        status: 'done',
        entry: sampleJournalEntry({ id: 'd-hair', action: 'disable-group', groupId: 'dir:hair', status: 'done' })
      })
    })
    render(
      <Harness api={fake} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Sort your mods' }), 'Largest first')
    await user.type(screen.getByRole('searchbox', { name: 'Search your mods' }), 'braids')
    await user.click(screen.getByRole('switch', { name: 'Set Hair aside' }))

    expect(await screen.findByRole('switch', { name: 'Turn Hair back on' })).toHaveAttribute('aria-checked', 'false')
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.channel === 'fix:apply').map((c) => c.req)).toEqual([
        { via: 'group', fix: 'disable-group', groupId: 'dir:hair' }
      ])
    )
  })

  it('uses no long dashes anywhere, with every file list open', async () => {
    const user = userEvent.setup()
    render(
      <Harness api={api()} scan={explorerScan()}>
        <ModsScreen />
      </Harness>
    )

    await screen.findByRole('button', { name: 'Files (1) in Hair' })
    for (const toggle of screen.getAllByRole('button', { name: /^Files \(/ })) {
      await user.click(toggle)
    }
    await user.type(screen.getByRole('searchbox', { name: 'Search your mods' }), 'fern')
    expect(document.body.textContent ?? '').not.toMatch(/[\u2013\u2014]/)
    for (const option of screen.getAllByRole('option')) {
      expect(option.textContent ?? '').not.toMatch(/[\u2013\u2014]/)
    }
  })
})
