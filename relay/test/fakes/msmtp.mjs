#!/usr/bin/env node
// A fake `msmtp` for the relay tests. Saves each message to $FAKE_MAIL_DIR. With FAKE_MSMTP_FAIL=1 it fails and,
// like a real SMTP error, quotes the recipient and a password line on stderr, so the tests can check they are hidden.
import fs from 'node:fs'
import path from 'node:path'

const chunks = []
for await (const c of process.stdin) chunks.push(c)
const message = Buffer.concat(chunks).toString('utf8')
const to = /^To: (.*)$/m.exec(message)?.[1] ?? ''

fs.appendFileSync(path.join(process.env.FAKE_MAIL_DIR, 'calls.log'), `${JSON.stringify(process.argv.slice(2))}\n`)

if (process.env.FAKE_MSMTP_FAIL === '1') {
  process.stderr.write(`msmtp: recipient address ${to} not accepted by the server\nmsmtp: password=hunter2-app-pass\n`)
  process.exit(75)
}
const n = fs.readdirSync(process.env.FAKE_MAIL_DIR).filter((f) => f.endsWith('.eml')).length
fs.writeFileSync(path.join(process.env.FAKE_MAIL_DIR, `mail-${n + 1}.eml`), message)
