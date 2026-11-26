import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { NavProvider, useNav } from '../nav.tsx'
import { SessionProvider, useSession } from '../session.tsx'
import { sampleScan } from '../../shared/testing/sample.ts'
import { WhatHappened } from './WhatHappened.tsx'

afterEach(() => {
  cleanup()
})

function Harness() {
  const { route } = useNav()
  const { symptom, scan } = useSession()
  return (
    <div>
      <WhatHappened />
      <output data-testid="route">{route.screen}</output>
      <output data-testid="symptom">{symptom}</output>
      <output data-testid="has-scan">{scan ? 'yes' : 'no'}</output>
    </div>
  )
}

describe('WhatHappened', () => {
  it('shows all five symptom choices as big buttons and starts a fresh check-up on click', async () => {
    const user = userEvent.setup()

    render(
      <SessionProvider initialScan={sampleScan()} initialSymptom="not-sure">
        <NavProvider initial={{ screen: 'what-happened' }}>
          <Harness />
        </NavProvider>
      </SessionProvider>
    )

    expect(screen.getByRole('button', { name: /closes by itself/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /freezes or gets stuck/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /won't open or load/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /one save or lot/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /not sure/i })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('—')

    await user.click(screen.getByRole('button', { name: /freezes or gets stuck/i }))

    expect(screen.getByTestId('route')).toHaveTextContent('check-up')
    expect(screen.getByTestId('symptom')).toHaveTextContent('freezes')
    expect(screen.getByTestId('has-scan')).toHaveTextContent('no')
  })

  it('offers a calm patch-day entry that opens the script check without starting a check-up', async () => {
    const user = userEvent.setup()

    render(
      <SessionProvider initialScan={sampleScan()} initialSymptom="not-sure">
        <NavProvider initial={{ screen: 'what-happened' }}>
          <Harness />
        </NavProvider>
      </SessionProvider>
    )

    const entry = screen.getByRole('button', { name: /just updated/i })
    expect(entry).toHaveTextContent(/custom content and saves stay untouched/i)
    expect(document.body.textContent).not.toMatch(/[\u2014\u2013]/)

    await user.click(entry)

    expect(screen.getByTestId('route')).toHaveTextContent('patch-day')
    expect(screen.getByTestId('has-scan')).toHaveTextContent('yes')
  })
})
