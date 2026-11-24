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
    expect(screen.getAllByText(/^Last used:/)).toHaveLength(2)

    const buttons = screen.getAllByRole('button', { name: /use this folder/i })
    await user.click(buttons[0]!)

    expect(await screen.findByText('what-happened')).toBeInTheDocument()
    expect(api.calls.find((c) => c.channel === 'settings:update')?.req).toEqual({ folderPath: newest })
  })

  it('says plainly when a folder could not be saved, without pointing at a missing button', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'locate:run': {
        folders: [
          { path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: false, newestFileAt: new Date('2026-11-23T22:15:00.000Z') },
          { path: 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: true, newestFileAt: new Date('2026-09-12T12:00:00.000Z') }
        ],
        game: null,
        gameRunning: 'not-running'
      },
      'settings:update': () => Promise.reject(new Error('Could not save settings: check-failed'))
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

    expect(await screen.findByText(/more than one Sims 4 folder/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /use this folder/i })[0]!)

    expect(await screen.findByText(/couldn't pick that folder/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/check-failed|Could not save settings/)
    expect(screen.queryByRole('button', { name: /look again/i })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/look again/i)
  })

  it('gives each "Use this folder" button its own name, even when two folders were last used the same day', async () => {
    const sameDay = new Date('2026-11-23T22:15:00.000Z')
    const api = fakeApi({
      'locate:run': {
        folders: [
          { path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: false, newestFileAt: sameDay },
          { path: 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: true, newestFileAt: sameDay }
        ],
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

    await screen.findByText(/more than one Sims 4 folder/)
    const buttons = screen.getAllByRole('button', { name: /^Use this folder/ })
    expect(buttons).toHaveLength(2)
    const names = buttons.map((button) => button.textContent ?? '')
    expect(new Set(names).size).toBe(2)
    for (const name of names) {
      expect(name).toMatch(/last used Nov 23, 2026/)
    }
    expect(screen.getByRole('button', { name: /^Use this folder.*1 of 2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Use this folder.*2 of 2/ })).toBeInTheDocument()
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
