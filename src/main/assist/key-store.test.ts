// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appPaths } from '../app-paths.ts'
import type { AssistMessage, AssistReply, Gate, GateResult, KeyStoreDeps, SafeStorageLike, WriteRequest } from '../ports.ts'
import { clearKey, keyStatus, sendWithKey, setKey } from './key-store.ts'

// A made-up value. It is not shaped like a real key on purpose.
const KEY = 'FAKE-KEY-not-real-0123456789-abcdefghij'
const OTHER_KEY = 'FAKE-KEY-second-one-9876543210-zyxwvuts'

const MESSAGE: AssistMessage = {
  model: 'claude-haiku-5-5',
  system: 'Answer in plain words for a player who is not technical.',
  user: '  Game version 1.118\r\nMods/Ünïcode mod.package\n\n(list cut)\n ',
  maxTokens: 1024
}

const MASK = 0x5a
const SEAL_MARK = [0xfa, 0xce]

interface FakeSafeStorage extends SafeStorageLike {
  available: boolean
  encryptFails: boolean
  decryptFails: boolean
  writesClearText: boolean
  encrypted: string[]
}

/** Not the identity: every byte is masked, so the stored bytes never hold the text in the clear. */
function fakeSafeStorage(): FakeSafeStorage {
  const storage: FakeSafeStorage = {
    available: true,
    encryptFails: false,
    decryptFails: false,
    writesClearText: false,
    encrypted: [],
    isEncryptionAvailable: () => storage.available,
    encryptString(text) {
      if (storage.encryptFails) throw new Error(`could not encrypt ${text}`)
      storage.encrypted.push(text)
      const plain = Buffer.from(text, 'utf8')
      if (storage.writesClearText) return plain
      return Uint8Array.from([...SEAL_MARK, ...plain.map((byte) => byte ^ MASK)])
    },
    decryptString(data) {
      if (storage.decryptFails) throw new Error('could not decrypt')
      if (data[0] !== SEAL_MARK[0] || data[1] !== SEAL_MARK[1]) throw new Error('not sealed by this fake')
      return Buffer.from(data.subarray(2).map((byte) => byte ^ MASK)).toString('utf8')
    }
  }
  return storage
}

interface FakeGate extends Gate {
  requests: WriteRequest[]
  answer: GateResult | 'throw' | null
}

/** Records every request and really writes and removes, so the key store reads back what it stored. */
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    requests: [],
    answer: null,
    async run(request) {
      gate.requests.push(request)
      if (gate.answer === 'throw') throw new Error('gate broke')
      if (gate.answer) return gate.answer
      for (const op of request.ops) {
        if (op.op === 'write') {
          await mkdir(dirname(op.path), { recursive: true })
          await writeFile(op.path, op.data)
        } else if (op.op === 'remove') {
          await rm(op.path, { recursive: true, force: true })
        } else {
          throw new Error(`the key store may not ask for ${op.op}`)
        }
      }
      return { status: 'done' }
    }
  }
  return gate
}

type Transport = NonNullable<KeyStoreDeps['transport']>

interface Rig {
  deps: KeyStoreDeps
  gate: FakeGate
  safeStorage: FakeSafeStorage
  transport: ReturnType<typeof vi.fn<Transport>>
  keyFile: string
}

let tmp: string
let output: string[]

function rig(reply: AssistReply = { status: 'text', text: 'It is probably an old script mod.' }): Rig {
  const paths = appPaths({ localAppData: join(tmp, 'Local'), desktopDir: join(tmp, 'Desktop') })
  const gate = fakeGate()
  const safeStorage = fakeSafeStorage()
  const transport = vi.fn<Transport>(async () => reply)
  return { deps: { gate, paths, safeStorage, transport }, gate, safeStorage, transport, keyFile: paths.keyFile }
}

/** Every piece of text in a value: strings, bytes read as text, and what an Error carries. */
function textIn(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return `${Buffer.from(value).toString('utf8')} ${Buffer.from(value).toString('latin1')}`
  if (value === null || typeof value !== 'object') return String(value)
  if (seen.has(value)) return ''
  seen.add(value)
  const parts: unknown[] = Array.isArray(value) ? value : Object.entries(value).flat()
  if (value instanceof Error) parts.push(value.message, value.stack, value.cause)
  return parts.map((part) => textIn(part, seen)).join(' ')
}

function expectNoKey(value: unknown, key = KEY): void {
  expect(textIn(value).includes(key)).toBe(false)
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'sims-helper-key-'))
  output = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(textIn(args))
    })
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      output.push(textIn(chunk))
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof stream.write)
  }
  // No test may reach the network. A test of the built-in transport puts its own fake here.
  vi.stubGlobal('fetch', async () => {
    throw new Error('a key-store test tried to use the network')
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(tmp, { recursive: true, force: true })
})

describe('storing the key', () => {
  it('starts as not-set and asks the gate for nothing', async () => {
    const { deps, gate } = rig()

    expect(await keyStatus(deps)).toBe('not-set')
    expect(gate.requests).toEqual([])
  })

  it('sets, reports and clears the key', async () => {
    const { deps, keyFile } = rig()

    expect(await setKey(deps, KEY)).toBe('set')
    expect(await keyStatus(deps)).toBe('set')
    expect((await readFile(keyFile)).length).toBeGreaterThan(1)

    expect(await clearKey(deps)).toBe('not-set')
    expect(await keyStatus(deps)).toBe('not-set')
    await expect(readFile(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes one replace op to the key file through the gate, with reason key', async () => {
    const { deps, gate, keyFile } = rig()

    await setKey(deps, KEY)

    expect(gate.requests).toHaveLength(1)
    const request = gate.requests[0]!
    expect(request).toMatchObject({ reason: 'key', folderPath: null })
    expect(request.ops).toHaveLength(1)
    expect(request.ops[0]).toMatchObject({ op: 'write', path: keyFile, mode: 'replace' })
  })

  it('writes a version byte and then the encrypted bytes, never the key in the clear', async () => {
    const { deps, gate, safeStorage, keyFile } = rig()

    await setKey(deps, KEY)

    const file = await readFile(keyFile)
    expect(file[0]).toBe(1)
    expect(safeStorage.decryptString(file.subarray(1))).toBe(KEY)
    expect(file.includes(Buffer.from(KEY, 'utf8'))).toBe(false)
    expectNoKey(gate.requests)
  })

  it('removes the key file with one remove op', async () => {
    const { deps, gate, keyFile } = rig()
    await setKey(deps, KEY)
    gate.requests.length = 0

    await clearKey(deps)

    expect(gate.requests).toEqual([{ reason: 'key', folderPath: null, ops: [{ op: 'remove', path: keyFile }] }])
  })

  it('trims the key before it stores it', async () => {
    const { deps, safeStorage } = rig()

    expect(await setKey(deps, `  ${KEY}\r\n`)).toBe('set')

    expect(safeStorage.encrypted).toEqual([KEY])
  })

  it('replaces a stored key with a new one', async () => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)

    expect(await setKey(deps, OTHER_KEY)).toBe('set')
    await sendWithKey(deps, MESSAGE)

    expect(transport.mock.calls[0]![0]).toBe(OTHER_KEY)
  })

  it.each([
    ['an empty key', ''],
    ['only white space', ' \t\r\n '],
    ['white space inside', 'FAKE KEY'],
    ['a line break inside', 'FAKE\nKEY'],
    ['more than 512 characters', 'k'.repeat(513)],
    ['a character a request header cannot carry', 'FAKE-KEY-é'],
    ['a control character', 'FAKE\u0000KEY'],
    ['something that is not text', { key: KEY } as unknown as string],
    ['nothing at all', undefined as unknown as string]
  ])('refuses %s: not-set with no key stored, not-saved with one', async (_name, bad) => {
    const { deps, gate, safeStorage, transport } = rig()

    expect(await setKey(deps, bad)).toBe('not-set')
    expect(gate.requests).toEqual([])

    await setKey(deps, KEY)
    gate.requests.length = 0
    expect(await setKey(deps, bad)).toBe('not-saved')
    expect(await keyStatus(deps)).toBe('set')
    expect(gate.requests).toEqual([])
    expect(safeStorage.encrypted).toEqual([KEY])

    await sendWithKey(deps, MESSAGE)
    expect(transport.mock.calls[0]![0]).toBe(KEY)
  })

  it('accepts a key of exactly 512 characters', async () => {
    const { deps } = rig()

    expect(await setKey(deps, 'k'.repeat(512))).toBe('set')
  })

  it('stores nothing when encryption is not available', async () => {
    const { deps, gate, safeStorage, keyFile } = rig()
    safeStorage.available = false

    expect(await setKey(deps, KEY)).toBe('encryption-unavailable')
    expect(await keyStatus(deps)).toBe('encryption-unavailable')

    expect(gate.requests).toEqual([])
    expect(safeStorage.encrypted).toEqual([])
    await expect(readFile(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stores nothing when the availability check itself throws', async () => {
    const { deps, gate, safeStorage } = rig()
    safeStorage.isEncryptionAvailable = () => {
      throw new Error('no keychain')
    }

    expect(await setKey(deps, KEY)).toBe('encryption-unavailable')
    expect(await keyStatus(deps)).toBe('encryption-unavailable')
    expect(gate.requests).toEqual([])
  })

  it('stores nothing when encrypting throws, and does not pass the error on', async () => {
    const { deps, gate, safeStorage } = rig()
    safeStorage.encryptFails = true // the fake puts the key in its error message

    const result = await setKey(deps, KEY)

    expect(result).toBe('encryption-unavailable')
    expect(gate.requests).toEqual([])
    expectNoKey(output)
  })

  it('stores nothing when the "encrypted" bytes still hold the key in the clear', async () => {
    const { deps, gate, safeStorage } = rig()
    safeStorage.writesClearText = true

    expect(await setKey(deps, KEY)).toBe('encryption-unavailable')
    expect(gate.requests).toEqual([])
  })

  it.each([
    ['refuses', { status: 'refused', refusal: { reason: 'outside-allowed-area', path: 'x' } } as GateResult],
    ['fails', { status: 'failed', opsDone: 0, detail: `disk full while writing ${KEY}` } as GateResult],
    ['throws', 'throw' as const]
  ])('reports what is really on disk when the gate %s', async (_name, answer) => {
    const { deps, gate, transport } = rig()
    gate.answer = answer

    expect(await setKey(deps, KEY)).toBe('not-set')
    expect(await clearKey(deps)).toBe('not-set')

    gate.answer = null
    await setKey(deps, KEY)
    gate.answer = answer
    const result = await setKey(deps, OTHER_KEY)
    expect(result).toBe('not-saved')
    expectNoKey(result, OTHER_KEY)
    expect(await keyStatus(deps)).toBe('set')
    expect(await clearKey(deps)).toBe('set')

    await sendWithKey(deps, MESSAGE)
    expect(transport.mock.calls[0]![0]).toBe(KEY) // the old key is the one still in use
  })

  it('answers set, not not-saved, when the key the gate would not write is the one already stored', async () => {
    const { deps, gate } = rig()
    await setKey(deps, KEY)
    gate.answer = { status: 'refused', refusal: { reason: 'outside-allowed-area', path: 'x' } } as GateResult

    expect(await setKey(deps, KEY)).toBe('set')
  })

  it('answers not-saved when the gate says done but the old key is still what the file holds', async () => {
    const { deps, gate } = rig()
    await setKey(deps, KEY)
    gate.answer = { status: 'done' }

    expect(await setKey(deps, OTHER_KEY)).toBe('not-saved')
  })

  it('answers not-set, not not-saved, when a new key is refused and the old one no longer decrypts', async () => {
    const { deps, safeStorage } = rig()
    await setKey(deps, KEY)
    safeStorage.decryptFails = true

    expect(await setKey(deps, 'FAKE KEY')).toBe('not-set')
  })

  it.each([
    ['an empty file', Uint8Array.from([])],
    ['a version byte and nothing else', Uint8Array.from([1])],
    ['a version it does not know', Uint8Array.from([2, ...SEAL_MARK, 0x31, 0x32])],
    ['bytes that do not decrypt', Uint8Array.from([1, 0x00, 0x01, 0x02, 0x03])],
    ['a file far too big to be a key', Uint8Array.from([1, ...SEAL_MARK, ...new Array<number>(70_000).fill(0x31)])]
  ])('counts %s as not-set and leaves the file alone', async (_name, bytes) => {
    const { deps, gate, transport, keyFile } = rig()
    await mkdir(dirname(keyFile), { recursive: true })
    await writeFile(keyFile, bytes)

    expect(await keyStatus(deps)).toBe('not-set')
    expect(await sendWithKey(deps, MESSAGE)).toEqual({ status: 'failed', why: 'no-key' })

    expect(transport).not.toHaveBeenCalled()
    expect(gate.requests).toEqual([])
    expect(Uint8Array.from(await readFile(keyFile))).toEqual(bytes)
  })

  it('counts a stored value that is not a usable key as not-set', async () => {
    const { deps, safeStorage, transport, keyFile } = rig()
    await mkdir(dirname(keyFile), { recursive: true })
    await writeFile(keyFile, Uint8Array.from([1, ...safeStorage.encryptString('two words')]))

    expect(await keyStatus(deps)).toBe('not-set')
    expect(await sendWithKey(deps, MESSAGE)).toEqual({ status: 'failed', why: 'no-key' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('counts a key that stops decrypting as not-set, and keeps the file', async () => {
    const { deps, gate, safeStorage, keyFile } = rig()
    await setKey(deps, KEY)
    const before = await readFile(keyFile)
    gate.requests.length = 0
    safeStorage.decryptFails = true

    expect(await keyStatus(deps)).toBe('not-set')

    expect(gate.requests).toEqual([])
    expect(await readFile(keyFile)).toEqual(before)
  })
})

describe('sending with the key', () => {
  it('answers no-key and calls nothing when no key is stored', async () => {
    const { deps, transport } = rig()

    expect(await sendWithKey(deps, MESSAGE)).toEqual({ status: 'failed', why: 'no-key' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('answers no-key when encryption is not available', async () => {
    const { deps, safeStorage, transport } = rig()
    await setKey(deps, KEY)
    safeStorage.available = false

    expect(await sendWithKey(deps, MESSAGE)).toEqual({ status: 'failed', why: 'no-key' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('hands the transport the key and the message exactly as given, once', async () => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)

    const reply = await sendWithKey(deps, MESSAGE)

    expect(reply).toEqual({ status: 'text', text: 'It is probably an old script mod.' })
    expect(transport).toHaveBeenCalledTimes(1)
    const [apiKey, sent] = transport.mock.calls[0]!
    expect(apiKey).toBe(KEY)
    expect(sent).toEqual(MESSAGE)
    expect(Buffer.from(sent.user, 'utf8').equals(Buffer.from(MESSAGE.user, 'utf8'))).toBe(true)
  })

  it('passes on only the four fields of the message', async () => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)

    await sendWithKey(deps, { ...MESSAGE, extra: 'C:\\Users\\Lila\\saves' } as AssistMessage)

    expect(transport.mock.calls[0]![1]).toEqual(MESSAGE)
  })

  it('asks the gate for nothing and writes nothing when it sends', async () => {
    const { deps, gate } = rig()
    await setKey(deps, KEY)
    gate.requests.length = 0

    await sendWithKey(deps, MESSAGE)

    expect(gate.requests).toEqual([])
  })

  it.each([
    ['no user text', { ...MESSAGE, user: '' }],
    ['user text that is not text', { ...MESSAGE, user: 42 as unknown as string }],
    ['no model', { ...MESSAGE, model: '' }],
    ['a system prompt that is not text', { ...MESSAGE, system: null as unknown as string }],
    ['a token count of zero', { ...MESSAGE, maxTokens: 0 }],
    ['a token count that is not a whole number', { ...MESSAGE, maxTokens: 10.5 }],
    ['a token count that is not a number', { ...MESSAGE, maxTokens: Number.NaN }],
    ['no message', null as unknown as AssistMessage]
  ])('answers error and calls nothing for a message with %s', async (_name, message) => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)

    expect(await sendWithKey(deps, message)).toEqual({ status: 'failed', why: 'error' })
    expect(transport).not.toHaveBeenCalled()
  })

  it.each(['no-key', 'key-rejected', 'declined', 'offline', 'limit-reached', 'error'] as const)(
    'passes on the reason %s from the transport',
    async (why) => {
      const { deps } = rig({ status: 'failed', why })
      await setKey(deps, KEY)

      expect(await sendWithKey(deps, MESSAGE)).toEqual({ status: 'failed', why })
    }
  )

  it('turns a thrown error that carries the key into a plain error', async () => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)
    transport.mockImplementation(async (apiKey) => {
      throw Object.assign(new Error(`401 invalid x-api-key ${apiKey}`), { headers: { 'x-api-key': apiKey } })
    })

    const reply = await sendWithKey(deps, MESSAGE)

    expect(reply).toEqual({ status: 'failed', why: 'error' })
    expectNoKey(reply)
    expectNoKey(output)
  })

  it('never returns a reply that holds the key', async () => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)
    transport.mockImplementation(async (apiKey) => ({ status: 'text', text: `Your key is ${apiKey}.` }))

    expect(await sendWithKey(deps, MESSAGE)).toEqual({ status: 'failed', why: 'error' })
  })

  it.each([
    ['extra fields', { status: 'failed', why: 'offline', detail: `tried ${KEY}` }, { status: 'failed', why: 'offline' }],
    ['extra fields on an answer', { status: 'text', text: 'A guess.', raw: KEY }, { status: 'text', text: 'A guess.' }],
    ['a reason it does not know', { status: 'failed', why: `bad key ${KEY}` }, { status: 'failed', why: 'error' }],
    ['an empty answer', { status: 'text', text: '' }, { status: 'failed', why: 'error' }],
    ['an answer that is not text', { status: 'text', text: { key: KEY } }, { status: 'failed', why: 'error' }],
    ['nothing', undefined, { status: 'failed', why: 'error' }]
  ])('rebuilds a transport reply with %s from the fields it knows', async (_name, raw, expected) => {
    const { deps, transport } = rig()
    await setKey(deps, KEY)
    transport.mockImplementation(async () => raw as AssistReply)

    const reply = await sendWithKey(deps, MESSAGE)

    expect(reply).toEqual(expected)
    expectNoKey(reply)
  })
})

describe('where the key goes', () => {
  it('reaches safeStorage and the transport, and nothing else', async () => {
    const { deps, gate, safeStorage, transport, keyFile } = rig()
    const returned: unknown[] = []

    returned.push(await keyStatus(deps))
    returned.push(await setKey(deps, KEY))
    returned.push(await keyStatus(deps))
    returned.push(await sendWithKey(deps, MESSAGE))
    transport.mockRejectedValueOnce(new Error(`boom ${KEY}`))
    returned.push(await sendWithKey(deps, MESSAGE))
    gate.answer = { status: 'failed', opsDone: 0, detail: 'disk full' }
    returned.push(await setKey(deps, OTHER_KEY))
    gate.answer = null
    safeStorage.decryptFails = true
    returned.push(await keyStatus(deps))
    returned.push(await sendWithKey(deps, MESSAGE))
    safeStorage.decryptFails = false
    const stored = await readFile(keyFile)
    returned.push(await clearKey(deps))

    expect(safeStorage.encrypted).toEqual([KEY, OTHER_KEY])
    expect(transport.mock.calls.map(([apiKey]) => apiKey)).toEqual([KEY, KEY])
    for (const key of [KEY, OTHER_KEY]) {
      expectNoKey(returned, key)
      expectNoKey(gate.requests, key)
      expectNoKey(stored, key)
      expectNoKey(output, key)
    }
    expect(output).toEqual([])
  })

  it('keeps going when a caller throws things at it: no function rejects', async () => {
    const { deps, gate, safeStorage } = rig()
    await setKey(deps, KEY)
    gate.answer = 'throw'
    safeStorage.decryptFails = true
    safeStorage.encryptFails = true

    await expect(keyStatus(deps)).resolves.toBe('not-set')
    await expect(setKey(deps, KEY)).resolves.toBe('encryption-unavailable')
    await expect(clearKey(deps)).resolves.toBe('not-set')
    await expect(sendWithKey(deps, MESSAGE)).resolves.toEqual({ status: 'failed', why: 'no-key' })
  })
})

describe('the built-in transport (the real SDK on a fake fetch)', () => {
  interface Call {
    url: string
    method: string | undefined
    headers: Headers
    body: string
  }

  function answerWith(respond: (call: Call) => Response): Call[] {
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const call: Call = {
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: String(init?.body)
      }
      calls.push(call)
      return respond(call)
    })
    return calls
  }

  // 'x-should-retry: false' stops the SDK from waiting and trying again, which keeps these tests quick.
  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-should-retry': 'false', 'request-id': 'req_fake' }
    })
  }

  function message(content: unknown[], stopReason = 'end_turn'): unknown {
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: MESSAGE.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: 'declined' } : null,
      usage: { input_tokens: 10, output_tokens: 10 }
    }
  }

  function apiError(type: string, text: string): unknown {
    return { type: 'error', error: { type, message: text }, request_id: 'req_fake' }
  }

  async function stored(): Promise<KeyStoreDeps> {
    const { deps } = rig()
    await setKey(deps, KEY)
    return { gate: deps.gate, paths: deps.paths, safeStorage: deps.safeStorage } // no transport: the built-in one
  }

  it('sends one request to api.anthropic.com with the key in a header and only the message in the body', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://elsewhere.example')
    vi.stubEnv('ANTHROPIC_API_KEY', 'FAKE-ENV-KEY')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'FAKE-ENV-TOKEN')
    vi.stubEnv('ANTHROPIC_LOG', 'debug')
    const calls = answerWith(() => json(200, message([{ type: 'text', text: 'A guess: an old script mod.' }])))
    const deps = await stored()

    const reply = await sendWithKey(deps, MESSAGE)

    expect(reply).toEqual({ status: 'text', text: 'A guess: an old script mod.' })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.method?.toUpperCase()).toBe('POST')

    const carriers = [...call.headers].filter(([, value]) => value.includes(KEY))
    expect(carriers.map(([name]) => name)).toEqual(['authorization'])
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(textIn([...call.headers])).not.toContain('FAKE-ENV')
    expect(call.url).not.toContain(KEY)
    expect(call.body).not.toContain(KEY)

    const body = JSON.parse(call.body) as Record<string, unknown>
    expect(body).toEqual({
      model: MESSAGE.model,
      max_tokens: expect.any(Number),
      output_config: { effort: 'low' },
      system: MESSAGE.system,
      messages: [{ role: 'user', content: MESSAGE.user }]
    })
    expect(body.max_tokens).toBeGreaterThanOrEqual(MESSAGE.maxTokens)
    expect(body.max_tokens).toBeLessThanOrEqual(8192)
    expect(output).toEqual([])
  })

  it('leaves room for thinking, and caps a huge token count', async () => {
    const calls = answerWith(() => json(200, message([{ type: 'text', text: 'ok' }])))
    const deps = await stored()

    await sendWithKey(deps, { ...MESSAGE, maxTokens: 1024 })
    await sendWithKey(deps, { ...MESSAGE, maxTokens: 5_000_000 })

    const sent = calls.map((call) => (JSON.parse(call.body) as { max_tokens: number }).max_tokens)
    expect(sent[0]).toBeGreaterThan(1024)
    expect(sent[1]).toBeLessThanOrEqual(8192)
  })

  it('reads the answer from the text blocks, wherever they are', async () => {
    answerWith(() =>
      json(
        200,
        message([
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.\n' }
        ])
      )
    )

    expect(await sendWithKey(await stored(), MESSAGE)).toEqual({ status: 'text', text: 'First part. Second part.' })
  })

  it('keeps an answer that was cut at the token limit', async () => {
    answerWith(() => json(200, message([{ type: 'text', text: 'It is probably' }], 'max_tokens')))

    expect(await sendWithKey(await stored(), MESSAGE)).toEqual({ status: 'text', text: 'It is probably' })
  })

  it('answers declined when the model refuses, even with text in the reply', async () => {
    answerWith(() => json(200, message([{ type: 'text', text: 'I cannot help with that.' }], 'refusal')))

    expect(await sendWithKey(await stored(), MESSAGE)).toEqual({ status: 'failed', why: 'declined' })
  })

  it('answers declined for a refusal with no content', async () => {
    answerWith(() => json(200, message([], 'refusal')))

    expect(await sendWithKey(await stored(), MESSAGE)).toEqual({ status: 'failed', why: 'declined' })
  })

  it.each([
    ['only thinking, cut at the token limit', message([{ type: 'thinking', thinking: '', signature: 'sig' }], 'max_tokens')],
    ['no content', message([])],
    ['only white space', message([{ type: 'text', text: ' \n ' }])],
    ['a body that is not a message', { hello: 'world' }]
  ])('answers error for a reply with %s', async (_name, body) => {
    answerWith(() => json(200, body))

    expect(await sendWithKey(await stored(), MESSAGE)).toEqual({ status: 'failed', why: 'error' })
  })

  it.each([
    [401, 'authentication_error', 'key-rejected'],
    [401, 'invalid_request_error', 'key-rejected'],
    [429, 'rate_limit_error', 'limit-reached'],
    [402, 'billing_error', 'limit-reached'],
    [400, 'billing_error', 'limit-reached'],
    [400, 'invalid_request_error', 'error'],
    [403, 'permission_error', 'error'],
    [404, 'not_found_error', 'error'],
    [500, 'api_error', 'error'],
    [529, 'overloaded_error', 'error']
  ] as const)('maps HTTP %i %s to %s and drops its text', async (status, type, why) => {
    const calls = answerWith((call) =>
      json(status, apiError(type, `rejected ${call.headers.get('authorization')} for C:\\Users\\Lila`))
    )

    const reply = await sendWithKey(await stored(), MESSAGE)

    expect(reply).toEqual({ status: 'failed', why })
    expect(calls).toHaveLength(1)
    expectNoKey(reply)
    expect(output).toEqual([])
  })

  it('answers offline when the network fails, and the error text goes nowhere', async () => {
    const calls = answerWith((call) => {
      throw new TypeError(`fetch failed with header ${call.headers.get('authorization')}`)
    })

    const reply = await sendWithKey(await stored(), MESSAGE)

    expect(reply).toEqual({ status: 'failed', why: 'offline' })
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.length).toBeLessThanOrEqual(2)
    expectNoKey(reply)
    expect(output).toEqual([])
  })

  it('answers error for a reply that is not JSON', async () => {
    answerWith(
      () => new Response('<html>proxy login</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    )

    expect(await sendWithKey(await stored(), MESSAGE)).toEqual({ status: 'failed', why: 'error' })
    expect(output).toEqual([])
  })
})
