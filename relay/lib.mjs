// Shared helpers for the M8 relay scripts. Plain Node 22, no npm packages.
//
// Rules this file keeps:
// - No config value is ever printed. Everything the scripts print goes through `say`/`warn`, which replace every
//   config value (and anything that looks like an email address, a URL or a key=value secret) with <hidden>.
// - Child processes are started with argument arrays, never through a shell.
// - ~/.msmtprc is never read here: msmtp reads it itself.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HIDDEN = '<hidden>'

export const REQUEST_ID = /^r-\d{8}-\d{6}-[a-z0-9]{4}$/
export const REQUEST_FILE = /^r-\d{8}-\d{6}-[a-z0-9]{4}\.json$/

export function configPath() {
  return path.join(os.homedir(), '.config', 'sims-helper-relay', 'config.json')
}

export function stateDir() {
  return path.join(os.homedir(), '.local', 'state', 'sims-helper-relay')
}

// ---------------------------------------------------------------------------------------------------------------
// Output, always redacted

const secrets = new Set()

export function addSecret(value) {
  if (typeof value === 'string' && value.length > 0) secrets.add(value)
}

export function redact(text) {
  let out = String(text)
  // Longest first, so a value that contains another is hidden whole.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(HIDDEN)
  out = out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, HIDDEN)
  out = out.replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+/g, HIDDEN)
  out = out.replace(/((?:pass|token|key|secret)[a-z_-]*\s*[=:]\s*)\S+/gi, `$1${HIDDEN}`)
  return out
}

export function say(message) {
  process.stdout.write(`${redact(message)}\n`)
}

export function warn(message) {
  process.stderr.write(`${redact(message)}\n`)
}

/** A short, redacted, single-line tail of a child's stderr, for a log line. */
export function stderrTail(stderr) {
  const oneLine = redact(String(stderr ?? '')).replace(/\s+/g, ' ').trim()
  return oneLine.length > 300 ? `...${oneLine.slice(-300)}` : oneLine
}

// ---------------------------------------------------------------------------------------------------------------
// Config

export class RefusedError extends Error {}

const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const EMAIL = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/

/**
 * Reads ~/.config/sims-helper-relay/config.json. Refuses when the file is readable or writable by anyone but its
 * owner, or is not owned by this user. Error messages name the field, never its value.
 * Returns { to, remote, webhookUrl | null }.
 */
export function loadConfig() {
  const file = configPath()
  let st
  try {
    st = fs.statSync(file)
  } catch {
    throw new RefusedError(`No config file at ${file}. See relay/README.md.`)
  }
  if (!st.isFile()) throw new RefusedError(`${file} is not a file.`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new RefusedError(`${file} must be owned by you.`)
  }
  if ((st.mode & 0o077) !== 0) {
    throw new RefusedError(`${file} can be read by other users. Run: chmod 600 ${file}`)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new RefusedError(`${file} is not valid JSON.`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RefusedError(`${file} must hold an object.`)

  // Register every string value as a secret before checking any of them.
  for (const v of Object.values(raw)) addSecret(typeof v === 'string' ? v : undefined)
  if (typeof raw.rcloneRemote === 'string') addSecret(raw.rcloneRemote.replace(/:$/, ''))

  const to = raw.to
  if (typeof to !== 'string' || !EMAIL.test(to)) throw new RefusedError('Config field "to" is missing or not an email address.')

  const remote = typeof raw.rcloneRemote === 'string' ? raw.rcloneRemote.replace(/:$/, '') : ''
  if (!REMOTE_NAME.test(remote)) {
    throw new RefusedError('Config field "rcloneRemote" is missing or not a plain rclone remote name (like simsdrive).')
  }

  let webhookUrl = null
  if (raw.webhookUrl !== undefined && raw.webhookUrl !== null && raw.webhookUrl !== '') {
    let u
    try {
      u = new URL(raw.webhookUrl)
    } catch {
      throw new RefusedError('Config field "webhookUrl" is not a URL.')
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
      throw new RefusedError('Config field "webhookUrl" must start with https:// (plain http only to this machine).')
    }
    webhookUrl = u.toString()
    addSecret(webhookUrl)
  }
  return { to, remote, webhookUrl }
}

// ---------------------------------------------------------------------------------------------------------------
// Child processes

/**
 * Runs `cmd` with an argument array (no shell). Kills it after `timeoutMs`, or when stdout passes `maxBytes`.
 * Resolves { code, stdout, stderr, overflow, timedOut }; never rejects except when the program cannot start.
 */
export function run(cmd, args, { input, timeoutMs = 120_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    } catch (e) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e?.code ?? 'spawn failed'), overflow: false, timedOut: false })
      return
    }
    const out = []
    let outLen = 0
    let err = ''
    let overflow = false
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outLen += chunk.length
      if (outLen > maxBytes) {
        if (!overflow) {
          overflow = true
          child.kill('SIGKILL')
        }
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (err.length < 64 * 1024) err += chunk.toString('utf8')
    })
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: err, overflow, timedOut })
    }
    child.on('error', (e) => {
      err += String(e?.code ?? 'error')
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
    child.stdin.on('error', () => {})
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Describes a failed run for a log line: exit code and a redacted stderr tail. */
export function describeFailure(name, r) {
  if (r.timedOut) return `${name} timed out`
  if (r.overflow) return `${name} printed more than expected and was stopped`
  const tail = stderrTail(r.stderr)
  return `${name} failed (exit ${r.code})${tail ? `: ${tail}` : ''}`
}

// rclone exits 3 for "directory not found".
export const RCLONE_DIR_NOT_FOUND = 3

// ---------------------------------------------------------------------------------------------------------------
// Files

/** Writes `data` to `file` atomically: a temp file in the same folder, fsync, then rename. */
export function writeFileAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  try {
    const dfd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dfd)
    } finally {
      fs.closeSync(dfd)
    }
  } catch {
    // Some systems cannot fsync a folder; the rename is still atomic.
  }
}

const LOCK_STALE_MS = 60 * 60 * 1000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * Takes an exclusive lock file. Returns a release function, or null when another live run holds it.
 * A lock whose process is gone, or that is older than an hour, is taken over.
 */
export function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      fs.closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        fs.rmSync(file, { force: true })
      }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
    let holder = null
    let age = 0
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'))
      age = Date.now() - fs.statSync(file).mtimeMs
    } catch {
      holder = null
    }
    const stale = !holder || !pidAlive(holder.pid) || age > LOCK_STALE_MS
    if (!stale) return null
    fs.rmSync(file, { force: true })
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Text checks

// C0 and C1 controls, DEL, line and paragraph separators, and bidi overrides and isolates (they can make an email
// line read differently from what it holds).
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const CONTROL_ANY = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/

export function hasControl(text, { allowNewline = false } = {}) {
  return (allowNewline ? CONTROL_EXCEPT_NEWLINE : CONTROL_ANY).test(text)
}

/** Length in characters (code points), the way a person counts them. */
export function charCount(text) {
  let n = 0
  for (const _ of text) n++
  return n
}
