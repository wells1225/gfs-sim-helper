#!/usr/bin/env node
// Deliver a finished mod for one request:
//
//   node relay/deliver.mjs <request id> <folder with the mod files> --title "<title>" --note "<note>" [--has-script]
//
// Checks every file (only .package and .ts4script, plain names, 200 MB at most, 500 files at most), copies them to
// a private staging folder, hashes the copies (sha256), checks ready.json stays within 256 KiB, uploads the files with
// rclone to `from-tyler/<id>/files/`, and only then writes `from-tyler/<id>/ready.json`. These are the limits her
// app enforces. Her app treats a folder without ready.json as not finished.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  RCLONE_DIR_NOT_FOUND,
  REQUEST_ID,
  RefusedError,
  charCount,
  describeFailure,
  hasControl,
  loadConfig,
  run,
  say,
  warn,
} from './lib.mjs'
import { MAX_FILES, MAX_READY_BYTES, badName, caseDuplicates } from './names.mjs'

const MAX_FILE_BYTES = 200_000_000
const MAX_TITLE_CHARS = 80
const MAX_NOTE_CHARS = 1000
const COPY_CHUNK = 1024 * 1024

const USAGE =
  'Usage: node relay/deliver.mjs <request id> <folder with the mod files> --title "<title>" --note "<note>" [--has-script]'

function parse(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { title: { type: 'string' }, note: { type: 'string' }, 'has-script': { type: 'boolean' } },
    })
  } catch {
    throw new RefusedError(USAGE)
  }
  const [id, folder, ...rest] = parsed.positionals
  if (!id || !folder || rest.length > 0) throw new RefusedError(USAGE)
  if (!REQUEST_ID.test(id)) throw new RefusedError('The request id should look like r-20261126-143000-ab12.')

  const title = (parsed.values.title ?? '').trim()
  if (!title) throw new RefusedError('--title is required.')
  if (charCount(title) > MAX_TITLE_CHARS) throw new RefusedError(`--title is longer than ${MAX_TITLE_CHARS} characters.`)
  if (hasControl(title)) throw new RefusedError('--title has control characters.')

  const note = (parsed.values.note ?? '').replace(/\r\n/g, '\n').trim()
  if (!note) throw new RefusedError('--note is required: say in plain words what the mod does and what else it needs.')
  if (charCount(note) > MAX_NOTE_CHARS) throw new RefusedError(`--note is longer than ${MAX_NOTE_CHARS} characters.`)
  if (hasControl(note, { allowNewline: true })) throw new RefusedError('--note has control characters.')

  return { id, folder: path.resolve(folder), title, note, hasScriptFlag: parsed.values['has-script'] === true }
}

function checkFolder(folder) {
  let st
  try {
    st = fs.statSync(folder)
  } catch {
    throw new RefusedError(`${folder} does not exist.`)
  }
  if (!st.isDirectory()) throw new RefusedError(`${folder} is not a folder.`)

  const problems = []
  const files = []
  for (const name of fs.readdirSync(folder).sort()) {
    const full = path.join(folder, name)
    const lst = fs.lstatSync(full)
    if (!lst.isFile()) {
      problems.push(`${JSON.stringify(name)}: not a plain file (folders and links cannot be delivered)`)
      continue
    }
    const why = badName(name)
    if (why) {
      problems.push(`${JSON.stringify(name)}: ${why}`)
      continue
    }
    if (lst.size === 0) problems.push(`${JSON.stringify(name)}: it is empty`)
    else if (lst.size > MAX_FILE_BYTES) problems.push(`${JSON.stringify(name)}: it is over 200 MB`)
    else files.push(name)
  }
  for (const group of caseDuplicates(files)) {
    problems.push(`${group.map((n) => JSON.stringify(n)).join(' and ')}: names that differ only in case clash on Windows`)
  }
  if (files.length > MAX_FILES) problems.push(`${files.length} files: her app accepts ${MAX_FILES} files at most`)
  if (problems.length > 0) throw new RefusedError(`Nothing was delivered. Fix these first:\n  ${problems.join('\n  ')}`)
  if (files.length === 0) throw new RefusedError(`${folder} has no .package or .ts4script files.`)
  return files
}

/**
 * Copies one source file into staging and hashes the bytes as they are written. The source is opened once without
 * following a link and checked on that open file; the copy stops if it reads past MAX_FILE_BYTES, so a file that is
 * swapped or grows after the folder check cannot get through.
 */
function copyAndHash(source, target, name) {
  let src
  try {
    src = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e?.code === 'ELOOP' || e?.code === 'EMLINK') throw new RefusedError(`${JSON.stringify(name)} became a link.`)
    throw new RefusedError(`${JSON.stringify(name)} cannot be opened (${e?.code ?? 'error'}).`)
  }
  try {
    const st = fs.fstatSync(src)
    if (!st.isFile()) throw new RefusedError(`${JSON.stringify(name)} is no longer a plain file.`)
    if (st.size === 0 || st.size > MAX_FILE_BYTES) throw new RefusedError(`${JSON.stringify(name)} changed size.`)
    const dst = fs.openSync(target, 'wx', 0o600)
    const hash = crypto.createHash('sha256')
    let bytes = 0
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK)
      for (;;) {
        const n = fs.readSync(src, buf, 0, buf.length, null)
        if (n === 0) break
        bytes += n
        if (bytes > MAX_FILE_BYTES) throw new RefusedError(`${JSON.stringify(name)} grew past 200 MB while copying.`)
        const chunk = buf.subarray(0, n)
        hash.update(chunk)
        let off = 0
        while (off < n) off += fs.writeSync(dst, chunk, off, n - off)
      }
      fs.fsyncSync(dst)
    } finally {
      fs.closeSync(dst)
    }
    if (bytes === 0) throw new RefusedError(`${JSON.stringify(name)} became empty while copying.`)
    return { name, bytes, sha256: hash.digest('hex') }
  } finally {
    fs.closeSync(src)
  }
}

async function rclone(args, what) {
  const r = await run('rclone', args, { timeoutMs: 60 * 60 * 1000 })
  if (r.code !== 0 || r.timedOut || r.overflow) throw new RefusedError(describeFailure(what, r))
  return r
}

async function remoteNames(target, { filesOnly = false } = {}) {
  const flags = ['lsjson', '--no-mimetype', ...(filesOnly ? ['--files-only'] : [])]
  const r = await run('rclone', [...flags, target], { timeoutMs: 120_000 })
  if (r.code === RCLONE_DIR_NOT_FOUND) return []
  if (r.code !== 0 || r.timedOut || r.overflow) throw new RefusedError(describeFailure('rclone lsjson', r))
  try {
    const list = JSON.parse(r.stdout.toString('utf8'))
    return Array.isArray(list) ? list.map((e) => e?.Name).filter((n) => typeof n === 'string') : []
  } catch {
    throw new RefusedError('rclone lsjson printed something that is not a list.')
  }
}

async function main() {
  const args = parse(process.argv.slice(2))
  const config = loadConfig()
  const remote = `${config.remote}:`
  const names = checkFolder(args.folder)

  const requests = await remoteNames(`${remote}requests`, { filesOnly: true })
  if (!requests.includes(`${args.id}.json`)) throw new RefusedError(`There is no request ${args.id} in the shared folder.`)
  const existing = await remoteNames(`${remote}from-tyler/${args.id}`, { filesOnly: true })
  if (existing.includes('ready.json')) {
    throw new RefusedError(`Request ${args.id} already has a ready.json. A delivery is written once.`)
  }

  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sims-helper-deliver-'))
  try {
    fs.chmodSync(staging, 0o700)
    const filesDir = path.join(staging, 'files')
    fs.mkdirSync(filesDir, { mode: 0o700 })

    // Hash the copies that are uploaded, not the originals, so a file changed mid-run cannot slip past its hash.
    const files = names.map((name) => copyAndHash(path.join(args.folder, name), path.join(filesDir, name), name))

    const hasScript = args.hasScriptFlag || names.some((n) => n.endsWith('.ts4script'))
    if (hasScript && !args.hasScriptFlag) say('A .ts4script file is included, so ready.json says hasScript: true.')

    // Build and size-check ready.json before uploading anything: her app marks a ready.json over 256 KiB broken.
    const ready = { format: 1, requestId: args.id, title: args.title, note: args.note, files, hasScript }
    const readyText = `${JSON.stringify(ready, null, 2)}\n`
    const readyBytes = Buffer.byteLength(readyText, 'utf8')
    if (readyBytes > MAX_READY_BYTES) {
      throw new RefusedError(
        `Nothing was delivered: ready.json would be ${readyBytes} bytes, over the 256 KiB (${MAX_READY_BYTES} bytes) her app accepts. Use fewer files or shorter names.`,
      )
    }
    const readyFile = path.join(staging, 'ready.json')
    fs.writeFileSync(readyFile, readyText, { mode: 0o600 })

    await rclone(['copy', filesDir, `${remote}from-tyler/${args.id}/files`], 'rclone copy of the mod files')

    await rclone(['copyto', readyFile, `${remote}from-tyler/${args.id}/ready.json`], 'rclone copyto of ready.json')

    say(`Delivered ${files.length} file(s) for request ${args.id}: ${args.title}`)
    for (const f of files) say(`  ${f.name}  ${f.bytes} bytes  sha256 ${f.sha256}`)
    return 0
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    if (e instanceof RefusedError) warn(`Refused: ${e.message}`)
    else warn(`Deliver stopped on an unexpected error: ${e?.code ?? e?.name ?? 'unknown'} ${e?.message ?? ''}`)
    process.exitCode = 2
  },
)
