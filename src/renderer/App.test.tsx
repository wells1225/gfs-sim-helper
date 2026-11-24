import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_TITLE } from '../shared/app.ts'
import { ApiProvider } from './api.tsx'
import { App } from './App.tsx'
import { FIXES_READY } from './fixes/feature.ts'
import type { Route } from './nav.tsx'
import { fakeApi } from './testing/fake-api.ts'

const FOOTER = 'Saves and Tray are never touched · A backup is made before any change'
const SIMS_FOLDER = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'

afterEach(() => {
  cleanup()
})

// A first run: welcome not seen, no folder chosen, one Sims folder found, nothing backed up or set aside yet.
function firstRunApi() {
  return fakeApi({
    'settings:get': { welcome: 'not-seen', folderPath: null },
    'settings:update': (req) => ({ welcome: 'not-seen', folderPath: null, ...req }),
    'locate:run': {
      folders: [{ path: SIMS_FOLDER, inOneDrive: false, newestFileAt: new Date('2026-11-23T00:00:00.000Z') }],
      game: null,
      gameRunning: 'not-running'
    },
    'game:check': 'not-running',
    'backup:status': { state: 'none' },
    'journal:list': [],
    'groups:disabled': [],
    'fifty:get': null,
    'assist:status': { key: 'not-set', offer: 'hide' }
  })
}

function renderApp(initialRoute?: Route) {
  return render(
    <ApiProvider value={firstRunApi()}>
      <App initialRoute={initialRoute} />
    </ApiProvider>
  )
}

describe('App shell', () => {
  it('opens a first run with the header, the safety footer, and nav items that follow FIXES_READY', async () => {
    renderApp()

    expect(await screen.findByText(FOOTER)).toBeInTheDocument()
    expect(screen.getByText(APP_TITLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check-up' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'Your mods' })).toHaveLength(FIXES_READY ? 1 : 0)
    expect(screen.queryAllByRole('button', { name: 'History' })).toHaveLength(FIXES_READY ? 1 : 0)
  })

  it('opens key setup on Ctrl+Shift+K without throwing', async () => {
    renderApp({ screen: 'about' })

    const about = await screen.findByRole('button', { name: 'About' })
    expect(about).toHaveAttribute('aria-current', 'page')

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })

    expect(screen.getByRole('button', { name: 'About' })).not.toHaveAttribute('aria-current')
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav.querySelector('[aria-current]')).toBeNull()
    expect(screen.getByText(FOOTER)).toBeInTheDocument()
  })
})
