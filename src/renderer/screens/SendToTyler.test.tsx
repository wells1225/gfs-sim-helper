import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider } from '../nav.tsx'
import { SessionProvider } from '../session.tsx'
import { fakeApi } from '../testing/fake-api.ts'
import { SendToTyler } from './SendToTyler.tsx'

afterEach(() => {
  cleanup()
})

describe('SendToTyler', () => {
  it('explains what the zip holds, builds the report, shows the file name, and reveals it on Desktop', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'report:build': {
        status: 'saved',
        fileName: 'Sims Helper report 20261124-120000.zip',
        entries: ['lastException_63887259912.txt', 'Options.ini', 'GameVersion.txt', 'scan.json', 'AddonGameInstance.json']
      },
      'report:reveal': undefined
    })

    render(
      <ApiProvider value={api}>
        <SessionProvider initialScan={sampleScan()}>
          <NavProvider initial={{ screen: 'send-to-tyler' }}>
            <SendToTyler />
          </NavProvider>
        </SessionProvider>
      </ApiProvider>
    )

    expect(screen.getByText(/crash logs and mod list/i)).toBeInTheDocument()
    expect(screen.getByText(/never your saves/i)).toBeInTheDocument()
    expect(screen.getByText(/user name is removed/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /create report zip/i }))

    expect(await screen.findByText('Sims Helper report 20261124-120000.zip')).toBeInTheDocument()
    const showBtn = screen.getByRole('button', { name: /show on desktop/i })
    await user.click(showBtn)

    expect(api.calls.map((c) => c.channel)).toEqual(['report:build', 'report:reveal'])
  })
})
