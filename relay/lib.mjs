// Shared helpers for the M8 relay scripts. Plain Node 22, no npm packages.
//
// Rules this file keeps:
// - No config value is ever printed. Everything the scripts print goes through `say`/`warn`, which replace every
//   config value (and anything that looks like an email address, a URL or a key=value secret) with <hidden>.
// - Child processes are started with argument arrays, never through a shell.
// - ~/.msmtprc is never read here: msmtp reads it itself.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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
  out = out.replace(/\b(bearer|basic)\s+[^\s,"']+/gi, `$1 ${HIDDEN}`)
  // key=value, key: value, and JSON "access_token": "value" (quoted or not), for any key naming a secret.
  out = out.replace(
    /((?:pass|token|key|secret|auth)[a-z_-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
    `$1${HIDDEN}`,
  )
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
  // Open once without following a link, then check and read that same open file, so nothing can be swapped in
  // between the check and the read.
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e?.code === 'ELOOP' || e?.code === 'EMLINK') throw new RefusedError(`${file} is a link. Make it a plain file.`)
    if (e?.code === 'ENOENT') throw new RefusedError(`No config file at ${file}. See relay/README.md.`)
    throw new RefusedError(`${file} cannot be opened (${e?.code ?? 'error'}).`)
  }
  let text
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new RefusedError(`${file} is not a file.`)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new RefusedError(`${file} must be owned by you.`)
    }
    if ((st.mode & 0o077) !== 0) {
      throw new RefusedError(`${file} can be read by other users. Run: chmod 600 ${file}`)
    }
    if (st.size > 64 * 1024) throw new RefusedError(`${file} is too large.`)
    text = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RefusedError(`${file} is not valid JSON.`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RefusedError(`${file} must hold an object.`)

  // Register every string value as a secret before checking any of them.
  for (const v of Object.values(raw)) addSecret(typeof v === 'string' ? v : undefined)
  if (typeof raw.rcloneRemote === 'string') addSecret(raw.rcloneRemote.replace(/:$/, ''))

  const to = raw.to
  if (typeof to !== 'string' || hasControl(to) || !EMAIL.test(to)) throw new RefusedError('Config field "to" is missing or not an email address.')

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

function fsyncDir(dir) {
  try {
    const dfd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dfd)
    } finally {
      fs.closeSync(dfd)
    }
  } catch {
    // Some systems cannot fsync a folder; the rename or link is still atomic.
  }
}

function tempName(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
}

/** Writes `data` to a new file (never an existing one) and fsyncs it. Removes it again if anything fails. */
function writeNewFile(file, data, mode) {
  const fd = fs.openSync(file, 'wx', mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  } catch (e) {
    try {
      fs.closeSync(fd)
    } catch {
      // already closed
    }
    fs.rmSync(file, { force: true })
    throw e
  }
}

/** Writes `data` to `file` atomically: a temp file in the same folder, fsync, then rename. */
export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = tempName(file)
  writeNewFile(tmp, data, mode)
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fsyncDir(path.dirname(file))
}

const LOCK_STALE_MS = 60 * 60 * 1000
const RECOVER_STALE_MS = 5 * 60 * 1000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/** Reads a lock file without following a link: { dev, ino, mtimeMs, holder } (holder null if unreadable), or null. */
function readLock(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
  try {
    const st = fs.fstatSync(fd)
    let holder = null
    try {
      if (st.isFile() && st.size <= 4096) holder = JSON.parse(fs.readFileSync(fd, 'utf8'))
    } catch {
      holder = null
    }
    return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, holder }
  } finally {
    fs.closeSync(fd)
  }
}

function sameFile(a, b) {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file)
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

/**
 * Removes `file` if its holder is gone or it is older than an hour. Only one process recovers at a time: it holds
 * `<file>.recover` while it re-reads the lock and checks that the file it removes is the one it judged stale.
 * Returns true when the lock was removed (or had already gone), so the caller may try again.
 */
function recoverStaleLock(file) {
  const recover = `${file}.recover`
  try {
    fs.closeSync(fs.openSync(recover, 'wx', 0o600))
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e
    // Another run is recovering. A recover lock left by a run that crashed is cleared for the next run.
    const st = lstatOrNull(recover)
    if (st && Date.now() - st.mtimeMs > RECOVER_STALE_MS) fs.rmSync(recover, { force: true })
    return false
  }
  try {
    const seen = readLock(file)
    if (seen === null) return true
    const live = seen.holder && pidAlive(seen.holder.pid) && Date.now() - seen.mtimeMs <= LOCK_STALE_MS
    if (live) return false
    if (!sameFile(seen, lstatOrNull(file))) return false
    fs.rmSync(file, { force: true })
    return true
  } finally {
    fs.rmSync(recover, { force: true })
  }
}

/**
 * Takes an exclusive lock file. Returns a release function, or null when another run holds it.
 *
 * The lock is written whole to a temp file first and then hard-linked into place, so `file` is never seen empty or
 * half written. A lock whose process is gone, or that is older than an hour, is taken over (see recoverStaleLock).
 * Release removes the lock only while it is still this run's own file.
 */
export function takeLock(file) {
  const token = crypto.randomBytes(16).toString('hex')
  const tmp = tempName(file)
  writeNewFile(tmp, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 0o600)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(tmp, file)
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e
        if (!recoverStaleLock(file)) return null
        continue
      }
      fsyncDir(path.dirname(file))
      const mine = lstatOrNull(file)
      let released = false
      return () => {
        if (released) return
        released = true
        const now = readLock(file)
        if (sameFile(mine, now) && now.holder?.token === token && sameFile(now, lstatOrNull(file))) {
          fs.rmSync(file, { force: true })
        }
      }
    }
    return null
  } finally {
    fs.rmSync(tmp, { force: true })
  }
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
