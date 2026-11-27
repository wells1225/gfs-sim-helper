import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { fakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { PatchGuardBanner } from './PatchGuardBanner.tsx'

afterEach(() => {
  cleanup()
})

function Route() {
  const { route } = useNav()
  return <output data-testid="route">{route.screen}</output>
}

function renderBanner(answers: FakeApiAnswers = {}) {
  const api = fakeApi(answers)
  render(
    <ApiProvider value={api}>
      <NavProvider initial={{ screen: 'what-happened' }}>
        <PatchGuardBanner />
        <Route />
      </NavProvider>
    </ApiProvider>
  )
  return api
}

describe('PatchGuardBanner', () => {
  it('renders nothing when the game version did not change', async () => {
    const api = renderBanner({
      'patchguard:watch': {
        current: '1.129.39.1030',
        lastSeen: '1.129.39.1030',
        changed: false,
        seenAt: '2026-11-20T10:00:00.000Z'
      }
    })
    await Promise.resolve()
    expect(screen.queryByText(/The Sims 4 updated/)).not.toBeInTheDocument()
    expect(api.calls.map((c) => c.channel)).toEqual(['patchguard:watch'])
  })

  it('shows the update banner with Get ready and Not now, and never calls patchguard:seen on Not now', async () => {
    const user = userEvent.setup()
    const api = renderBanner({
      'patchguard:watch': {
        current: '1.130.12.1020',
        lastSeen: '1.129.39.1030',
        changed: true,
        seenAt: '2026-11-20T10:00:00.000Z'
      }
    })

    expect(
      await screen.findByText(/The Sims 4 updated \(1\.129\.39\.1030 .* 1\.130\.12\.1020\)\. Script mods often break after an update\./)
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText(/The Sims 4 updated/)).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.channel === 'patchguard:seen')).toHaveLength(0)
  })

  it('navigates to patch-day when Get ready is clicked', async () => {
    const user = userEvent.setup()
    renderBanner({
      'patchguard:watch': {
        current: '1.130.12.1020',
        lastSeen: '1.129.39.1030',
        changed: true,
        seenAt: '2026-11-20T10:00:00.000Z'
      }
    })

    await user.click(await screen.findByRole('button', { name: 'Get ready' }))
    expect(screen.getByTestId('route')).toHaveTextContent('patch-day')
  })
})
