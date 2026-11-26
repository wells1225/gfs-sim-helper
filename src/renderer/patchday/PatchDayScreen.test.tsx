import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { DisabledGroup, FixCall, FixOutcome, JournalEntry, ModGroup, Scan } from '../../shared/model.ts'
import { sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { LOAD_FAILED_COPY } from '../fixes/words.ts'
import { NavProvider, useNav } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi, type FakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { PatchDayScreen } from './PatchDayScreen.tsx'

afterEach(() => {
  cleanup()
})

const FOLDER = sampleScan().folder.path

function scriptGroup(id: string, label: string): ModGroup {
  return {
    id,
    label,
    source: 'folder',
    files: [`${label}/${label.toLowerCase()}.ts4script`],
    bytes: 20_000,
    hasScript: true,
    curseForge: null
  }
}

const HAIR: ModGroup = {
  id: 'dir:hair',
  label: 'Hair',
  source: 'folder',
  files: ['Hair/cozy_braids.package'],
  bytes: 1_240_000,
  hasScript: false,
  curseForge: null
}

function scanWith(groups: ModGroup[]): Scan {
  const base = sampleScan()
  return { ...base, inventory: { ...base.inventory, groups } }
}

function setAsideEntry(groupId: string, label: string, origin: JournalEntry['origin'] = { by: 'fix' }): JournalEntry {
  return sampleJournalEntry({
    id: `entry-${groupId}`,
    action: 'disable-group',
    groupId,
    groupLabel: label,
    hasScript: true,
    folderPath: FOLDER,
    origin
  })
}

function Route() {
  const { route } = useNav()
  return <output data-testid="route">{route.screen}</output>
}

function renderScreen(scan: Scan | null, answers: FakeApiAnswers = {}): FakeApi {
  const api = fakeApi({ 'groups:disabled': [], 'journal:list': [], ...answers })
  render(
    <ApiProvider value={api}>
      <SessionProvider initialScan={scan}>
        <NavProvider initial={{ screen: 'patch-day' }}>
          <PatchDayScreen />
          <Route />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
  return api
}

/** A pretend main side: each done set-aside or put-back changes what groups:disabled answers next. */
function liveFolder(initial: { disabled?: DisabledGroup[]; entries?: JournalEntry[] } = {}) {
  let disabled = [...(initial.disabled ?? [])]
  const entries = [...(initial.entries ?? [])]
  const answers: FakeApiAnswers = {
    'groups:disabled': () => [...disabled],
    'journal:list': () => [...entries],
    'fix:apply': (req: FixCall): FixOutcome => {
      if (req.via !== 'group') throw new Error('unexpected call')
      if (req.fix === 'disable-group') {
        const entry = setAsideEntry(req.groupId, req.groupId)
        entries.push(entry)
        disabled.push({ groupId: req.groupId, label: req.groupId, entryId: entry.id, at: entry.at, origin: 'fix' })
        return { status: 'done', entry }
      }
      disabled = disabled.filter((d) => d.groupId !== req.groupId)
      return { status: 'done', entry: setAsideEntry(req.groupId, req.groupId) }
    }
  }
  return answers
}

function fixCalls(api: FakeApi): FixCall[] {
  return api.calls.filter((c) => c.channel === 'fix:apply').map((c) => c.req as FixCall)
}

describe('PatchDayScreen', () => {
  it('asks for a read-only check-up first when there is no scan, and changes nothing', async () => {
    const user = userEvent.setup()
    const api = renderScreen(null)

    expect(screen.getByText(/quick, read-only check-up first to find your script mods/i)).toBeInTheDocument()
    expect(api.calls.filter((c) => c.channel === 'fix:apply')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Run a check-up' }))
    expect(screen.getByTestId('route')).toHaveTextContent('check-up')
  })

  it('always shows the calm save warning, with no em or en dashes', async () => {
    renderScreen(scanWith([scriptGroup('dir:mccc', 'MCCC'), HAIR]))

    expect(
      await screen.findByText(
        'Do not save over your main household while mods are turned off or set aside. Test in a brand new save or exit without saving so your Sims keep their items.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('A safety copy is made before any mod moves, and every change can be undone from here or History.')
    ).toBeInTheDocument()
    expect(screen.getByText(/\.ts4script/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
  })

  it('lists only script mods and never runs a fix on its own', async () => {
    const api = renderScreen(scanWith([scriptGroup('dir:mccc', 'MCCC'), HAIR]))

    expect(await screen.findByText('MCCC')).toBeInTheDocument()
    expect(screen.queryByText('Hair')).not.toBeInTheDocument()
    expect(screen.getByText('In Mods')).toBeInTheDocument()
    expect(screen.getByTestId('patch-day-summary')).toHaveTextContent('1 script mod in Mods · 0 set aside')
    expect(screen.getByTestId('patch-day-summary')).toHaveTextContent('Game version 1.129.39.1030')
    expect(fixCalls(api)).toHaveLength(0)
  })

  it('marks a script mod older than the game update', async () => {
    renderScreen(sampleScan())

    expect(await screen.findByText('Wicked Wardrobe')).toBeInTheDocument()
    expect(screen.getByText(/Older than game update/)).toBeInTheDocument()
  })

  it('shows a calm empty state when there are no script mods', async () => {
    const user = userEvent.setup()
    renderScreen(scanWith([HAIR]))

    expect(await screen.findByText('No script mods found')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set aside all script mods' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Your mods' }))
    expect(screen.getByTestId('route')).toHaveTextContent('mods')
  })

  it('sets aside every script mod in Mods one at a time, then shows the new state', async () => {
    const user = userEvent.setup()
    const api = renderScreen(
      scanWith([scriptGroup('dir:mccc', 'MCCC'), scriptGroup('dir:wonderful', 'Wonderful Whims'), HAIR]),
      liveFolder()
    )

    const button = await screen.findByRole('button', { name: 'Set aside all script mods' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(await screen.findByText('Set aside 2 script mods')).toBeInTheDocument()
    expect(fixCalls(api)).toEqual([
      { via: 'group', fix: 'disable-group', groupId: 'dir:mccc' },
      { via: 'group', fix: 'disable-group', groupId: 'dir:wonderful' }
    ])
    await waitFor(() => expect(screen.getAllByText('Set aside')).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Set aside all script mods' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Put script mods back' })).toBeEnabled()
  })

  it('stops at the first refusal and does not touch the remaining mods', async () => {
    const user = userEvent.setup()
    let call = 0
    const api = renderScreen(
      scanWith([scriptGroup('dir:a', 'Alpha Mod'), scriptGroup('dir:b', 'Beta Mod'), scriptGroup('dir:c', 'Gamma Mod')]),
      {
        'fix:apply': (req: FixCall): FixOutcome => {
          if (req.via !== 'group') throw new Error('unexpected call')
          call++
          if (call === 2) return { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
          return { status: 'done', entry: setAsideEntry(req.groupId, req.groupId) }
        }
      }
    )

    const button = await screen.findByRole('button', { name: 'Set aside all script mods' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(await screen.findByText('The Sims 4 is still open')).toBeInTheDocument()
    expect(screen.getByText(/1 script mod was already set aside before this stopped/)).toBeInTheDocument()
    expect(fixCalls(api)).toEqual([
      { via: 'group', fix: 'disable-group', groupId: 'dir:a' },
      { via: 'group', fix: 'disable-group', groupId: 'dir:b' }
    ])
    // The lists are read again afterwards, so the screen shows what really moved.
    await waitFor(() => expect(api.calls.filter((c) => c.channel === 'groups:disabled')).toHaveLength(2))
  })

  it('puts back only the script mods she set aside, never the ones a 50/50 test set aside', async () => {
    const user = userEvent.setup()
    const fixEntry = setAsideEntry('dir:mccc', 'MCCC')
    const fiftyEntry = setAsideEntry('dir:wonderful', 'Wonderful Whims', {
      by: 'fifty-fifty',
      sessionId: 's-1',
      round: 1
    })
    const api = renderScreen(
      scanWith([HAIR]),
      liveFolder({
        disabled: [
          { groupId: 'dir:mccc', label: 'MCCC', entryId: fixEntry.id, at: fixEntry.at, origin: 'fix' },
          {
            groupId: 'dir:wonderful',
            label: 'Wonderful Whims',
            entryId: fiftyEntry.id,
            at: fiftyEntry.at,
            origin: 'fifty-fifty'
          }
        ],
        entries: [fixEntry, fiftyEntry]
      })
    )

    expect(await screen.findByText('Set aside by 50/50 test')).toBeInTheDocument()
    expect(screen.getByText('MCCC')).toBeInTheDocument()

    const button = screen.getByRole('button', { name: 'Put script mods back' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(await screen.findByText('Put 1 script mod back in Mods')).toBeInTheDocument()
    expect(fixCalls(api)).toEqual([{ via: 'group', fix: 'enable-group', groupId: 'dir:mccc' }])

    await user.click(screen.getByRole('button', { name: 'Open 50/50 test' }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })

  it('says so when the set-aside list cannot load, and keeps the bulk buttons off', async () => {
    renderScreen(scanWith([scriptGroup('dir:mccc', 'MCCC')]), {
      'groups:disabled': () => Promise.reject(new Error('boom'))
    })

    expect(await screen.findByText(LOAD_FAILED_COPY.title)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set aside all script mods' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
