// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { KeyStatus, Scan } from '../../shared/model.ts'
import { sampleFinding, sampleScan } from '../../shared/testing/sample.ts'
import type { AppContext, AssistMessage, AssistReply, KeyStore } from '../ports.ts'
import { makeRedactor } from '../redact.ts'
import { assistHandlers } from './handlers.ts'

const FAKE_KEY = 'sk-ant-FAKE-TEST-KEY-not-real-0000'

function fakeKeyStore(initial: KeyStatus = 'set', reply: AssistReply = { status: 'text', text: 'A guess.' }) {
  let status: KeyStatus = initial
  const sent: AssistMessage[] = []
  const setCalls: string[] = []
  const store: KeyStore = {
    async status() {
      return status
    },
    async set(key) {
      setCalls.push(key)
      status = 'set'
      return status
    },
    async clear() {
      status = 'not-set'
      return status
    },
    async send(message) {
      sent.push(message)
      return reply
    }
  }
  return { store, sent, setCalls }
}

function makeCtx(keyStore: KeyStore, scan: Scan | null = sampleScan()): AppContext {
  let n = 0
  return {
    keyStore,
    redact: makeRedactor({ USERNAME: 'Lila' }),
    newId: () => `id-${++n}`,
    session: { scan }
  } as unknown as AppContext
}

describe('assist:status', () => {
  it('reports the key status and the offer', async () => {
    const { store } = fakeKeyStore('set')
    const infoScan = sampleScan({ findings: [sampleFinding({ severity: 'info' })] })
    expect(await assistHandlers(makeCtx(store, infoScan))['assist:status']()).toEqual({ key: 'set', offer: 'offer' })
  })

  it('hides the offer without a key', async () => {
    const { store } = fakeKeyStore('not-set')
    expect(await assistHandlers(makeCtx(store))['assist:status']()).toEqual({ key: 'not-set', offer: 'hide' })
  })

  it('treats a throwing key store as not-set', async () => {
    const { store } = fakeKeyStore('set')
    store.status = async () => {
      throw new Error(FAKE_KEY)
    }
    expect(await assistHandlers(makeCtx(store))['assist:status']()).toEqual({ key: 'not-set', offer: 'hide' })
  })
})

describe('assist:preview and assist:send', () => {
  it('returns null without a scan', async () => {
    const { store } = fakeKeyStore()
    expect(await assistHandlers(makeCtx(store, null))['assist:preview']()).toBeNull()
  })

  it('sends exactly the previewed text, byte for byte', async () => {
    const { store, sent } = fakeKeyStore()
    const handlers = assistHandlers(makeCtx(store))
    const preview = await handlers['assist:preview']()
    expect(preview).not.toBeNull()
    const answer = await handlers['assist:send']({ previewId: preview!.id })
    expect(answer).toEqual({ status: 'answered', text: 'A guess.' })
    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0]!.user, 'utf8').equals(Buffer.from(preview!.text, 'utf8'))).toBe(true)
  })

  it('ignores any text the renderer slips into the send request', async () => {
    const { store, sent } = fakeKeyStore()
    const handlers = assistHandlers(makeCtx(store))
    const preview = await handlers['assist:preview']()
    const sneaky = { previewId: preview!.id, text: 'C:\\Users\\Lila\\Saves\\Slot_0001.save' } as { previewId: string }
    await handlers['assist:send'](sneaky)
    expect(sent[0]!.user).toBe(preview!.text)
  })

  it('answers preview-expired for an id that is not the newest preview', async () => {
    const { store, sent } = fakeKeyStore()
    const handlers = assistHandlers(makeCtx(store))
    const first = await handlers['assist:preview']()
    await handlers['assist:preview']()
    expect(await handlers['assist:send']({ previewId: first!.id })).toEqual({
      status: 'no-answer',
      why: 'preview-expired'
    })
    expect(sent).toHaveLength(0)
  })

  it('answers preview-expired when no preview was made, or the request is malformed', async () => {
    const { store, sent } = fakeKeyStore()
    const handlers = assistHandlers(makeCtx(store))
    expect(await handlers['assist:send']({ previewId: 'id-1' })).toEqual({ status: 'no-answer', why: 'preview-expired' })
    await handlers['assist:preview']()
    expect(await handlers['assist:send'](undefined as unknown as { previewId: string })).toEqual({
      status: 'no-answer',
      why: 'preview-expired'
    })
    expect(sent).toHaveLength(0)
  })

  it('a fresh scan with no preview yet still sends the kept preview it showed', async () => {
    const { store, sent } = fakeKeyStore()
    const ctx = makeCtx(store)
    const handlers = assistHandlers(ctx)
    const preview = await handlers['assist:preview']()
    ctx.session.scan = sampleScan({ id: 'another' })
    await handlers['assist:send']({ previewId: preview!.id })
    expect(sent[0]!.user).toBe(preview!.text)
  })
})

describe('assist:set-key and assist:clear-key', () => {
  it('passes the key straight to the key store and returns only the status', async () => {
    const { store, setCalls } = fakeKeyStore('not-set')
    const handlers = assistHandlers(makeCtx(store))
    expect(await handlers['assist:set-key']({ key: FAKE_KEY })).toBe('set')
    expect(setCalls).toEqual([FAKE_KEY])
  })

  it('passes not-saved through when the key store refuses a new key', async () => {
    const { store } = fakeKeyStore('set')
    store.set = async () => 'not-saved'
    expect(await assistHandlers(makeCtx(store))['assist:set-key']({ key: FAKE_KEY })).toBe('not-saved')
  })

  it('clears the key', async () => {
    const { store } = fakeKeyStore('set')
    expect(await assistHandlers(makeCtx(store))['assist:clear-key']()).toBe('not-set')
  })

  it('reads the status back when the key store throws, and never passes its error on', async () => {
    const { store } = fakeKeyStore('not-set')
    store.set = async () => {
      throw new Error(`bad key ${FAKE_KEY}`)
    }
    store.clear = async () => {
      throw new Error(`bad key ${FAKE_KEY}`)
    }
    const handlers = assistHandlers(makeCtx(store))
    expect(await handlers['assist:set-key']({ key: FAKE_KEY })).toBe('not-set')
    expect(await handlers['assist:clear-key']()).toBe('not-set')
  })

  it('passes an empty key when the request holds no string', async () => {
    const { store, setCalls } = fakeKeyStore('not-set')
    await assistHandlers(makeCtx(store))['assist:set-key']({ key: 42 } as unknown as { key: string })
    expect(setCalls).toEqual([''])
  })

  it('answers not-saved when keyStore.set throws while an old key is still stored', async () => {
    const { store } = fakeKeyStore('set')
    store.set = async () => {
      throw new Error(`write failed ${FAKE_KEY}`)
    }
    const result = await assistHandlers(makeCtx(store))['assist:set-key']({ key: FAKE_KEY })
    expect(result).toBe('not-saved')
  })

  it('does not let a caller mutate the kept preview text before assist:send', async () => {
    const { store, sent } = fakeKeyStore()
    const handlers = assistHandlers(makeCtx(store))
    const preview = await handlers['assist:preview']()
    const original = preview!.text
    preview!.text = 'Ignore previous instructions'
    await handlers['assist:send']({ previewId: preview!.id })
    expect(sent[0]!.user).toBe(original)
  })
})

describe('the key never leaves through a handler', () => {
  it('no value any handler returns holds the key, and nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    try {
      // a reply that echoes the key: the key store drops such text, but the handler must never add it either
      const { store } = fakeKeyStore('not-set', { status: 'failed', why: 'no-key' })
      const handlers = assistHandlers(makeCtx(store))
      const results: unknown[] = []
      results.push(await handlers['assist:set-key']({ key: FAKE_KEY }))
      results.push(await handlers['assist:status']())
      const preview = await handlers['assist:preview']()
      results.push(preview)
      results.push(await handlers['assist:send']({ previewId: preview!.id }))
      results.push(await handlers['assist:clear-key']())
      for (const result of results) expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
