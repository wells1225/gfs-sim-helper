import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FiftyFifty, FiftyResult, Scan } from '../../shared/model.ts'
import { sampleFiftyFifty, sampleFinding, sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav, type Route } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { FiftyEntry } from './FiftyEntry.tsx'
import { FiftyFiftyScreen } from './FiftyFiftyScreen.tsx'
import { ResumeBanner } from './ResumeBanner.tsx'

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
const round = (overrides: Partial<FiftyFifty> = {}) => sampleFiftyFifty(overrides)
const channels = (api: { calls: { channel: string }[] }) => api.calls.map((c) => c.channel)

describe('FiftyFiftyScreen', () => {
  it('explains the test and starts it from the last check-up', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': null,
      'fifty:start': ok(round({ phase: 'close-curseforge' }))
    })
    expect(await screen.findByRole('heading', { name: 'The 50/50 test' })).toBeInTheDocument()
    expect(screen.getByText(/You have/)).toHaveTextContent('You have 2 mod groups, so this takes about 1 round.')
    await user.click(screen.getByRole('button', { name: 'Start the 50/50 test' }))
    expect(await screen.findByRole('heading', { name: 'First, close CurseForge' })).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:start'])
  })

  it('asks for a check-up first when there is no scan', async () => {
    const { user } = setup(<FiftyFiftyScreen />, { 'fifty:get': null }, { scan: null })
    await user.click(await screen.findByRole('button', { name: 'Run the check-up' }))
    expect(screen.getByTestId('route')).toHaveTextContent('check-up')
  })

  it('close CurseForge, then the round is set up and the test card shows what was done', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ phase: 'close-curseforge' }),
      'fifty:begin-round': ok(round())
    })
    await user.click(await screen.findByRole('button', { name: 'CurseForge is closed' }))
    expect(await screen.findByText('Round 1 of about 2 · 4 mod groups left')).toBeInTheDocument()
    expect(screen.getByText('We set aside 2 mod groups and cleared the cache.')).toBeInTheDocument()
    expect(screen.getByText(/start a/)).toHaveTextContent(
      "Open The Sims 4, start a new test household (don't open your real save), and try the thing that crashed."
    )
    expect(screen.getByText(/Keep CurseForge closed/)).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:begin-round'])
  })

  it('says so when CurseForge still looks open', async () => {
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ phase: 'close-curseforge' }),
      'fifty:begin-round': ok(round({ phase: 'close-curseforge' }))
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

    expect(await screen.findByText('Round 2 of about 2 · 2 mod groups left')).toBeInTheDocument()
    expect(screen.getByText('We set aside 1 mod group and cleared the cache.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: "I've tested it" }))
    await user.click(screen.getByRole('button', { name: 'Not sure, let me test again' }))
    await screen.findByRole('button', { name: "I've tested it" })
    expect(answers).toEqual(['crashed', 'not-sure'])
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
    expect(screen.getByText(/Round 2 of about 2/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: "I've tested it" })).toBeInTheDocument()
    expect(channels(api)).toEqual(['fifty:get', 'fifty:answer', 'fifty:get', 'fifty:begin-round'])
  })

  it('a round that is saved but not set up has its own button', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round({ round: 2, phase: 'ready-to-test' }),
      'fifty:begin-round': ok(round({ round: 2 }))
    })
    await user.click(await screen.findByRole('button', { name: 'Set up round 2' }))
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
    cleared: ['cf:901234', 'dir:buildbuy', 'file:shoes.package']
  })

  it('names the group as most likely and keeps it set aside', async () => {
    const finishes: string[] = []
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'fifty:finish': (req) => {
        finishes.push(req.keep)
        return ok({ ...found, phase: 'stopped' })
      }
    })
    expect(await screen.findByRole('heading', { name: 'We found the most likely cause' })).toBeInTheDocument()
    expect(screen.getByText(/Hair/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/most likely/i, { selector: 'p' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep Hair set aside and put everything else back' }))
    expect(await screen.findByText(/Hair is set aside/)).toBeInTheDocument()
    expect(finishes).toEqual(['keep-set-aside'])
  })

  it('or puts everything back', async () => {
    const finishes: string[] = []
    const { user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': found,
      'fifty:finish': (req) => {
        finishes.push(req.keep)
        return ok({ ...found, phase: 'stopped', parked: [] })
      }
    })
    await user.click(await screen.findByRole('button', { name: 'Put everything back' }))
    expect(await screen.findByText('All your mods are back in place.')).toBeInTheDocument()
    expect(finishes).toEqual(['put-back'])
  })

  it('stopping asks once, then puts everything back', async () => {
    const { api, user } = setup(<FiftyFiftyScreen />, {
      'fifty:get': round(),
      'fifty:stop': ok({ ...round(), phase: 'stopped', parked: [] })
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
})

describe('ResumeBanner', () => {
  const r2 = round({ round: 2, roundsAtMost: 6, suspects: Array.from({ length: 16 }, (_, i) => `g${i}`) })

  it('shows the round and continues to the test', async () => {
    const { user } = setup(<ResumeBanner />, { 'fifty:get': r2 }, { route: { screen: 'check-up' } })
    expect(await screen.findByText('50/50 test in progress · Round 2 of about 6')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })

  it('puts everything back and stops after asking once', async () => {
    const { api, user } = setup(
      <ResumeBanner />,
      { 'fifty:get': r2, 'fifty:stop': ok({ ...r2, phase: 'stopped' }) },
      { route: { screen: 'about' } }
    )
    await user.click(await screen.findByRole('button', { name: 'Put everything back and stop' }))
    expect(screen.getByText('Stop the 50/50 test and put all your mods back?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Put everything back and stop' }))
    await waitFor(() => expect(screen.queryByText(/50\/50 test in progress/)).not.toBeInTheDocument())
    expect(channels(api)).toContain('fifty:stop')
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

  it('a found session says the cause was found', async () => {
    setup(<ResumeBanner />, { 'fifty:get': round({ phase: 'found', culprit: 'dir:hair' }) }, { route: { screen: 'about' } })
    expect(await screen.findByText('50/50 test: we found the most likely cause')).toBeInTheDocument()
  })
})

describe('FiftyEntry', () => {
  it('is a big button when a finding points to the 50/50 test', async () => {
    const scan = sampleScan({ findings: [sampleFinding({ id: 'crash-without-cause', rule: 'crash-without-cause', next: 'fifty-fifty' })] })
    const { user } = setup(<FiftyEntry scan={scan} />, {}, { route: { screen: 'check-up' } })
    await user.click(screen.getByRole('button', { name: 'Find it with the 50/50 test' }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })

  it('is a small link otherwise', async () => {
    const { user } = setup(<FiftyEntry scan={sampleScan()} />, {}, { route: { screen: 'check-up' } })
    expect(screen.queryByRole('button', { name: 'Find it with the 50/50 test' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Try the 50\/50 test/ }))
    expect(screen.getByTestId('route')).toHaveTextContent('fifty-fifty')
  })
})
