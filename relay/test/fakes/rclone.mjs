#!/usr/bin/env node
// A fake `rclone` for the relay tests. `<remote>:<path>` maps to $FAKE_DRIVE/<path>. Every call is appended to
// $FAKE_RCLONE_LOG as one JSON line. Errors name the remote on stderr, the way rclone does, so the tests can check
// that the relay hides it.
import fs from 'node:fs'
import path from 'node:path'

const drive = process.env.FAKE_DRIVE
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_RCLONE_LOG, `${JSON.stringify({ args, at: process.hrtime.bigint().toString() })}\n`)

const positional = args.filter((a) => !a.startsWith('--'))
const [cmd, ...rest] = positional

function local(target) {
  const m = /^([^:/]+):(.*)$/.exec(target)
  if (!m) return { remote: null, file: path.resolve(target) }
  return { remote: m[1], file: path.join(drive, m[2]) }
}

function fail(code, message) {
  process.stderr.write(`2026/11/26 12:00:00 ERROR : ${message}\n`)
  process.exit(code)
}

if (process.env.FAKE_RCLONE_FAIL === cmd) fail(1, `${rest.join(' ')}: failed to talk to drive (token=abc123)`)

if (cmd === 'lsjson') {
  const { file } = local(rest[0])
  if (!fs.existsSync(file) || !fs.statSync(file).isDirectory()) fail(3, `${rest[0]}: directory not found`)
  const filesOnly = args.includes('--files-only')
  const list = fs
    .readdirSync(file, { withFileTypes: true })
    .filter((d) => !filesOnly || d.isFile())
    .map((d) => ({
      Path: d.name,
      Name: d.name,
      Size: d.isFile() ? fs.statSync(path.join(file, d.name)).size : -1,
      IsDir: d.isDirectory(),
    }))
  process.stdout.write(JSON.stringify(list))
} else if (cmd === 'cat') {
  const { file } = local(rest[0])
  if (!fs.existsSync(file)) fail(3, `${rest[0]}: object not found`)
  process.stdout.write(fs.readFileSync(file))
} else if (cmd === 'copy') {
  const src = local(rest[0]).file
  const dst = local(rest[1]).file
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name))
} else if (cmd === 'copyto') {
  const src = local(rest[0]).file
  const dst = local(rest[1]).file
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
} else {
  fail(1, `fake rclone does not know ${cmd}`)
}
