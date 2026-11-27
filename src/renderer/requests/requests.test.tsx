import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModRequest } from '../../shared/model.ts'
import { sampleJournalEntry } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider } from '../nav.tsx'
import { fakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { AskTylerScreen } from './AskTylerScreen.tsx'
import { AskTylerSetupScreen } from './AskTylerSetupScreen.tsx'

afterEach(() => {
  cleanup()
})

function renderScreen(ui: React.ReactNode, answers: FakeApiAnswers = {}) {
  const api = fakeApi(answers)
  const utils = render(
    <ApiProvider value={api}>
      <NavProvider initial={{ screen: 'ask-tyler' }}>{ui}</NavProvider>
    </ApiProvider>
  )
  return { api, ...utils }
}

describe('AskTylerSetupScreen', () => {
  it('shows the one-screen guide and picks the Sims Helper Mods folder', async () => {
    const user = userEvent.setup()
    const { api } = renderScreen(<AskTylerSetupScreen />, {
      'requests:folder': { kind: 'not-set' },
      'requests:pick-folder': { kind: 'set', path: 'G:\\My Drive\\Sims Helper Mods' }
    })

    expect(await screen.findByRole('button', { name: 'Pick the Sims Helper Mods folder' })).toBeInTheDocument()
    expect(screen.getByText(/Add shortcut to Drive/i)).toBeInTheDocument()
    expect(screen.getByText(/Google Drive for desktop/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pick the Sims Helper Mods folder' }))
    await waitFor(() => {
      expect(api.calls.some((c) => c.channel === 'requests:pick-folder')).toBe(true)
    })
  })

  it('explains wrong-name, missing, and in-sims-folder states in plain language', async () => {
    const { unmount } = renderScreen(<AskTylerSetupScreen />, {
      'requests:folder': { kind: 'wrong-name', path: 'G:\\My Drive\\Other' }
    })
    expect(await screen.findByText(/That folder can't be used/i)).toBeInTheDocument()
    expect(screen.getByText(/not a link or system folder/i)).toBeInTheDocument()
    unmount()

    const second = renderScreen(<AskTylerSetupScreen />, {
      'requests:folder': { kind: 'in-sims-folder', path: 'C:\\Sims\\Sims Helper Mods' }
    })
    expect(await screen.findByText(/not a folder inside The Sims 4/i)).toBeInTheDocument()
    second.unmount()

    renderScreen(<AskTylerSetupScreen />, {
      'requests:folder': { kind: 'missing', path: 'G:\\My Drive\\Sims Helper Mods' }
    })
    expect(await screen.findByText(/Google Drive for desktop is open/i)).toBeInTheDocument()
  })
})

describe('AskTylerScreen', () => {
  it('shows setup when no folder is set', async () => {
    renderScreen(<AskTylerScreen />, {
      'requests:folder': { kind: 'not-set' }
    })
    expect(await screen.findByRole('button', { name: 'Pick the Sims Helper Mods folder' })).toBeInTheDocument()
  })

  it('tracks live character count to 2,000, sends a request, and shows confirmation', async () => {
    const user = userEvent.setup()
    const sentReq: ModRequest = {
      id: 'r-20261126-143000-ab12',
      at: '2026-11-26T14:30:00.000Z',
      text: 'Add cozy slippers for winter outfits',
      status: 'sent',
      delivery: null
    }
    const { api } = renderScreen(<AskTylerScreen />, {
      'requests:folder': { kind: 'set', path: 'G:\\My Drive\\Sims Helper Mods' },
      'requests:list': [],
      'requests:send': { kind: 'sent', request: sentReq }
    })

    const box = await screen.findByLabelText("Tell Tyler what you'd like the mod to do")
    const sendBtn = screen.getByRole('button', { name: 'Send to Tyler' })
    expect(sendBtn).toBeDisabled()
    expect(screen.getByText('0 / 2,000')).toBeInTheDocument()

    await user.type(box, 'Add cozy slippers for winter outfits')
    expect(screen.getByText('36 / 2,000')).toBeInTheDocument()
    expect(sendBtn).toBeEnabled()

    await user.click(sendBtn)
    expect(await screen.findByText('Sent. Tyler will get an email.')).toBeInTheDocument()
    expect(api.calls.some((c) => c.channel === 'requests:send')).toBe(true)
    expect(box).toHaveValue('')
    expect(screen.getByText('Add cozy slippers for winter outfits')).toBeInTheDocument()
  })

  it('shows ready, sent, installed, and broken requests and installs a ready mod', async () => {
    const user = userEvent.setup()
    const requests: ModRequest[] = [
      {
        id: 'r-20261126-143000-aa01',
        at: '2026-11-26T14:30:00.000Z',
        text: 'Make Sims react to new outfits',
        status: 'ready',
        delivery: {
          title: 'Outfit Reactions',
          note: 'Sims now react to new outfits. Turn on script mods in Game Options.',
          files: [
            { name: 'outfit_reactions.package', bytes: 42_000 },
            { name: 'outfit_reactions.ts4script', bytes: 18_500 }
          ],
          hasScript: true
        }
      },
      {
        id: 'r-20261126-140000-bb02',
        at: '2026-11-26T14:00:00.000Z',
        text: 'A matching tea set for the kitchen counter',
        status: 'sent',
        delivery: null
      },
      {
        id: 'r-20261125-180000-cc03',
        at: '2026-11-25T18:00:00.000Z',
        text: 'More pastel curtains',
        status: 'installed',
        delivery: {
          title: 'Pastel Curtains',
          note: 'Adds 8 sheer pastel swatches.',
          files: [{ name: 'pastel_curtains.package', bytes: 120_000 }],
          hasScript: false
        }
      },
      {
        id: 'r-20261125-120000-dd04',
        at: '2026-11-25T12:00:00.000Z',
        text: 'Faster homework for teens',
        status: 'broken',
        delivery: null
      }
    ]

    let installed = false
    const { api } = renderScreen(<AskTylerScreen />, {
      'requests:folder': { kind: 'set', path: 'G:\\My Drive\\Sims Helper Mods' },
      'requests:list': () =>
        installed
          ? requests.map((r) => (r.id === 'r-20261126-143000-aa01' ? { ...r, status: 'installed' as const } : r))
          : requests,
      'requests:install': () => {
        installed = true
        return {
          status: 'done',
          entry: sampleJournalEntry({
            id: 'e-install-1',
            action: 'install-mod',
            summary: 'Installed Outfit Reactions',
            groupId: 'request:r-20261126-143000-aa01',
            groupLabel: 'Outfit Reactions',
            hasScript: true
          })
        }
      }
    })

    expect(await screen.findByText('Tyler made you a mod: Outfit Reactions')).toBeInTheDocument()
    expect(screen.getByText('This mod needs script mods turned on in Game Options.')).toBeInTheDocument()
    expect(screen.getByText("This one didn't arrive properly. Tyler has been told.")).toBeInTheDocument()
    expect(screen.getByText('Pastel Curtains')).toBeInTheDocument()
    expect(screen.getByText('A matching tea set for the kitchen counter')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => {
      expect(api.calls.some((c) => c.channel === 'requests:install')).toBe(true)
    })
    expect(await screen.findByText(/Installed Outfit Reactions/i)).toBeInTheDocument()
  })

  it('shows a Google Drive wait message on install file-changed refusal and guides to History when needs-attention', async () => {
    const user = userEvent.setup()
    const readyReq: ModRequest = {
      id: 'r-20261126-143000-aa01',
      at: '2026-11-26T14:30:00.000Z',
      text: 'Make Sims react to new outfits',
      status: 'ready',
      delivery: {
        title: 'Outfit Reactions',
        note: 'Enjoy!',
        files: [{ name: 'outfit.package', bytes: 12_000 }],
        hasScript: false
      }
    }

    const first = renderScreen(<AskTylerScreen />, {
      'requests:folder': { kind: 'set', path: 'G:\\My Drive\\Sims Helper Mods' },
      'requests:list': [readyReq],
      'journal:list': [],
      'requests:install': { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
    })

    await user.click(await screen.findByRole('button', { name: 'Install' }))
    expect(
      await screen.findByText("This mod hasn't finished downloading. Wait a minute for Google Drive, then try again.")
    ).toBeInTheDocument()
    first.unmount()

    renderScreen(<AskTylerScreen />, {
      'requests:folder': { kind: 'set', path: 'G:\\My Drive\\Sims Helper Mods' },
      'requests:list': [readyReq],
      'journal:list': [
        sampleJournalEntry({
          id: 'e-stuck-1',
          action: 'install-mod',
          summary: 'Installed Outfit Reactions',
          groupId: `request:${readyReq.id}`,
          groupLabel: 'Outfit Reactions',
          status: 'needs-attention'
        })
      ]
    })

    expect(await screen.findByText(/previous install of this mod stopped partway/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Go to History' })).toBeInTheDocument()
  })

  it('connects the textarea to a polite live counter and uses "2,000 characters or fewer" over limit', async () => {
    const user = userEvent.setup()
    renderScreen(<AskTylerScreen />, {
      'requests:folder': { kind: 'set', path: 'G:\\My Drive\\Sims Helper Mods' },
      'requests:list': [],
      'journal:list': []
    })

    const box = await screen.findByLabelText("Tell Tyler what you'd like the mod to do")
    const counter = screen.getByText('0 / 2,000')
    expect(counter).toHaveAttribute('aria-live', 'polite')
    expect(box).toHaveAttribute('aria-describedby', counter.id)

    await user.click(box)
    await user.paste('a'.repeat(2001))
    const warning = await screen.findByText(/2,000 characters or fewer/i)
    expect(box).toHaveAttribute('aria-describedby', `${counter.id} ${warning.id}`)
  })
})
