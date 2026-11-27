import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { fakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { PatchGuardBanner } from './PatchGuardBanner.tsx'
import { PlayButton } from './PlayButton.tsx'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function Route() {
  const { route } = useNav()
  return <output data-testid="route">{route.screen}</output>
}

function renderPlay(answers: FakeApiAnswers = {}, withBanner = true) {
  const api = fakeApi(answers)
  render(
    <ApiProvider value={api}>
      <NavProvider initial={{ screen: 'what-happened' }}>
        <PlayButton />
        {withBanner && <PatchGuardBanner />}
        <Route />
      </NavProvider>
    </ApiProvider>
  )
  return api
}

describe('PlayButton', () => {
  it('navigates to patch-day when play stops because the game updated', async () => {
    const user = userEvent.setup()
    const api = renderPlay({
      'patchguard:play': {
        kind: 'stopped',
        why: 'game-updated',
        watch: {
          current: '1.130.12.1020',
          lastSeen: '1.129.39.1030',
          changed: true,
          seenAt: '2026-11-20T10:00:00.000Z'
        }
      }
    })

    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(api.calls.find((c) => c.channel === 'patchguard:play')?.req).toEqual({ ignoreUpdate: false })
    expect(screen.getByTestId('route')).toHaveTextContent('patch-day')
  })

  it('shows plain-language messages when play is refused (already-running, no-install, error)', async () => {
    const user = userEvent.setup()
    renderPlay({
      'patchguard:play': { kind: 'refused', why: 'already-running' }
    })

    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByText(/The Sims 4 is already open/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)
    cleanup()

    renderPlay({
      'patchguard:play': { kind: 'refused', why: 'no-install' }
    })
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByText(/couldn't find The Sims 4/i)).toBeInTheDocument()
    cleanup()

    renderPlay({
      'patchguard:play': { kind: 'refused', why: 'error' }
    })
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByText(/open the EA app, then press Play again/i)).toBeInTheDocument()
  })

  it('checks game:check 60 seconds after started and shows the EA app hint when still not running', async () => {
    vi.useFakeTimers()
    const api = renderPlay({
      'patchguard:play': { kind: 'started' },
      'game:check': 'not-running'
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      await Promise.resolve()
    })
    expect(screen.queryByText("If the game didn't open, open the EA app, then press Play again.")).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(api.calls.filter((c) => c.channel === 'game:check')).toHaveLength(1)
    expect(screen.getByText("If the game didn't open, open the EA app, then press Play again.")).toBeInTheDocument()
  })

  it('stays quiet after 60 seconds when game:check reports running', async () => {
    vi.useFakeTimers()
    const api = renderPlay({
      'patchguard:play': { kind: 'started' },
      'game:check': 'running'
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      await Promise.resolve()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(api.calls.filter((c) => c.channel === 'game:check')).toHaveLength(1)
    expect(screen.queryByText("If the game didn't open, open the EA app, then press Play again.")).not.toBeInTheDocument()
  })
})
