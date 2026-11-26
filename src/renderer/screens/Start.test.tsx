import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { Start } from './Start.tsx'

afterEach(() => {
  cleanup()
})

function RouteProbe() {
  const { route } = useNav()
  return (
    <div>
      <Start />
      <output data-testid="route">{route.screen}</output>
    </div>
  )
}

function renderStart(answers: FakeApiAnswers) {
  const api = fakeApi(answers)
  render(
    <ApiProvider value={api}>
      <SessionProvider>
        <NavProvider initial={{ screen: 'start' }}>
          <RouteProbe />
        </NavProvider>
      </SessionProvider>
    </ApiProvider>
  )
  return api
}

describe('Start', () => {
  it('needs the API and has no quiet fallback to About without it', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() =>
        render(
          <SessionProvider>
            <NavProvider initial={{ screen: 'start' }}>
              <RouteProbe />
            </NavProvider>
          </SessionProvider>
        )
      ).toThrow(/SimsHelperApi is not available/)
    } finally {
      quiet.mockRestore()
    }
  })

  it('goes to welcome when welcome has not been seen', async () => {
    renderStart({
      'settings:get': { welcome: 'not-seen', folderPath: null }
    })
    expect(await screen.findByText('welcome')).toBeInTheDocument()
  })

  it('goes to pick-folder when welcome is seen, no folder is chosen, and locate finds multiple folders', async () => {
    renderStart({
      'settings:get': { welcome: 'seen', folderPath: null },
      'locate:run': {
        folders: [
          { path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: false, newestFileAt: new Date('2026-11-23T00:00:00.000Z') },
          { path: 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: true, newestFileAt: new Date('2026-10-01T00:00:00.000Z') }
        ],
        game: null,
        gameRunning: 'not-running'
      }
    })
    expect(await screen.findByText('pick-folder')).toBeInTheDocument()
  })

  it('goes to what-happened when welcome is seen and locate finds a single folder', async () => {
    renderStart({
      'settings:get': { welcome: 'seen', folderPath: null },
      'locate:run': {
        folders: [
          { path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: false, newestFileAt: new Date('2026-11-23T00:00:00.000Z') }
        ],
        game: null,
        gameRunning: 'not-running'
      }
    })
    expect(await screen.findByText('what-happened')).toBeInTheDocument()
  })

  it('goes to what-happened when welcome is seen and a folder is already chosen', async () => {
    renderStart({
      'settings:get': { welcome: 'seen', folderPath: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4' }
    })
    expect(await screen.findByText('what-happened')).toBeInTheDocument()
  })
})
