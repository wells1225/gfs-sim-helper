import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistAnswer, AssistStatus, KeyStatus } from '../../shared/model.ts'
import { sampleScan } from '../../shared/testing/sample.ts'
import { ApiProvider } from '../api.tsx'
import { NavProvider, useNav } from '../nav.tsx'
import { fakeApi, type FakeApi, type FakeApiAnswers } from '../testing/fake-api.ts'
import { AskEntry } from './AskEntry.tsx'
import { AskScreen } from './AskScreen.tsx'
import { KeySetupScreen } from './KeySetupScreen.tsx'
import { NO_ANSWER_WORDS } from './words.ts'

const FAKE_KEY = 'sk-ant-FAKE-TEST-KEY-not-real-0000'
// Two spaces, a tab and blank lines: a collapsed preview would not match this.
const PREVIEW_TEXT = 'Game version: 1.129.39.1030\n\n  Mods/Hair/cozy  braids.package\n\tline two\n\n(list cut)'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function RouteProbe() {
  const { route } = useNav()
  return <p data-testid="route">{route.screen}</p>
}

function renderWith(api: FakeApi, node: ReactNode) {
  return render(
    <ApiProvider value={api}>
      <NavProvider initial={{ screen: 'check-up' }}>
        {node}
        <RouteProbe />
      </NavProvider>
    </ApiProvider>
  )
}

function channels(api: FakeApi) {
  return api.calls.map((call) => call.channel)
}

describe('AskEntry', () => {
  it('renders nothing when the key is not set', async () => {
    const api = fakeApi({ 'assist:status': { key: 'not-set', offer: 'hide' } })
    const { container } = renderWith(api, <AskEntry scan={sampleScan()} />)
    await waitFor(() => expect(channels(api)).toContain('assist:status'))
    await act(async () => {})
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /ask for help/i })).toBeNull()
  })

  it('renders nothing on hide, and nothing (and no console error) when the status call fails', async () => {
    const errors = vi.spyOn(console, 'error')
    const api = fakeApi({
      'assist:status': () => {
        throw new Error('not implemented: assist:status')
      }
    })
    renderWith(api, <AskEntry scan={sampleScan()} />)
    await waitFor(() => expect(channels(api)).toContain('assist:status'))
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /ask for help/i })).toBeNull()
    expect(errors).not.toHaveBeenCalled()
  })

  it('shows "Still stuck? Ask for help" on offer and opens the ask screen', async () => {
    const api = fakeApi({ 'assist:status': { key: 'set', offer: 'offer' } })
    renderWith(api, <AskEntry scan={sampleScan()} />)
    expect(await screen.findByText('Still stuck? Ask for help')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask for help' }))
    expect(screen.getByTestId('route')).toHaveTextContent('ask-for-help')
  })
})

function askApi(answer: AssistAnswer | ((req: { previewId: string }) => AssistAnswer), extra: FakeApiAnswers = {}) {
  return fakeApi({
    'assist:preview': { id: 'preview-1', text: PREVIEW_TEXT },
    'assist:send': answer,
    ...extra
  })
}

describe('AskScreen', () => {
  it('shows exactly the text that will be sent, white space and all', async () => {
    const api = askApi({ status: 'answered', text: 'x' })
    renderWith(api, <AskScreen />)
    expect(await screen.findByText('Here is exactly what will be sent')).toBeInTheDocument()
    const box = screen.getByTestId('assist-preview')
    expect(box.textContent).toBe(PREVIEW_TEXT)
  })

  it('Cancel sends nothing and goes back to the check-up', async () => {
    const api = askApi({ status: 'answered', text: 'x' })
    renderWith(api, <AskScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(channels(api)).toEqual(['assist:preview'])
    expect(screen.getByTestId('route')).toHaveTextContent('check-up')
  })

  it('Send sends only the preview id, and shows the answer labelled as a guess', async () => {
    const api = askApi({ status: 'answered', text: 'It might be Wicked Wardrobe.\n\nTry the 50/50 test.' })
    renderWith(api, <AskScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    expect(await screen.findByText('This is a guess')).toBeInTheDocument()
    expect(screen.getByTestId('assist-answer').textContent).toBe('It might be Wicked Wardrobe.\n\nTry the 50/50 test.')
    const send = api.calls.find((call) => call.channel === 'assist:send')
    expect(send?.req).toEqual({ previewId: 'preview-1' })
    // the screen never runs a fix: these two channels are all it ever calls
    expect(channels(api)).toEqual(['assist:preview', 'assist:send'])
  })

  it.each(Object.keys(NO_ANSWER_WORDS) as (keyof typeof NO_ANSWER_WORDS)[])(
    'shows a calm message for no-answer %s',
    async (why) => {
      const api = askApi({ status: 'no-answer', why })
      renderWith(api, <AskScreen />)
      fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
      expect(await screen.findByText(NO_ANSWER_WORDS[why].title)).toBeInTheDocument()
      expect(screen.queryByText('This is a guess')).toBeNull()
    }
  )

  it('says "It couldn\'t answer this one." when the model declines', () => {
    expect(NO_ANSWER_WORDS.declined.title).toBe("It couldn't answer this one.")
  })

  it('after a no-answer, trying again shows the text again before anything is sent', async () => {
    let n = 0
    const api = fakeApi({
      'assist:preview': () => ({ id: `preview-${++n}`, text: PREVIEW_TEXT }),
      'assist:send': { status: 'no-answer', why: 'offline' }
    })
    renderWith(api, <AskScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('assist-preview')).toBeInTheDocument()
    expect(channels(api)).toEqual(['assist:preview', 'assist:send', 'assist:preview'])
  })

  it('asks for a check-up first when there is no scan', async () => {
    const api = fakeApi({ 'assist:preview': null })
    renderWith(api, <AskScreen />)
    expect(await screen.findByText('Run a check-up first')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('shows a calm message when the send call itself fails', async () => {
    const api = askApi(() => {
      throw new Error('ipc broke')
    })
    renderWith(api, <AskScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    expect(await screen.findByText(NO_ANSWER_WORDS.error.title)).toBeInTheDocument()
    expect(screen.queryByText(/ipc broke/)).toBeNull()
  })
})

function keyApi(initial: KeyStatus, onSet: (key: string) => KeyStatus = () => 'set') {
  let status = initial
  return fakeApi({
    'assist:status': (): AssistStatus => ({ key: status, offer: 'hide' }),
    'assist:set-key': (req) => {
      status = onSet(req.key)
      return status
    },
    'assist:clear-key': () => {
      status = 'not-set'
      return status
    }
  })
}

function keyField(): HTMLInputElement {
  return screen.getByLabelText('Anthropic API key') as HTMLInputElement
}

describe('KeySetupScreen', () => {
  it('calls only assist:status when it opens, and says no key is stored', async () => {
    const api = keyApi('not-set')
    renderWith(api, <KeySetupScreen />)
    expect(await screen.findByText('No key is stored on this PC.')).toBeInTheDocument()
    expect(channels(api)).toEqual(['assist:status'])
    expect(keyField().type).toBe('password')
  })

  it('saves the pasted key, empties the field, and never shows the key', async () => {
    const api = keyApi('not-set')
    const { container } = renderWith(api, <KeySetupScreen />)
    await screen.findByText('No key is stored on this PC.')
    fireEvent.change(keyField(), { target: { value: FAKE_KEY } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(keyField().value).toBe('')
    expect(await screen.findByText('A key is stored on this PC.')).toBeInTheDocument()
    expect(api.calls.find((call) => call.channel === 'assist:set-key')?.req).toEqual({ key: FAKE_KEY })
    expect(container.innerHTML).not.toContain(FAKE_KEY)
    expect(keyField().value).toBe('')
  })

  it('says the key was not saved when the status stays not-set', async () => {
    const api = keyApi('not-set', () => 'not-set')
    renderWith(api, <KeySetupScreen />)
    await screen.findByText('No key is stored on this PC.')
    fireEvent.change(keyField(), { target: { value: 'not a key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/That key was not saved/)).toBeInTheDocument()
  })

  it('says the key cannot be stored safely when encryption is unavailable', async () => {
    const api = keyApi('encryption-unavailable', () => 'encryption-unavailable')
    renderWith(api, <KeySetupScreen />)
    expect(await screen.findByText(/can't store a key safely/)).toBeInTheDocument()
  })

  it('does nothing on Save with an empty field', async () => {
    const api = keyApi('not-set')
    renderWith(api, <KeySetupScreen />)
    await screen.findByText('No key is stored on this PC.')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(channels(api)).toEqual(['assist:status'])
  })

  it('removes the key', async () => {
    const api = keyApi('set')
    renderWith(api, <KeySetupScreen />)
    expect(await screen.findByText('A key is stored on this PC.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }))
    expect(await screen.findByText('No key is stored on this PC.')).toBeInTheDocument()
    expect(channels(api)).toContain('assist:clear-key')
  })
})
