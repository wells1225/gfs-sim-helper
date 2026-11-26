import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { About } from './About'

afterEach(() => {
  cleanup()
})

describe('About', () => {
  it('renders the dedication and the EA independence disclaimer', () => {
    render(<About />)
    expect(screen.getByText('Built by Tyler, for Lila.')).toBeInTheDocument()
    expect(
      screen.getByText('Independent helper tool for The Sims 4. Not affiliated with or endorsed by Electronic Arts or Maxis.')
    ).toBeInTheDocument()
  })
})
