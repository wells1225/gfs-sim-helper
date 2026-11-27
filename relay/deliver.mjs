#!/usr/bin/env node
// Deliver a finished mod for one request:
//
//   node relay/deliver.mjs <request id> <folder with the mod files> --title "<title>" --note "<note>" [--has-script]
//
// Checks every file (only .package and .ts4script, plain names, 200 MB at most), copies them to a private staging
// folder, hashes the copies (sha256), uploads them with rclone to `from-tyler/<id>/files/`, and only then writes
// `from-tyler/<id>/ready.json`. Her app treats a folder without ready.json as not finished.

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

const MAX_FILE_BYTES = 200_000_000
const MAX_TITLE_CHARS = 80
const MAX_NOTE_CHARS = 1000
const MAX_NAME_CHARS = 200
const ALLOWED = ['.package', '.ts4script']
const WINDOWS_BAD = /[<>:"|?*\\/]/

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

/** Why a file name is refused, or null when it is fine. */
function badName(name) {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return 'its name is empty or too long'
  if (name.includes('/') || name.includes('\\')) return 'its name has a slash'
  if (name.includes('..')) return 'its name has ".."'
  if (hasControl(name)) return 'its name has control characters'
  if (WINDOWS_BAD.test(name) || /[ .]$/.test(name) || name.startsWith('.')) return 'its name is not a safe Windows file name'
  if (!ALLOWED.some((ext) => name.endsWith(ext))) return 'only .package and .ts4script files can be delivered'
  return null
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
  if (problems.length > 0) throw new RefusedError(`Nothing was delivered. Fix these first:\n  ${problems.join('\n  ')}`)
  if (files.length === 0) throw new RefusedError(`${folder} has no .package or .ts4script files.`)
  return files
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function rclone(args, what) {
  const r = await run('rclone', args, { timeoutMs: 60 * 60 * 1000 })
  if (r.code !== 0 || r.timedOut || r.overflow) throw new RefusedError(describeFailure(what, r))
  return r
}

async function remoteNames(target) {
  const r = await run('rclone', ['lsjson', '--no-mimetype', target], { timeoutMs: 120_000 })
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

  const requests = await remoteNames(`${remote}requests`)
  if (!requests.includes(`${args.id}.json`)) throw new RefusedError(`There is no request ${args.id} in the shared folder.`)
  const existing = await remoteNames(`${remote}from-tyler/${args.id}`)
  if (existing.includes('ready.json')) {
    throw new RefusedError(`Request ${args.id} already has a ready.json. A delivery is written once.`)
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'sims-helper-deliver-'))
  try {
    fs.chmodSync(staging, 0o700)
    const filesDir = path.join(staging, 'files')
    fs.mkdirSync(filesDir, { mode: 0o700 })

    // Hash the copies that are uploaded, not the originals, so a file changed mid-run cannot slip past its hash.
    const files = []
    for (const name of names) {
      const copy = path.join(filesDir, name)
      fs.copyFileSync(path.join(args.folder, name), copy, fs.constants.COPYFILE_EXCL)
      const bytes = fs.statSync(copy).size
      if (bytes === 0 || bytes > MAX_FILE_BYTES) throw new RefusedError(`${JSON.stringify(name)} changed size while copying.`)
      files.push({ name, bytes, sha256: await sha256(copy) })
    }

    const hasScript = args.hasScriptFlag || names.some((n) => n.endsWith('.ts4script'))
    if (hasScript && !args.hasScriptFlag) say('A .ts4script file is included, so ready.json says hasScript: true.')

    await rclone(['copy', filesDir, `${remote}from-tyler/${args.id}/files`], 'rclone copy of the mod files')

    const ready = { format: 1, requestId: args.id, title: args.title, note: args.note, files, hasScript }
    const readyFile = path.join(staging, 'ready.json')
    fs.writeFileSync(readyFile, `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o600 })
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
