import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi } from '../testing/fake-api.ts'
import { Welcome } from './Welcome.tsx'

afterEach(() => {
  cleanup()
})

function Harness() {
  const { route } = useNav()
  return (
    <div>
      <Welcome />
      <output data-testid="route">{route.screen}</output>
    </div>
  )
}

describe('Welcome', () => {
  it('greets Lila with Tyler note and advances after saving welcome seen', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'settings:update': { welcome: 'seen', folderPath: null },
      'locate:run': {
        folders: [
          {
            path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4',
            inOneDrive: false,
            newestFileAt: new Date('2026-11-23T22:15:00.000Z')
          }
        ],
        game: null,
        gameRunning: 'not-running'
      }
    })

    render(
      <ApiProvider value={api}>
        <SessionProvider>
          <NavProvider initial={{ screen: 'welcome' }}>
            <Harness />
          </NavProvider>
        </SessionProvider>
      </ApiProvider>
    )

    expect(
      screen.getByText("Hi Lila! Tyler made this so your game can stop crashing. Let's take a look at your mods.")
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /let's take a look/i }))

    expect(await screen.findByText('what-happened')).toBeInTheDocument()
    expect(api.calls.find((c) => c.channel === 'settings:update')?.req).toEqual({ welcome: 'seen' })
  })

  it('routes to pick-folder when more than one Sims folder exists', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'settings:update': { welcome: 'seen', folderPath: null },
      'locate:run': {
        folders: [
          { path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: false, newestFileAt: new Date('2026-11-23T00:00:00.000Z') },
          { path: 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: true, newestFileAt: new Date('2026-10-01T00:00:00.000Z') }
        ],
        game: null,
        gameRunning: 'not-running'
      }
    })

    render(
      <ApiProvider value={api}>
        <SessionProvider>
          <NavProvider initial={{ screen: 'welcome' }}>
            <Harness />
          </NavProvider>
        </SessionProvider>
      </ApiProvider>
    )

    await user.click(screen.getByRole('button', { name: /let's take a look/i }))
    expect(await screen.findByText('pick-folder')).toBeInTheDocument()
  })
})
