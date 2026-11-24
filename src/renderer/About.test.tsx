import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { About } from './About'

afterEach(() => {
  cleanup()
})

describe('About', () => {
  it('renders the dedication', () => {
    render(<About />)
    expect(screen.getByText('Built by Tyler, for Lila.')).toBeInTheDocument()
  })
})
