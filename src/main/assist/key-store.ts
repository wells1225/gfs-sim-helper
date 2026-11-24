// The only file that holds the API key in the clear, decrypts it, or hands it to the network
// (contracts.md, section 8). Nothing here logs, and nothing here throws: an error can carry the key
// in its text, so every error is dropped and the caller gets one of a fixed set of answers.
import Anthropic from '@anthropic-ai/sdk'
import type { KeySetResult, KeyStatus } from '../../shared/model.ts'
import { openForRead } from '../fs-read.ts'
import type { AssistMessage, AssistReply, KeyStoreDeps } from '../ports.ts'

type FailReason = Extract<AssistReply, { status: 'failed' }>['why']

const FILE_VERSION = 1 // first byte of key.bin; the bytes from safeStorage.encryptString follow
const KEY_FILE_BYTES_AT_MOST = 64 * 1024
const KEY_CHARS_AT_MOST = 512
const USABLE_KEY = /^[\x21-\x7e]+$/ // what a request header can carry: no white space, no control characters

const API_URL = 'https://api.anthropic.com' // fixed here, so ANTHROPIC_BASE_URL cannot send the key elsewhere
const API_VERSION = '2026-10-21' // what SDK 1.13.0 sends; fixed here, so the environment cannot change it
const TIMEOUT_MS = 60_000
const RETRIES = 1
const ANSWER_TOKENS_AT_MOST = 4096
// Haiku 5.5 and Sonnet 5.5 think before they answer, and thinking counts toward max_tokens.
// Without this room a short answer budget can be used up before any text is written.
const THINKING_TOKENS = 2048

const FAIL_REASONS: readonly FailReason[] = ['no-key', 'key-rejected', 'declined', 'offline', 'limit-reached', 'error']

function failed(why: FailReason): AssistReply {
  return { status: 'failed', why }
}

function isUsableKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= KEY_CHARS_AT_MOST && USABLE_KEY.test(key)
}

function canEncrypt(deps: KeyStoreDeps): boolean {
  try {
    return deps.safeStorage.isEncryptionAvailable() === true
  } catch {
    return false
  }
}

/** The bytes for key.bin, or null when safeStorage did not really encrypt the key. */
function seal(deps: KeyStoreDeps, key: string): Uint8Array | null {
  try {
    const encrypted = Buffer.from(deps.safeStorage.encryptString(key))
    if (encrypted.length === 0 || encrypted.includes(Buffer.from(key, 'utf8'))) return null
    return Buffer.concat([Buffer.from([FILE_VERSION]), encrypted])
  } catch {
    return null
  }
}

/** The stored key, or null when there is no file, it is not ours, or it does not decrypt. Never writes. */
async function readStoredKey(deps: KeyStoreDeps): Promise<string | null> {
  try {
    const file = await readKeyFile(deps.paths.keyFile)
    if (file === null || file.length < 2 || file[0] !== FILE_VERSION) return null
    const key = deps.safeStorage.decryptString(file.subarray(1))
    return isUsableKey(key) ? key : null
  } catch {
    return null
  }
}

/** The file's bytes, or null when it is over the limit. The size is checked before anything is read. */
async function readKeyFile(path: string): Promise<Buffer | null> {
  const file = await openForRead(path)
  try {
    if (file.size > KEY_FILE_BYTES_AT_MOST) return null
    // Never more than the size seen above, so a file that grows meanwhile cannot fill the memory.
    const bytes = Buffer.alloc(file.size)
    return bytes.subarray(0, await file.read(bytes, 0))
  } finally {
    await file.close()
  }
}

export async function keyStatus(deps: KeyStoreDeps): Promise<KeyStatus> {
  try {
    if (!canEncrypt(deps)) return 'encryption-unavailable'
    return (await readStoredKey(deps)) === null ? 'not-set' : 'set'
  } catch {
    return 'not-set'
  }
}

export async function setKey(deps: KeyStoreDeps, key: string): Promise<KeySetResult> {
  let wanted: string | null = null // the key this call tried to store, if it was usable at all
  try {
    if (!canEncrypt(deps)) return 'encryption-unavailable'
    const trimmed = typeof key === 'string' ? key.trim() : null
    if (isUsableKey(trimmed)) {
      const data = seal(deps, trimmed)
      // Not encrypted, so not stored. A key stored before is still there and still works.
      if (data === null) return (await readStoredKey(deps)) === null ? 'encryption-unavailable' : 'not-saved'
      wanted = trimmed
      await deps.gate.run({
        reason: 'key',
        folderPath: null,
        ops: [{ op: 'write', path: deps.paths.keyFile, data, mode: 'replace' }]
      })
    }
  } catch {
    // Whatever went wrong, the answer below is read back from the disk.
  }
  return storedAfterSet(deps, wanted)
}

/**
 * What the disk holds after a try to store `wanted`. The gate's own answer is not trusted: 'set' is
 * only said when the stored key is the one asked for, and 'not-saved' when another key is still there.
 */
async function storedAfterSet(deps: KeyStoreDeps, wanted: string | null): Promise<KeySetResult> {
  try {
    if (!canEncrypt(deps)) return 'encryption-unavailable'
    const stored = await readStoredKey(deps)
    if (stored === null) return 'not-set'
    return stored === wanted ? 'set' : 'not-saved'
  } catch {
    return 'not-set'
  }
}

export async function clearKey(deps: KeyStoreDeps): Promise<KeyStatus> {
  try {
    await deps.gate.run({ reason: 'key', folderPath: null, ops: [{ op: 'remove', path: deps.paths.keyFile }] })
  } catch {
    // The status below is read back from the disk.
  }
  return keyStatus(deps)
}

function isSendable(message: AssistMessage): boolean {
  return (
    typeof message.model === 'string' &&
    message.model !== '' &&
    typeof message.system === 'string' &&
    typeof message.user === 'string' &&
    message.user !== '' &&
    Number.isInteger(message.maxTokens) &&
    message.maxTokens >= 1
  )
}

/** A reply built again from the fields the contract names, so nothing else a transport returns gets out. */
function knownReply(reply: AssistReply, key: string): AssistReply {
  if (reply.status === 'text') {
    const usable = typeof reply.text === 'string' && reply.text !== '' && !reply.text.includes(key)
    return usable ? { status: 'text', text: reply.text } : failed('error')
  }
  return failed(reply.status === 'failed' && FAIL_REASONS.includes(reply.why) ? reply.why : 'error')
}

export async function sendWithKey(deps: KeyStoreDeps, message: AssistMessage): Promise<AssistReply> {
  try {
    if (!isSendable(message)) return failed('error')
    // Decrypted for this one call and kept nowhere else.
    const key = canEncrypt(deps) ? await readStoredKey(deps) : null
    if (key === null) return failed('no-key')
    const transport = deps.transport ?? anthropicTransport
    const { model, system, user, maxTokens } = message
    return knownReply(await transport(key, { model, system, user, maxTokens }), key)
  } catch {
    return failed('error')
  }
}

/** Reads only the error's class and type, never its message: the message can hold the key or her paths. */
function reasonFor(error: unknown): FailReason {
  if (error instanceof Anthropic.APIConnectionError) return 'offline' // timeouts too
  // HTTP 401: the stored key no longer works. 'no-key' is only for a key that is not stored.
  if (error instanceof Anthropic.AuthenticationError) return 'key-rejected'
  if (error instanceof Anthropic.APIError && error.status === 401) return 'key-rejected'
  if (error instanceof Anthropic.RateLimitError) return 'limit-reached'
  if (error instanceof Anthropic.APIError && (error.status === 402 || error.type === 'billing_error')) {
    return 'limit-reached' // the account is out of credit
  }
  return 'error'
}

/** What the SDK gets when a request is not sent, or is answered with a redirect: an error it does not retry. */
function refused(): Response {
  return new Response(null, { status: 502, headers: { 'x-should-retry': 'false' } })
}

/**
 * The only way the built-in transport reaches the network. The SDK reads ANTHROPIC_CUSTOM_HEADERS and
 * has no option to turn that off, and its fetch follows redirects, so neither is left to the SDK:
 * - a request goes to API_URL and nowhere else,
 * - no redirect is followed: one would carry the message to another host, or the key along on this one,
 * - no header from the SDK is passed on. The four below are written here, the key from the stored one.
 * A failure of the network itself is thrown on to the SDK, which reports it as a connection error.
 */
export function guardedFetch(apiKey: string): typeof fetch {
  return async (input, init) => {
    let url: string
    let request: RequestInit
    try {
      if (typeof input !== 'string' && !(input instanceof URL)) return refused()
      const address = new URL(input)
      if (address.origin !== API_URL || address.username !== '' || address.password !== '') return refused()
      if (init?.method !== 'POST' || typeof init.body !== 'string') return refused()
      url = address.href
      request = {
        method: 'POST',
        body: init.body,
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          'anthropic-version': API_VERSION,
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        ...(init.signal ? { signal: init.signal } : {}) // the SDK's timeout
      }
    } catch {
      return refused()
    }
    // Looked up at the time of the call: the SDK is given this function, never the global one.
    const response = await globalThis.fetch(url, request)
    const redirected =
      response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)
    if (!redirected) return response
    try {
      await response.body?.cancel()
    } catch {
      // Nothing was going to be read from it.
    }
    return refused()
  }
}

/** The default transport: one Messages request, holding the system prompt and the text it was given. */
async function anthropicTransport(apiKey: string, message: AssistMessage): Promise<AssistReply> {
  try {
    const client = new Anthropic({
      apiKey,
      baseURL: API_URL,
      fetch: guardedFetch(apiKey),
      timeout: TIMEOUT_MS,
      maxRetries: RETRIES,
      logLevel: 'off',
      openTelemetry: false
    })
    const reply = await client.messages.create({
      model: message.model,
      max_tokens: Math.min(message.maxTokens, ANSWER_TOKENS_AT_MOST) + THINKING_TOKENS,
      output_config: { effort: 'low' },
      system: message.system,
      messages: [{ role: 'user', content: message.user }]
    })
    // Haiku has no server-side fallback, so a refusal is the final answer for this try.
    if (reply.stop_reason === 'refusal') return failed('declined')
    let text = ''
    for (const block of reply.content) {
      if (block.type === 'text') text += block.text
    }
    text = text.trim()
    return text === '' ? failed('error') : { status: 'text', text }
  } catch (error) {
    return failed(reasonFor(error))
  }
}
