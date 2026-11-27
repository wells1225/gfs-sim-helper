#!/usr/bin/env node
// M8 relay, one run. A systemd user timer starts it every 5 minutes on tyler-M8.
//
// Lists `requests/` in the shared Drive folder through rclone, and for each `r-*.json` it has not seen: checks it,
// emails Tyler through msmtp, optionally POSTs it to the webhook in the config, then records its id as seen.
// A failed email leaves the request unseen, so the next run tries again. A request that fails the checks is logged
// (id and reason only, never its text) and not looked at again.
//
// Setup: relay/README.md. Nothing here reads ~/.msmtprc or prints a config value.

import fs from 'node:fs'
import path from 'node:path'
import {
  RCLONE_DIR_NOT_FOUND,
  REQUEST_FILE,
  RefusedError,
  describeFailure,
  loadConfig,
  run,
  say,
  stateDir,
  takeLock,
  warn,
  writeFileAtomic,
} from './lib.mjs'
import { MAX_REQUEST_BYTES, buildEmail, validateRequest } from './request.mjs'

const WEBHOOK_TIMEOUT_MS = 15_000

function loadSeen(file) {
  // A broken seen.json would make every request email again; stop instead.
  const broken = () => new RefusedError(`${file} cannot be read. Fix or remove it.`)
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') return { seen: new Set(), skipped: new Set() }
    throw broken()
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw broken()
  for (const key of ['seen', 'skipped']) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some((s) => typeof s !== 'string'))) {
      throw broken()
    }
  }
  return { seen: new Set(data.seen ?? []), skipped: new Set(data.skipped ?? []) }
}

function saveSeen(file, state) {
  const data = { format: 1, seen: [...state.seen].sort(), skipped: [...state.skipped].sort() }
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function postWebhook(url, request) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      redirect: 'error',
    })
    await res.body?.cancel().catch(() => {})
    return res.ok ? null : `status ${res.status}`
  } catch (e) {
    return e?.name === 'TimeoutError' ? 'timed out' : 'could not connect'
  }
}

async function main() {
  const config = loadConfig()
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const release = takeLock(path.join(dir, 'run.lock'))
  if (!release) {
    say('Another relay run is still going; this one stops.')
    return 0
  }
  try {
    return await runOnce(config, dir)
  } finally {
    release()
  }
}

async function runOnce(config, dir) {
  const seenFile = path.join(dir, 'seen.json')
  const state = loadSeen(seenFile)
  const remote = `${config.remote}:`

  const listed = await run('rclone', ['lsjson', '--files-only', '--no-mimetype', `${remote}requests`], { timeoutMs: 120_000 })
  if (listed.code === RCLONE_DIR_NOT_FOUND) {
    say('No requests folder yet; nothing to do.')
    return 0
  }
  if (listed.code !== 0 || listed.overflow || listed.timedOut) {
    warn(describeFailure('rclone lsjson', listed))
    return 1
  }
  let entries
  try {
    entries = JSON.parse(listed.stdout.toString('utf8'))
    if (!Array.isArray(entries)) throw new Error('not a list')
  } catch {
    warn('rclone lsjson printed something that is not a list.')
    return 1
  }

  let unnamed = 0
  const fresh = []
  for (const e of entries) {
    const name = typeof e?.Name === 'string' ? e.Name : ''
    if (!REQUEST_FILE.test(name)) {
      unnamed++
      continue
    }
    const id = name.slice(0, -'.json'.length)
    if (state.seen.has(id) || state.skipped.has(id)) continue
    fresh.push({ id, name, size: typeof e.Size === 'number' ? e.Size : -1 })
  }
  if (unnamed > 0) say(`Ignored ${unnamed} file(s) in requests/ whose names are not request names.`)
  fresh.sort((a, b) => a.id.localeCompare(b.id))

  let failures = 0
  for (const item of fresh) {
    const skip = (reason) => {
      warn(`Skipped request ${item.id}: ${reason}.`)
      state.skipped.add(item.id)
      saveSeen(seenFile, state)
    }
    if (item.size < 0 || item.size > MAX_REQUEST_BYTES) {
      skip(`its size is not between 0 and ${MAX_REQUEST_BYTES} bytes`)
      continue
    }
    const read = await run('rclone', ['cat', `${remote}requests/${item.name}`], {
      timeoutMs: 60_000,
      maxBytes: MAX_REQUEST_BYTES,
    })
    if (read.overflow) {
      skip(`it is larger than ${MAX_REQUEST_BYTES} bytes`)
      continue
    }
    if (read.code !== 0 || read.timedOut) {
      warn(describeFailure(`rclone cat for ${item.id}`, read))
      failures++
      continue
    }
    const checked = validateRequest(read.stdout.toString('utf8'), item.id)
    if (!checked.ok) {
      skip(checked.reason)
      continue
    }

    const mail = await run('msmtp', ['-t'], { input: buildEmail(config.to, checked.request), timeoutMs: 60_000 })
    if (mail.code !== 0 || mail.timedOut) {
      warn(`Request ${item.id} stays unseen and is tried again next run. ${describeFailure(`msmtp for ${item.id}`, mail)}`)
      failures++
      continue
    }
    say(`Emailed Tyler about request ${item.id}.`)

    if (config.webhookUrl) {
      const problem = await postWebhook(config.webhookUrl, checked.request)
      if (problem) warn(`Webhook for request ${item.id} failed (${problem}). The email went out, so it is not retried.`)
      else say(`Posted request ${item.id} to the webhook.`)
    }

    state.seen.add(item.id)
    saveSeen(seenFile, state)
  }

  if (fresh.length === 0) say('No new requests.')
  return failures > 0 ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    if (e instanceof RefusedError) warn(`Refused: ${e.message}`)
    else warn(`Relay stopped on an unexpected error: ${e?.code ?? e?.name ?? 'unknown'} ${e?.message ?? ''}`)
    process.exitCode = 2
  },
)
