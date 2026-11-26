import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FiftyAnswer, FiftyFifty, FiftyGet, FiftyResult, FiftyStopResult, JournalEntry, Scan } from '../../shared/model.ts'
import { sampleFiftyFifty, sampleFinding, sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav, type Route } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { FiftyEntry } from './FiftyEntry.tsx'
import { FiftyFiftyScreen } from './FiftyFiftyScreen.tsx'
import { ResumeBanner } from './ResumeBanner.tsx'
import { PART_WAY, refusalWords, roundSymptomCopy } from './words.ts'

afterEach(() => {
  cleanup()
})

function RouteProbe() {
  const { route } = useNav()
  return <output data-testid="route">{route.screen}</output>
}

function setup(
  ui: ReactNode,
  answers: FakeApiAnswers,
  { scan = sampleScan(), route = { screen: 'fifty-fifty' } as Route }: { scan?: Scan | null; route?: Route } = {}
) {
  const api = fakeApi(answers)
  render(
    <ApiProvider value={api}>
      <SessionProvider initialScan={scan}>
        <NavProvider initial={route}>
          {ui}
          <RouteProbe />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
  return { api, user: userEvent.setup() }
}

const ok = (state: FiftyFifty | null): FiftyResult => ({ status: 'ok', state })
const round = (overrides: Partial<FiftyFifty> = {}) =>
  sampleFiftyFifty({ round: 1, roundsAtMost: 3, history: [{ round: 0, parked: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'], answer: 'worked' }], ...overrides })
const controlRound = (overrides: Partial<FiftyFifty> = {}) =>
  sampleFiftyFifty({
    round: 0,
    roundsAtMost: 3,
    parked: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'],
    inMods: [],
    history: [],
    ...overrides
  })
const SESSION = sampleFiftyFifty().id
/** A journal entry of this test session for one group: `status` says whether its files are back. */
const moved = (groupId: string, groupLabel: string, status: JournalEntry['status'], sessionId = SESSION): JournalEntry =>
  sampleJournalEntry({
    id: `j-${groupId}-${sessionId}`,
    action: 'disable-group',
    groupId,
    groupLabel,
    status,
    origin: { by: 'fifty-fifty', sessionId, round: 1 }
  })
/** What fifty:get answers when the progress file is there but cannot be read. */
const damagedGet = (): FiftyGet => ({ status: 'damaged' })
const GAME_OPEN: FiftyResult = { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
const channels = (api: { calls: { channel: string }[] }) => api.calls.map((c) => c.channel)

describe('FiftyFiftyScreen', () => {
  it('explains the test and starts it from the last check-up', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': null,
      'fifty:start': ok(controlRound({ phase: 'close-curseforge' }))
    })
    expect(await screen.findByRole('heading', { name: 'The 50/50 test' })).toBeInTheDocument()
    expect(screen.getByText(/You have/)).toHaveTextContent('You have 2 mod groups, so this takes about 2 rounds.')
    await user.click(screen.getByRole('button', { name: 'Start the 50/50 test' }))
    expect(await screen.findByRole('heading', { name: 'First, close CurseForge' })).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:start'])
  })

  it('asks for a check-up first when there is no scan', async () => {
    const { user } = setup(<FiftyFiftyScreen />, { 'fifty:get': null }, { scan: null })
    await user.click(await screen.findByRole('button', { name: 'Run the check-up' }))
    expect(screen.getByTestId('route')).toHaveTextContent('check-up')
  })

  it('close CurseForge, then control round 0 sets aside all mods and shows what was done', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': controlRound({ phase: 'close-curseforge' }),
      'fifty:begin-round': ok(controlRound())
    })
    await user.click(await screen.findByRole('button', { name: 'CurseForge is closed' }))
    expect(await screen.findByText('Round 1 of about 3 · testing without mods')).toBeInTheDocument()
    expect(screen.getByText('We set aside all 4 mod groups and cleared the cache.')).toBeInTheDocument()
    expect(screen.getByText(/start a/)).toHaveTextContent(
      "Open The Sims 4, start a new test household (don't open your real save), and try the thing that crashed."
    )
    expect(screen.getByText(/Keep CurseForge closed/)).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:begin-round'])
  })

  it('when control round 0 still crashes, tells her mods are unlikely to be the cause and to try Repair in the EA app', async () => {
    const stoppedControl = controlRound({
      phase: 'stopped',
      suspects: [],
      parked: [],
      inMods: [],
      cleared: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'],
      history: [{ round: 0, parked: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'], answer: 'crashed' }]
    })
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': controlRound(),
      'fifty:answer': ok(stoppedControl),
      'journal:list': []
    })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))
    expect(await screen.findByRole('heading', { name: 'Mods are unlikely to be the cause' })).toBeInTheDocument()
    expect(screen.getByText(/EA app/i)).toBeInTheDocument()
    expect(screen.getByText(/Repair/i)).toBeInTheDocument()
    expect(screen.getByText(/All your mods are back in place/i)).toBeInTheDocument()
  })

  it('says so when CurseForge still looks open', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': controlRound({ phase: 'close-curseforge' }),
      'fifty:begin-round': ok(controlRound({ phase: 'close-curseforge' }))
    })
    await user.click(await screen.findByRole('button', { name: 'CurseForge is closed' }))
    expect(await screen.findByText(/CurseForge still looks open/)).toBeInTheDocument()
  })

  it('one task per screen: test first, then the two answers and a quiet not-sure', async () => {
    const answers: string[] = []
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round(),
      'fifty:answer': (req) => {
        answers.push(req.answer)
        return ok(round({ round: 2, suspects: ['dir:hair', 'file:shoes.package'], parked: ['dir:hair'], inMods: ['file:shoes.package'] }))
      }
    })
    expect(await screen.findByRole('button', { name: "I've tested it" })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'It still crashed' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game crash?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No crash, it worked!' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))

    expect(await screen.findByText('Round 3 of about 3 · 2 mod groups left')).toBeInTheDocument()
    expect(screen.getByText('We set aside 1 mod group and cleared the cache.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'Not sure, let me test again' }))
    await screen.findByRole('button', { name: "I've tested it" })
    expect(answers).toEqual(['crashed', 'not-sure'])
  })

  it('sends the round on her screen with the answer', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, { 'fifty:get': round(), 'fifty:answer': ok(round({ round: 2 })) })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))
    await screen.findByText(/Round 3 of about 3/)
    expect(api.calls.find((c) => c.channel === 'fifty:answer')?.req).toEqual({ answer: 'crashed', round: 1 })
  })

  it('says so when an answer was not counted because the mods were not set up for the round', async () => {
    const { user } = setup(<FiftyFiftyScreen />, { 'fifty:get': round(), 'fifty:answer': ok(round({ phase: 'ready-to-test' })) })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'No crash, it worked!' }))
    expect(await screen.findByText(/that answer was not counted/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up round 2' })).toBeEnabled()
  })

  it('locks the answer buttons while an answer is being saved', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round(),
      'fifty:answer': () => new Promise<FiftyResult>(() => {})
    })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'No crash, it worked!' }))
    expect(screen.getByRole('button', { name: 'No crash, it worked!' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'It still crashed' })).toBeDisabled()
  })

  it('a refusal after the answer reads the saved state again and offers Try again', async () => {
    const gets = [round(), round({ round: 2, phase: 'ready-to-test' })]
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': () => gets.shift() ?? round({ round: 2 }),
      'fifty:answer': { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } },
      'fifty:begin-round': ok(round({ round: 2 }))
    })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'No crash, it worked!' }))
    expect(await screen.findByText(/The Sims 4 is still open/)).toBeInTheDocument()
    expect(screen.getByText(/Round 3 of about 3/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: "I've tested it" })).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:answer', 'fifty:get', 'fifty:begin-round'])
  })

  it('retrying a refused control-round crash sends the answer again instead of begin-round', async () => {
    const stoppedControl = controlRound({
      phase: 'stopped',
      suspects: [],
      parked: [],
      inMods: [],
      cleared: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'],
      history: [{ round: 0, parked: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'], answer: 'crashed' }]
    })
    let tries = 0
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': controlRound(),
      'fifty:answer': () => {
        tries += 1
        return tries === 1
          ? { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
          : ok(stoppedControl)
      },
      'journal:list': []
    })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))
    expect(await screen.findByText(/The Sims 4 is still open/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Mods are unlikely to be the cause' })).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:answer', 'fifty:get', 'fifty:answer', 'journal:list'])
  })

  it('gives a close-the-game message for backup game-state-unknown refusals', () => {
    expect(refusalWords({ why: 'backup', reason: 'game-state-unknown' })).toMatch(/Close the game/)
  })

  it('a safety check that could not finish asks her to try again, not to send a report', () => {
    const words = refusalWords({ why: 'gate', refusal: { reason: 'check-failed', path: 'C:\\x' } })
    expect(words).toMatch(/safety check/)
    expect(words).toMatch(/click Try again/)
    expect(words).not.toMatch(/report/)
  })

  it('an action that never started asks her to try again', () => {
    expect(refusalWords({ why: 'not-started' })).toMatch(/click Try again/)
    // A round puts mods back before it sets others aside, so a refusal half way cannot promise nothing moved.
    for (const refusal of [
      { why: 'not-started' },
      { why: 'gate', refusal: { reason: 'check-failed', path: 'x' } },
      { why: 'gate', refusal: { reason: 'no-verified-backup', backup: 'stale' } }
    ] as const) {
      expect(refusalWords(refusal)).not.toMatch(/nothing was moved/)
    }
  })

  it('files that changed during the test point her to stopping, not to a check-up that cannot help', () => {
    const words = refusalWords({ why: 'out-of-date', detail: 'file-changed' })
    expect(words).toMatch(/Stop the test/)
    expect(words).not.toMatch(/nothing was moved/)
    expect(words).not.toMatch(/Run the check-up again/)
  })

  it('a half-done move also says where to put the mods back', () => {
    expect(PART_WAY).toMatch(/History/)
  })

  it('a round that is saved but not set up has its own button', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ round: 2, phase: 'ready-to-test' }),
      'fifty:begin-round': ok(round({ round: 2 }))
    })
    await user.click(await screen.findByRole('button', { name: 'Set up round 3' }))
    await screen.findByRole('button', { name: "I've tested it" })
    expect(channels(api)).toContain('fifty:begin-round')
  })

  it('a half-done move says so and Try again finishes it', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ phase: 'close-curseforge' }),
      'fifty:begin-round': { status: 'stopped-part-way', state: round({ phase: 'ready-to-test' }), detail: 'x' }
    })
    await user.click(await screen.findByRole('button', { name: 'CurseForge is closed' }))
    expect(await screen.findByText(/Some mods were moved but not all/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  const found = round({
    phase: 'found',
    round: 2,
    suspects: ['dir:hair'],
    parked: ['dir:hair'],
    inMods: [],
    culprit: 'dir:hair',
    cleared: ['cf:901234', 'dir:buildbuy', 'file:shoes.package'],
    history: [
      { round: 0, parked: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'], answer: 'worked' },
      { round: 1, parked: ['cf:901234', 'dir:buildbuy'], answer: 'crashed' },
      { round: 2, parked: ['dir:hair'], answer: 'worked' }
    ]
  })

  const uncertainFound = round({
    phase: 'found',
    round: 2,
    suspects: ['dir:hair'],
    parked: ['dir:hair'],
    inMods: [],
    culprit: 'dir:hair',
    cleared: ['cf:901234', 'dir:buildbuy', 'file:shoes.package'],
    history: [
      { round: 0, parked: ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package'], answer: 'worked' },
      { round: 1, parked: ['cf:901234', 'dir:buildbuy'], answer: 'crashed' },
      { round: 2, parked: ['file:shoes.package'], answer: 'not-sure' },
      { round: 2, parked: ['file:shoes.package'], answer: 'crashed' }
    ]
  })

  it('names the group as most likely, explains other mods are already back, and keeps it set aside', async () => {
    const finishes: string[] = []
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'fifty:finish': (req) => {
        finishes.push(req.keep)
        return ok({ ...found, phase: 'stopped' })
      },
      'journal:list': [moved('dir:hair', 'Hair', 'done'), moved('cf:901234', 'Wicked Wardrobe', 'undone')]
    })
    expect(await screen.findByRole('heading', { name: 'We found the most likely cause' })).toBeInTheDocument()
    expect(screen.getByText(/Hair/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/most likely/i, { selector: 'p' })).toBeInTheDocument()
    expect(await screen.findByText(/already put your other mods back and left Hair set aside/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open History' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep Hair set aside' }))
    expect(await screen.findByText(/Hair is set aside\. Everything else is back in your Mods folder/)).toBeInTheDocument()
    expect(finishes).toEqual(['keep-set-aside'])
  })

  it('shows a final setup step if arranging the culprit was interrupted', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': { ...found, phase: 'ready-to-test' },
      'fifty:begin-round': ok(found)
    })
    expect(await screen.findByRole('heading', { name: 'Finish setting up your mods' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Put the other mods back' }))
    expect(await screen.findByRole('heading', { name: 'We found the most likely cause' })).toBeInTheDocument()
    expect(channels(api)).toContain('fifty:begin-round')
  })

  it('or puts everything back', async () => {
    const finishes: string[] = []
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'fifty:finish': (req) => {
        finishes.push(req.keep)
        return ok({ ...found, phase: 'stopped', parked: [] })
      },
      'journal:list': []
    })
    await user.click(await screen.findByRole('button', { name: 'Put everything back' }))
    expect(await screen.findByText('All your mods are back in place.')).toBeInTheDocument()
    expect(finishes).toEqual(['put-back'])
  })

  it('stopping asks once, then puts everything back', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round(),
      'fifty:stop': ok({ ...round(), phase: 'stopped', parked: [] }),
      // Not this session's, hers, already back, or a cache clear: none of these is a mod the test left out.
      'journal:list': [
        moved('dir:hair', 'Hair', 'undone'),
        moved('dir:old', 'Old test', 'needs-attention', 'another-session'),
        sampleJournalEntry({ id: 'hers', action: 'disable-group', groupId: 'dir:hers', groupLabel: 'Hers' }),
        sampleJournalEntry({ id: 'cache', action: 'clear-caches', origin: { by: 'fifty-fifty', sessionId: SESSION, round: 1 } })
      ]
    })
    await user.click(await screen.findByRole('button', { name: 'Stop the test' }))
    expect(screen.getByText('Stop the 50/50 test and put all your mods back?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep testing' }))
    expect(channels(api)).not.toContain('fifty:stop')

    await user.click(screen.getByRole('button', { name: 'Stop the test' }))
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByRole('heading', { name: 'The 50/50 test is stopped' })).toBeInTheDocument()
    expect(screen.getByText('All your mods are back in place.')).toBeInTheDocument()
  })

  it('a refused stop closes the question and says why', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round(),
      'fifty:stop': { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
    })
    await user.click(await screen.findByRole('button', { name: 'Stop the test' }))
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByText(/The Sims 4 is still open/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('says the result is uncertain when every split round after the control round crashed', async () => {
    const finishes: string[] = []
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': uncertainFound,
      'fifty:finish': (req) => {
        finishes.push(req.keep)
        return ok({ ...uncertainFound, phase: 'stopped' })
      }
    })
    expect(await screen.findByRole('heading', { name: 'The result is uncertain' })).toBeInTheDocument()
    expect(screen.queryByText(/most likely/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Hair/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/every split round/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep Hair set aside' }))
    expect(finishes).toEqual(['keep-set-aside'])
  })

  it('with one group, passing control round 0 is not uncertain', async () => {
    setup(<FiftyFiftyScreen />, {
      'fifty:get': controlRound({
        phase: 'found',
        culprit: 'dir:hair',
        suspects: ['dir:hair'],
        parked: ['dir:hair'],
        inMods: [],
        history: [{ round: 0, parked: ['dir:hair'], answer: 'worked' }]
      })
    })
    expect(await screen.findByRole('heading', { name: 'We found the most likely cause' })).toBeInTheDocument()
    expect(screen.getByText(/It took 1 round/)).toBeInTheDocument()
  })
})

describe('ResumeBanner', () => {
  const r2 = round({ round: 1, roundsAtMost: 7, suspects: Array.from({ length: 16 }, (_, i) => `g${i}`) })

  it('shows the round and continues to the test', async () => {
    const { user } = setup(<ResumeBanner />, { 'fifty:get': r2 }, { route: { screen: 'check-up' } })
    expect(await screen.findByText('50/50 test in progress · Round 2 of about 7')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })

  it('puts everything back and stops after asking once', async () => {
    const { api, user } = setup(
      <ResumeBanner />,
      { 'fifty:get': r2, 'fifty:stop': ok({ ...r2, phase: 'stopped' }), 'journal:list': [] },
      { route: { screen: 'about' } }
    )
    await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
    expect(screen.getByText('Stop the 50/50 test and put all your mods back?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    await waitFor(() => expect(screen.queryByText(/50\/50 test in progress/)).not.toBeInTheDocument())
    expect(channels(api)).toContain('fifty:stop')
    expect(screen.queryByText(/50\/50/)).not.toBeInTheDocument()
  })

  it('a stop that left a mod out says which one and points to History instead of vanishing', async () => {
    const { user } = setup(
      <ResumeBanner />,
      {
        'fifty:get': r2,
        'fifty:stop': ok({ ...r2, phase: 'stopped' }),
        'journal:list': [moved('dir:hair', 'Hair', 'needs-attention')]
      },
      { route: { screen: 'about' } }
    )
    await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
    await user.click(screen.getAllByRole('button', { name: 'Put everything back and stop' }).at(-1)!)
    expect(await screen.findByText(/not back in your Mods folder yet: Hair\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    expect(screen.getByTestId('route')).toHaveTextContent('history')
  })

  it('a refused or half-done stop never names a Try again button the banner does not have', async () => {
    const refused: FiftyResult = { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
    const partWay: FiftyResult = { status: 'stopped-part-way', state: r2, detail: 'x' }
    for (const [result, says] of [[refused, /The Sims 4 is still open/], [partWay, /Some mods were moved but not all/]] as const) {
      const { user } = setup(<ResumeBanner />, { 'fifty:get': r2, 'fifty:stop': result }, { route: { screen: 'about' } })
      await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
      await user.click(screen.getAllByRole('button', { name: 'Put everything back and stop' }).at(-1)!)
      const problem = await screen.findByText(says)
      expect(problem).not.toHaveTextContent(/Try again/)
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
      cleanup()
    }
  })

  it('shows nothing with no session, on the 50/50 screen, or when the call fails', async () => {
    const a = setup(<ResumeBanner />, { 'fifty:get': null }, { route: { screen: 'about' } })
    await waitFor(() => expect(a.api.calls).toHaveLength(1))
    expect(screen.queryByText(/50\/50 test/)).not.toBeInTheDocument()
    cleanup()

    const b = setup(<ResumeBanner />, { 'fifty:get': r2 }, { route: { screen: 'fifty-fifty' } })
    expect(screen.queryByText(/50\/50 test/)).not.toBeInTheDocument()
    expect(b.api.calls).toHaveLength(0)
    cleanup()

    const c = setup(<ResumeBanner />, { 'fifty:get': () => Promise.reject(new Error('no handler')) }, {
      route: { screen: 'about' }
    })
    await waitFor(() => expect(c.api.calls).toHaveLength(1))
    expect(screen.queryByText(/50\/50 test/)).not.toBeInTheDocument()
  })

  it('renders nothing without an API (the shell test has none)', () => {
    render(
      <NavProvider initial={{ screen: 'about' }}>
        <ResumeBanner />
      </NavProvider>
    )
    expect(screen.queryByText(/50\/50/)).not.toBeInTheDocument()
  })

  it('a found session says the cause was found, or says uncertain when every split round crashed', async () => {
    setup(<ResumeBanner />, { 'fifty:get': round({ phase: 'found', culprit: 'dir:hair' }) }, { route: { screen: 'about' } })
    expect(await screen.findByText('50/50 test: we found the most likely cause')).toBeInTheDocument()
    cleanup()

    setup(
      <ResumeBanner />,
      {
        'fifty:get': round({
          phase: 'found',
          culprit: 'dir:hair',
          history: [
            { round: 0, parked: ['cf:901234', 'dir:hair'], answer: 'worked' },
            { round: 1, parked: ['cf:901234'], answer: 'crashed' }
          ]
        })
      },
      { route: { screen: 'about' } }
    )
    expect(await screen.findByText('50/50 test: result is uncertain')).toBeInTheDocument()
  })
})

describe('FiftyEntry', () => {
  it('is a big button when a finding points to the 50/50 test and includes the control round in the estimate', async () => {
    const scan = sampleScan({ findings: [sampleFinding({ id: 'crash-without-cause', rule: 'crash-without-cause', next: 'fifty-fifty' })] })
    const { user } = setup(<FiftyEntry scan={scan} />, {}, { route: { screen: 'check-up' } })
    expect(screen.getByText(/For your/)).toHaveTextContent(/about 2 rounds/)
    await user.click(screen.getByRole('button', { name: 'Find it with the 50/50 test' }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })

  it('is a small link otherwise', async () => {
    const { user } = setup(<FiftyEntry scan={sampleScan()} />, {}, { route: { screen: 'check-up' } })
    expect(screen.queryByRole('button', { name: 'Find it with the 50/50 test' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Try the 50\/50 test/ }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })

  it('says a new test household may not show a one save problem, in both sizes', () => {
    const big = sampleScan({
      symptom: 'one-save-or-lot',
      findings: [sampleFinding({ id: 'crash-without-cause', rule: 'crash-without-cause', next: 'fifty-fifty' })]
    })
    setup(<FiftyEntry scan={big} />, {}, { route: { screen: 'check-up' } })
    expect(screen.getByText(/new test household may not/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
    cleanup()

    setup(<FiftyEntry scan={sampleScan({ symptom: 'one-save-or-lot' })} />, {}, { route: { screen: 'check-up' } })
    expect(screen.getByText(/new test household may not/i)).toBeInTheDocument()
  })

  it('has no save note for other symptoms', () => {
    setup(<FiftyEntry scan={sampleScan({ symptom: 'closes' })} />, {}, { route: { screen: 'check-up' } })
    expect(screen.queryByText(/new test household may not/i)).not.toBeInTheDocument()
  })
})

describe('TestStep and what happened', () => {
  const REAL_SAVE =
    "Open The Sims 4, start a new test household (don't open your real save), and try the thing that crashed."

  it('one save or lot: a gentle note that she can stop and send a report, and the real-save warning stays', async () => {
    setup(<FiftyFiftyScreen />, { 'fifty:get': round() }, { scan: sampleScan({ symptom: 'one-save-or-lot' }) })
    expect(await screen.findByText(/start a/)).toHaveTextContent(REAL_SAVE)
    const note = screen.getByText(/only happens on one save or lot/i)
    expect(note).toHaveTextContent(/new test household/i)
    expect(note).toHaveTextContent(/Stop the test/)
    expect(note).toHaveTextContent(/send a report to Tyler/i)
    expect(note.textContent).not.toMatch(/open your .*save/i)
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
  })

  it('has no save note for other symptoms', async () => {
    setup(<FiftyFiftyScreen />, { 'fifty:get': round() }, { scan: sampleScan({ symptom: 'closes' }) })
    expect(await screen.findByText(/start a/)).toHaveTextContent(REAL_SAVE)
    expect(screen.queryByText(/only happens on one save or lot/i)).not.toBeInTheDocument()
  })
})

describe('a stop never says every mod is back while one is not', () => {
  const stopped = ok({ ...round(), phase: 'stopped', parked: [] })
  async function stopWith(journal: JournalEntry[] | (() => Promise<JournalEntry[]>)) {
    const made = setup(<FiftyFiftyScreen />, { 'fifty:get': round(), 'fifty:stop': stopped, 'journal:list': journal })
    await made.user.click(await screen.findByRole('button', { name: 'Stop the test' }))
    await made.user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByRole('heading', { name: 'The 50/50 test is stopped' })).toBeInTheDocument()
    return made
  }

  it('names the mods that still need putting back and opens History', async () => {
    const { user } = await stopWith([
      moved('dir:hair', 'Hair', 'needs-attention'),
      moved('cf:901234', 'Wicked Wardrobe', 'in-progress'),
      moved('dir:buildbuy', 'BuildBuy', 'undone')
    ])
    expect(screen.queryByText(/All your mods are back in place/)).not.toBeInTheDocument()
    expect(screen.getByText(/not back in your Mods folder yet: Hair and Wicked Wardrobe\./)).toHaveTextContent(
      /Open History to put them back/
    )
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    expect(screen.getByTestId('route')).toHaveTextContent('history')
  })

  it('a mod of this session that is still set aside counts too', async () => {
    await stopWith([moved('dir:hair', 'Hair', 'done')])
    expect(screen.queryByText(/All your mods are back in place/)).not.toBeInTheDocument()
    expect(screen.getByText(/not back in your Mods folder yet: Hair\./)).toBeInTheDocument()
  })

  it('makes no promise when History cannot be read', async () => {
    await stopWith(() => Promise.reject(new Error('not implemented: journal:list')))
    expect(screen.queryByText(/All your mods are back in place/)).not.toBeInTheDocument()
    expect(screen.getByText(/couldn't check that every mod is back/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open History' })).toBeInTheDocument()
  })

  it('keeping the cause set aside still names another mod that is not back', async () => {
    const found = sampleFiftyFifty({ phase: 'found', culprit: 'dir:hair', parked: ['dir:hair'], suspects: ['dir:hair'] })
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'fifty:finish': ok({ ...found, phase: 'stopped' }),
      'journal:list': [moved('dir:hair', 'Hair', 'done'), moved('cf:901234', 'Wicked Wardrobe', 'needs-attention')]
    })
    await user.click(await screen.findByRole('button', { name: 'Keep Hair set aside' }))
    expect(await screen.findByText(/Hair is set aside\./)).toBeInTheDocument()
    expect(screen.queryByText(/Everything else is back/)).not.toBeInTheDocument()
    expect(screen.getByText(/not back in your Mods folder yet: Wicked Wardrobe\./)).toBeInTheDocument()
  })

  it('a crashed control round does not say all back while one is not', async () => {
    const all = ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package']
    const ended = controlRound({ phase: 'stopped', suspects: [], parked: [], cleared: all, history: [{ round: 0, parked: all, answer: 'crashed' }] })
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': controlRound(),
      'fifty:answer': ok(ended),
      'journal:list': [moved('dir:hair', 'Hair', 'needs-attention')]
    })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))
    expect(await screen.findByRole('heading', { name: 'Mods are unlikely to be the cause' })).toBeInTheDocument()
    expect(screen.queryByText(/All your mods are back in place/)).not.toBeInTheDocument()
    expect(screen.getByText(/not back in your Mods folder yet: Hair\./)).toBeInTheDocument()
  })
})

describe('the found card only says what History shows', () => {
  const found = sampleFiftyFifty({ phase: 'found', culprit: 'dir:hair', parked: ['dir:hair'], suspects: ['dir:hair'] })
  const uncertain = { ...found, history: [{ round: 0, parked: ['dir:hair'], answer: 'worked' as const }, { round: 1, parked: ['cf:901234'], answer: 'crashed' as const }] }
  const CLAIM = /already put your other mods back/i

  it('names another mod of this test that is not back, and opens History', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'journal:list': [moved('dir:hair', 'Hair', 'done'), moved('cf:901234', 'Wicked Wardrobe', 'needs-attention')]
    })
    expect(await screen.findByText(/not back in your Mods folder yet: Wicked Wardrobe\./)).toBeInTheDocument()
    expect(screen.queryByText(CLAIM)).not.toBeInTheDocument()
    expect(screen.getByText(/Hair is set aside, so you can play/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    expect(screen.getByTestId('route')).toHaveTextContent('history')
  })

  it('the uncertain card makes no promise either', async () => {
    setup(<FiftyFiftyScreen />, {
      'fifty:get': uncertain,
      'journal:list': [moved('dir:hair', 'Hair', 'done'), moved('cf:901234', 'Wicked Wardrobe', 'done')]
    })
    expect(await screen.findByRole('heading', { name: 'The result is uncertain' })).toBeInTheDocument()
    expect(await screen.findByText(/not back in your Mods folder yet: Wicked Wardrobe\./)).toBeInTheDocument()
    expect(screen.queryByText(CLAIM)).not.toBeInTheDocument()
  })

  it('makes no promise when History cannot be read, or before it has answered', async () => {
    let answer!: (journal: JournalEntry[]) => void
    setup(<FiftyFiftyScreen />, { 'fifty:get': found, 'journal:list': () => new Promise<JournalEntry[]>((r) => (answer = r)) })
    expect(await screen.findByRole('heading', { name: 'We found the most likely cause' })).toBeInTheDocument()
    expect(screen.queryByText(CLAIM)).not.toBeInTheDocument()
    expect(screen.queryByText(/set aside, so you can play/)).not.toBeInTheDocument()
    answer([moved('dir:hair', 'Hair', 'done')])
    expect(await screen.findByText(CLAIM)).toBeInTheDocument()
    cleanup()

    setup(<FiftyFiftyScreen />, { 'fifty:get': found, 'journal:list': () => Promise.reject(new Error('unreadable')) })
    expect(await screen.findByText(/couldn't check that every mod is back in place/)).toBeInTheDocument()
    expect(screen.queryByText(CLAIM)).not.toBeInTheDocument()
    expect(screen.queryByText(/Hair is set aside/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open History' })).toBeInTheDocument()
  })

  it('a keep that was refused after the cause went back does not say it is set aside', async () => {
    let journal = [moved('dir:hair', 'Hair', 'done')]
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'fifty:finish': () => {
        journal = [moved('dir:hair', 'Hair', 'undone')]
        return GAME_OPEN
      },
      'journal:list': () => journal
    })
    await user.click(await screen.findByRole('button', { name: 'Keep Hair set aside' }))
    expect(await screen.findByText(/The Sims 4 is still open/)).toBeInTheDocument()
    expect(await screen.findByText(/Hair is in your Mods folder right now\./)).toBeInTheDocument()
    expect(screen.queryByText(/left Hair set aside|Hair is set aside/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('a cause whose move is half done is not called set aside or back', async () => {
    setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'journal:list': [moved('dir:hair', 'Hair', 'needs-attention'), moved('cf:901234', 'Wicked Wardrobe', 'done')]
    })
    // The warning shows History has answered, so what follows is about the answer and not the wait for it.
    expect(await screen.findByText(/not back in your Mods folder yet: Wicked Wardrobe\./)).toBeInTheDocument()
    expect(screen.queryByText(/Hair is set aside|Hair is in your Mods folder|left Hair set aside/)).not.toBeInTheDocument()
  })
})

describe('a damaged progress file', () => {
  const TITLE = "The 50/50 test's progress file is damaged"

  it('shows a calm banner with one button that puts everything back, then goes away', async () => {
    let fixed = false
    const { api, user } = setup(
      <ResumeBanner />,
      {
        'fifty:get': () => (fixed ? null : damagedGet()),
        'fifty:stop': () => ((fixed = true), ok(null)),
        'journal:list': []
      },
      { route: { screen: 'about' } }
    )
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
    expect(channels(api)).toEqual(['fifty:get', 'fifty:stop', 'journal:list'])
    expect(screen.queryByText(/50\/50/)).not.toBeInTheDocument()
  })

  it('stays and explains when putting back is refused or does not finish', async () => {
    const failed = () => Promise.reject(new Error('boom'))
    const partWay: FiftyStopResult = { status: 'stopped-part-way', state: null, notBack: ['Hair', 'Wicked Wardrobe'], detail: 'disk hiccup' }
    const noneNamed: FiftyStopResult = { ...partWay, notBack: [] }
    for (const [stop, says] of [
      [GAME_OPEN, /The Sims 4 is still open\. Save and close the game, then click Put everything back and stop again\./],
      [failed, /couldn't finish putting your mods back/],
      // History cannot put mods back while the file is damaged, so the words point at the button, not at History.
      [partWay, /^Some mods are not back in your Mods folder yet: Hair and Wicked Wardrobe\. Wait a moment, then click Put everything back and stop again\.$/],
      [noneNamed, /^We couldn't finish stopping the test\. Wait a moment, then click Put everything back and stop again\.$/]
    ] as const) {
      const { user } = setup(<ResumeBanner />, { 'fifty:get': damagedGet, 'fifty:stop': stop }, { route: { screen: 'about' } })
      await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
      expect(await screen.findByText(says)).toBeInTheDocument()
      expect(screen.getByText(TITLE)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Put everything back and stop' })).toBeEnabled()
      cleanup()
    }
  })

  it('a stop from the banner that finds the file damaged switches to the damaged card and names what is not back', async () => {
    const r2 = round({ phase: 'awaiting-answer' })
    const { user } = setup(
      <ResumeBanner />,
      { 'fifty:get': r2, 'fifty:stop': { status: 'stopped-part-way', state: null, notBack: ['Hair'], detail: 'disk hiccup' } },
      { route: { screen: 'about' } }
    )
    await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(screen.getByText(/not back in your Mods folder yet: Hair\. Wait a moment/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
  })

  it('a stop on the 50/50 screen that finds the file damaged leaves no old notice behind once it is fixed', async () => {
    const gets: FiftyGet[] = [round(), { status: 'damaged' }, null]
    const stops: FiftyStopResult[] = [{ status: 'stopped-part-way', state: null, notBack: ['Hair'], detail: 'disk hiccup' }, ok(null)]
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': () => gets.shift() ?? null,
      'fifty:stop': () => stops.shift()!,
      'journal:list': []
    })
    await user.click(await screen.findByRole('button', { name: 'Stop the test' }))
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByRole('button', { name: 'Start the 50/50 test' })).toBeInTheDocument()
    expect(screen.queryByText(/Some mods were moved but not all/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('names a mod that is still not back after the file is removed', async () => {
    const { user } = setup(
      <ResumeBanner />,
      { 'fifty:get': damagedGet, 'fifty:stop': ok(null), 'journal:list': [moved('dir:hair', 'Hair', 'needs-attention', 'any-session')] },
      { route: { screen: 'about' } }
    )
    await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByText(/not back in your Mods folder yet: Hair\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Put everything back and stop' })).not.toBeInTheDocument()
  })

  it('takes the place of the intro on the 50/50 screen, and the intro comes back once it is fixed', async () => {
    let fixed = false
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': () => (fixed ? null : damagedGet()),
      'fifty:stop': () => ((fixed = true), ok(null)),
      'journal:list': []
    })
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start the 50/50 test' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    expect(await screen.findByRole('button', { name: 'Start the 50/50 test' })).toBeInTheDocument()
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    expect(channels(api)).not.toContain('fifty:start')
  })
})

describe('live move and backup progress', () => {
  it('shows fallback busy copy with a progress bar, updates on backup and moving events, and clears when done', async () => {
    let finishBegin!: (result: FiftyResult) => void
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ phase: 'close-curseforge' }),
      'fifty:begin-round': () => new Promise<FiftyResult>((resolve) => (finishBegin = resolve))
    })

    await user.click(await screen.findByRole('button', { name: 'CurseForge is closed' }))

    // Falls back cleanly to the busy text before any progress event arrives.
    const main = screen.getByRole('main')
    const status = within(main).getByRole('status')
    expect(within(status).getByText('Setting aside mods and clearing the cache…')).toBeInTheDocument()
    expect(within(status).getByRole('progressbar')).toBeInTheDocument()

    // Backup progress events: counting, copying, checking.
    act(() => {
      api.emitProgress({ task: 'backup', stage: 'counting', done: 0, total: null })
    })
    expect(within(status).getByText('Making a safety copy first…')).toBeInTheDocument()
    expect(within(status).getByText('Counting files to protect…')).toBeInTheDocument()

    act(() => {
      api.emitProgress({ task: 'backup', stage: 'copying', done: 1240, total: 5300 })
    })
    expect(within(status).getByText('Making a safety copy first…')).toBeInTheDocument()
    expect(within(status).getByText('Copying 1,240 of 5,300 files')).toBeInTheDocument()
    expect(within(status).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '23')

    act(() => {
      api.emitProgress({ task: 'backup', stage: 'checking', done: 5300, total: 5300 })
    })
    expect(within(status).getByText('Checking 5,300 of 5,300 files')).toBeInTheDocument()
    expect(within(status).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    // Moving mods progress events: live count, clamping, tabular-nums, no em/en dashes.
    act(() => {
      api.emitProgress({ task: 'fix', stage: 'moving', done: 5, total: 16 })
    })
    const movingText = within(status).getByText('Moving mod 5 of 16…')
    expect(movingText).toBeInTheDocument()
    expect(movingText.className).toContain('tabular-nums')
    expect(within(status).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '31')
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    // Clamps done > total.
    act(() => {
      api.emitProgress({ task: 'fix', stage: 'moving', done: 20, total: 16 })
    })
    expect(within(status).getByText('Moving mod 16 of 16…')).toBeInTheDocument()
    expect(within(status).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    // Ignores unrelated tasks.
    act(() => {
      api.emitProgress({ task: 'scan', stage: 'mods', done: 1, total: 2 })
    })
    expect(within(status).getByText('Moving mod 16 of 16…')).toBeInTheDocument()

    // Clears progress when busy finishes.
    await act(async () => {
      finishBegin(ok(round()))
    })
    expect(await screen.findByRole('button', { name: "I've tested it" })).toBeInTheDocument()
    expect(within(main).queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/Moving mod/)).not.toBeInTheDocument()
  })

  it('clears stale progress before a second busy action starts', async () => {
    let finishFirst!: (result: FiftyResult) => void
    let finishSecond!: (result: FiftyResult) => void
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ phase: 'close-curseforge' }),
      'fifty:begin-round': () => new Promise<FiftyResult>((resolve) => (finishFirst = resolve)),
      'fifty:answer': () => new Promise<FiftyResult>((resolve) => (finishSecond = resolve))
    })

    await user.click(await screen.findByRole('button', { name: 'CurseForge is closed' }))
    act(() => {
      api.emitProgress({ task: 'fix', stage: 'moving', done: 8, total: 8 })
    })
    expect(screen.getByText('Moving mod 8 of 8…')).toBeInTheDocument()

    await act(async () => {
      finishFirst(ok(round()))
    })
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'No crash, it worked!' }))

    expect(screen.getByText('Getting the next round ready…')).toBeInTheDocument()
    expect(screen.queryByText('Moving mod 8 of 8…')).not.toBeInTheDocument()

    await act(async () => {
      finishSecond(ok(round({ round: 2 })))
    })
    expect(await screen.findByText(/Round 3 of about 3/)).toBeInTheDocument()
  })
})

describe('symptom-tailored round prompts and answers', () => {
  function scriptedRounds(answers: FiftyAnswer[]) {
    return (req: { answer: FiftyAnswer; round: number }): FiftyResult => {
      answers.push(req.answer)
      if (req.round === 0) return ok(round())
      if (req.answer === 'not-sure') return ok(round())
      return ok(round({ round: 2, suspects: ['cf:901234', 'dir:buildbuy'], parked: ['cf:901234'], inMods: ['dir:buildbuy'] }))
    }
  }

  it('tailors TestStep and AnswerStep for freezes while sending exact IPC answers and keeping the real-save warning', async () => {
    const answers: FiftyAnswer[] = []
    const { user } = setup(
      <FiftyFiftyScreen />,
      { 'fifty:get': controlRound(), 'fifty:answer': scriptedRounds(answers) },
      { scan: sampleScan({ symptom: 'freezes' }) }
    )

    const controlPrompt = await screen.findByText(/Open The Sims 4, start a/)
    expect(controlPrompt).toHaveTextContent(
      "Open The Sims 4, start a new test household (don't open your real save), and try the thing that froze or got stuck."
    )
    expect(within(controlPrompt).getByText('new', { selector: 'strong' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game freeze without mods?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'It still froze' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: 'It worked fine' }))
    expect(await screen.findByText('Round 2 of about 3 · 4 mod groups left')).toBeInTheDocument()

    expect(screen.getByText(/Open The Sims 4, start a/)).toHaveTextContent(
      "Open The Sims 4, start a new test household (don't open your real save), and try the thing that froze or got stuck."
    )
    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game freeze or get stuck?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Not sure, let me test again' }))
    await screen.findByRole('button', { name: "I've tested it" })

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still froze' }))
    expect(await screen.findByText('Round 3 of about 3 · 2 mod groups left')).toBeInTheDocument()
    expect(answers).toEqual(['worked', 'not-sure', 'crashed'])
  })

  it('tailors TestStep and AnswerStep for wont-load while sending exact IPC answers and keeping the real-save warning', async () => {
    const answers: FiftyAnswer[] = []
    const { user } = setup(
      <FiftyFiftyScreen />,
      { 'fifty:get': controlRound(), 'fifty:answer': scriptedRounds(answers) },
      { scan: sampleScan({ symptom: 'wont-load' }) }
    )

    const controlPrompt = await screen.findByText(/loads past the start screen/)
    expect(controlPrompt).toHaveTextContent(
      "Open The Sims 4 and see if it loads past the start screen into a new test household (don't open your real save)."
    )
    expect(within(controlPrompt).getByText('new', { selector: 'strong' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game fail to open without mods?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "It still wouldn't open" })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: 'It loaded fine' }))
    expect(await screen.findByText('Round 2 of about 3 · 4 mod groups left')).toBeInTheDocument()

    expect(screen.getByText(/loads past the start screen/)).toHaveTextContent(
      "Open The Sims 4 and see if it loads past the start screen into a new test household (don't open your real save)."
    )
    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game fail to open?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Not sure, let me test again' }))
    await screen.findByRole('button', { name: "I've tested it" })

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: "It still wouldn't open" }))
    expect(await screen.findByText('Round 3 of about 3 · 2 mod groups left')).toBeInTheDocument()
    expect(answers).toEqual(['worked', 'not-sure', 'crashed'])
  })

  it('keeps the exact crash wording and IPC answers for closes', async () => {
    const answers: FiftyAnswer[] = []
    const { user } = setup(
      <FiftyFiftyScreen />,
      { 'fifty:get': controlRound(), 'fifty:answer': scriptedRounds(answers) },
      { scan: sampleScan({ symptom: 'closes' }) }
    )

    expect(await screen.findByText(/Open The Sims 4, start a/)).toHaveTextContent(
      "Open The Sims 4, start a new test household (don't open your real save), and try the thing that crashed."
    )
    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game crash without mods?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'No crash, it worked!' }))

    expect(await screen.findByText('Round 2 of about 3 · 4 mod groups left')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game crash?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Not sure, let me test again' }))
    await screen.findByRole('button', { name: "I've tested it" })

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))
    expect(await screen.findByText('Round 3 of about 3 · 2 mod groups left')).toBeInTheDocument()
    expect(answers).toEqual(['worked', 'not-sure', 'crashed'])
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
  })

  it('uses the safe fallback and preserves the real-save warning when resuming a session with no scan in memory', async () => {
    const answers: FiftyAnswer[] = []
    const { user } = setup(
      <FiftyFiftyScreen />,
      { 'fifty:get': controlRound(), 'fifty:answer': scriptedRounds(answers) },
      { scan: null }
    )

    expect(await screen.findByText(/Open The Sims 4, start a/)).toHaveTextContent(
      "Open The Sims 4, start a new test household (don't open your real save), and try the thing that crashed."
    )
    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game crash without mods?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'No crash, it worked!' }))

    expect(await screen.findByText('Round 2 of about 3 · 4 mod groups left')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    expect(screen.getByRole('heading', { name: 'Did the game crash?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Not sure, let me test again' }))
    await screen.findByRole('button', { name: "I've tested it" })

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still crashed' }))
    expect(await screen.findByText('Round 3 of about 3 · 2 mod groups left')).toBeInTheDocument()
    expect(answers).toEqual(['worked', 'not-sure', 'crashed'])
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
  })

  it('roundSymptomCopy keeps the real-save warning and avoids em or en dashes across every symptom', () => {
    for (const symptom of [undefined, 'closes', 'freezes', 'wont-load', 'one-save-or-lot', 'not-sure'] as const) {
      for (const control of [true, false]) {
        const copy = roundSymptomCopy(symptom, control)
        expect(copy.testPrompt).toContain("(don't open your real save)")
        expect(`${copy.testBeforeNew}new${copy.testAfterNew}`).toBe(copy.testPrompt)
        for (const text of [copy.testPrompt, copy.answerHeading, copy.crashedLabel, copy.workedLabel, copy.notSureLabel]) {
          expect(text).not.toMatch(/[\u2014\u2013]/)
        }
      }
    }
  })
})

describe('direct Send a report to Tyler button on the Ended card', () => {
  it('navigates straight to send-to-tyler from the stopped Ended card', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round(),
      'fifty:stop': ok({ ...round(), phase: 'stopped', parked: [] }),
      'journal:list': []
    })
    await user.click(await screen.findByRole('button', { name: 'Stop the test' }))
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))

    expect(await screen.findByRole('heading', { name: 'The 50/50 test is stopped' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: 'Send a report to Tyler' }))
    expect(screen.getByTestId('route')).toHaveTextContent('send-to-tyler')
  })

  it('navigates straight to send-to-tyler from the not-mods Ended card', async () => {
    const all = ['cf:901234', 'dir:hair', 'dir:buildbuy', 'file:shoes.package']
    const stoppedControl = controlRound({
      phase: 'stopped',
      suspects: [],
      parked: [],
      inMods: [],
      cleared: all,
      history: [{ round: 0, parked: all, answer: 'crashed' }]
    })
    const { user } = setup(
      <FiftyFiftyScreen />,
      {
        'fifty:get': controlRound(),
        'fifty:answer': ok(stoppedControl),
        'journal:list': []
      },
      { scan: sampleScan({ symptom: 'freezes' }) }
    )
    await user.click(await screen.findByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'It still froze' }))

    expect(await screen.findByRole('heading', { name: 'Mods are unlikely to be the cause' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: 'Send a report to Tyler' }))
    expect(screen.getByTestId('route')).toHaveTextContent('send-to-tyler')
  })

  it('keeps the All done card clean when finishing after finding a culprit', async () => {
    const foundSession = sampleFiftyFifty({ phase: 'found', culprit: 'dir:hair', parked: ['dir:hair'], suspects: ['dir:hair'] })
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': foundSession,
      'fifty:finish': ok({ ...foundSession, phase: 'stopped' }),
      'journal:list': [moved('dir:hair', 'Hair', 'done')]
    })
    await user.click(await screen.findByRole('button', { name: 'Keep Hair set aside' }))

    expect(await screen.findByRole('heading', { name: 'All done' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send a report to Tyler' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
  })
})
