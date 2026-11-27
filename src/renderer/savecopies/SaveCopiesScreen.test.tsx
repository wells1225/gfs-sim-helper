import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { SaveCopy, SaveCopyMade, SavePutBack } from '../../shared/model.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi, type FakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { resetPutBacksForTests, SaveCopiesScreen } from './SaveCopiesScreen.tsx'
import { BROKEN_COPY, PUT_BACK_DONE } from './words.ts'

afterEach(() => {
  cleanup()
  resetPutBacksForTests()
})

const HASH = 'a'.repeat(64)

function copy(overrides: Partial<SaveCopy> = {}): SaveCopy {
  return {
    id: '20261126-120000-0001',
    at: '2026-11-26T12:00:00.000Z',
    reason: 'by-hand',
    gameVersion: '1.130.12.1020',
    saves: [
      { name: 'Slot_00000002.save', bytes: 4_200_000, sha256: HASH, savedAt: '2026-11-25T20:00:00.000Z' },
      { name: 'Slot_00000005.save', bytes: 9_800_000, sha256: HASH, savedAt: '2026-11-26T09:30:00.000Z' }
    ],
    trayFiles: 12,
    bytes: 14_500_000,
    status: 'checked',
    ...overrides
  }
}

function renderScreen(answers: FakeApiAnswers = {}): FakeApi {
  const api = fakeApi(answers)
  render(
    <ApiProvider value={api}>
      <SessionProvider initialScan={null}>
        <NavProvider initial={{ screen: 'save-copies' }}>
          <SaveCopiesScreen />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
  return api
}

const changing = (api: FakeApi) => api.calls.filter((c) => c.channel !== 'savecopies:list')

describe('SaveCopiesScreen', () => {
  it('shows an empty list and changes nothing until she clicks', async () => {
    const api = renderScreen({ 'savecopies:list': [] })
    expect(await screen.findByText('No save copies yet')).toBeInTheDocument()
    expect(changing(api)).toEqual([])
  })

  it('lists copies with date, why, game version, saves and size', async () => {
    renderScreen({ 'savecopies:list': [copy(), copy({ id: 'c2', reason: 'before-change', gameVersion: null })] })
    const cards = await screen.findAllByTestId('save-copy')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent('Made by you')
    expect(cards[0]).toHaveTextContent('2 saves')
    expect(cards[0]).toHaveTextContent('Game version 1.130.12.1020')
    expect(cards[0]).toHaveTextContent('13.8 MB')
    expect(cards[1]).toHaveTextContent('Before a mod change')
    expect(cards[1]).not.toHaveTextContent('Game version')
  })

  it('a broken copy says so and offers no put back', async () => {
    renderScreen({ 'savecopies:list': [copy({ status: 'broken' })] })
    expect(await screen.findByText(BROKEN_COPY)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Put a save back' })).toBeNull()
  })

  it('makes a copy by hand, shows it is working, then lists it', async () => {
    const user = userEvent.setup()
    let release!: (made: SaveCopyMade) => void
    let list: SaveCopy[] = []
    const api = renderScreen({
      'savecopies:list': () => list,
      'savecopies:make': () =>
        new Promise<SaveCopyMade>((resolve) => {
          release = resolve
        })
    })
    await user.click(await screen.findByRole('button', { name: 'Save a copy now' }))
    expect(await screen.findByText('Making a copy of your saves…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Making a copy…' })).toBeDisabled()
    list = [copy()]
    release({ kind: 'done', copy: copy() })
    expect(await screen.findByText('Copy made and checked')).toBeInTheDocument()
    expect(await screen.findAllByTestId('save-copy')).toHaveLength(1)
    expect(api.calls.find((c) => c.channel === 'savecopies:make')?.req).toEqual({ reason: 'by-hand' })
  })

  it('says plainly to close the game when it is running', async () => {
    const user = userEvent.setup()
    renderScreen({ 'savecopies:make': { kind: 'refused', why: 'game-running' } })
    await user.click(await screen.findByRole('button', { name: 'Save a copy now' }))
    expect(await screen.findByText('Close The Sims 4 first')).toBeInTheDocument()
  })

  it('puts a save back from the picker and shows where it went', async () => {
    const user = userEvent.setup()
    const api = renderScreen({
      'savecopies:list': [copy()],
      'savecopies:put-back': (): SavePutBack => ({ kind: 'done', newSlot: 'Slot_0000000a.save' })
    })
    await user.click(await screen.findByRole('button', { name: 'Put a save back' }))
    const rows = within(await screen.findByRole('list', { name: 'Saves in this copy' }))
    const buttons = rows.getAllByRole('button', { name: 'Put this one back' })
    expect(buttons).toHaveLength(2)
    // newest save first
    await user.click(buttons[0]!)
    expect(await screen.findByText(PUT_BACK_DONE)).toBeInTheDocument()
    expect(screen.getByText('Added as Slot_0000000a.save')).toBeInTheDocument()
    expect(screen.getByText('Saves you put back')).toBeInTheDocument()
    expect(api.calls.find((c) => c.channel === 'savecopies:put-back')?.req).toEqual({
      copyId: '20261126-120000-0001',
      save: 'Slot_00000005.save'
    })
  })

  it('a put back that fails stays on the picker and explains', async () => {
    const user = userEvent.setup()
    renderScreen({
      'savecopies:list': [copy()],
      'savecopies:put-back': { kind: 'refused', why: 'error' }
    })
    await user.click(await screen.findByRole('button', { name: 'Put a save back' }))
    await user.click((await screen.findAllByRole('button', { name: 'Put this one back' }))[0]!)
    expect(await screen.findByText("The save couldn't be put back")).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Put this one back' })[0]).not.toBeDisabled())
  })
})
