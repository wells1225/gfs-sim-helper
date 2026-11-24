import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi } from '../testing/fake-api.ts'
import { PickFolder } from './PickFolder.tsx'

afterEach(() => {
  cleanup()
})

function Harness() {
  const { route } = useNav()
  return (
    <div>
      <PickFolder />
      <output data-testid="route">{route.screen}</output>
    </div>
  )
}

describe('PickFolder', () => {
  it('shows each folder with its path and last used date, marks the newest, and saves selection', async () => {
    const user = userEvent.setup()
    const newest = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'
    const older = 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4'

    const api = fakeApi({
      'locate:run': {
        folders: [
          { path: older, inOneDrive: true, newestFileAt: new Date('2026-09-12T12:00:00.000Z') },
          { path: newest, inOneDrive: false, newestFileAt: new Date('2026-11-23T22:15:00.000Z') }
        ],
        game: null,
        gameRunning: 'not-running'
      },
      'settings:update': { welcome: 'seen', folderPath: newest }
    })

    render(
      <ApiProvider value={api}>
        <SessionProvider>
          <NavProvider initial={{ screen: 'pick-folder' }}>
            <Harness />
          </NavProvider>
        </SessionProvider>
      </ApiProvider>
    )

    expect(await screen.findByText(newest)).toBeInTheDocument()
    expect(screen.getByText(older)).toBeInTheDocument()
    expect(screen.getByText(/most recently used/i)).toBeInTheDocument()
    expect(screen.getAllByText(/last used/i)).toHaveLength(2)

    const buttons = screen.getAllByRole('button', { name: /use this folder/i })
    await user.click(buttons[0]!)

    expect(await screen.findByText('what-happened')).toBeInTheDocument()
    expect(api.calls.find((c) => c.channel === 'settings:update')?.req).toEqual({ folderPath: newest })
  })

  it('shows a plain message and guidance when no Sims folder is found', async () => {
    const api = fakeApi({
      'locate:run': {
        folders: [],
        game: null,
        gameRunning: 'not-running'
      }
    })

    render(
      <ApiProvider value={api}>
        <SessionProvider>
          <NavProvider initial={{ screen: 'pick-folder' }}>
            <Harness />
          </NavProvider>
        </SessionProvider>
      </ApiProvider>
    )

    expect(await screen.findByText(/couldn't find your sims 4 folder/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Options\.ini/i).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /look again/i })).toBeInTheDocument()
  })
})
