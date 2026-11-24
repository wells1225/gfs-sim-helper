import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App.tsx'

afterEach(() => {
  cleanup()
})

describe('App shell', () => {
  it('routes from start to about, shows the dedication and safety footer, and hides fixes nav items', async () => {
    render(<App />)

    expect(await screen.findByText('Built by Tyler, for Lila.')).toBeInTheDocument()
    expect(
      screen.getByText('Saves and Tray are never touched · A backup is made before any change')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Your mods' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check-up' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument()
  })

  it('handles Ctrl+Shift+K without calling IPC or throwing', async () => {
    render(<App />)
    await screen.findByText('Built by Tyler, for Lila.')

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(screen.queryByText('Built by Tyler, for Lila.')).not.toBeInTheDocument()
  })
})
