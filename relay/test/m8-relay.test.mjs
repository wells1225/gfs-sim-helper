import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { RELAY, SECRET_TO, makeEnv } from './helpers.mjs'

const ID = 'r-20261126-143000-ab12'
const ID2 = 'r-20261126-150000-cd34'

describe('m8-relay', () => {
  let t
  beforeEach(() => {
    t = makeEnv()
  })
  afterEach(() => {
    t.assertNoSecrets()
    t.cleanup()
  })

  it('emails Tyler once about a new request and marks it seen', async () => {
    t.addRequest(ID)
    const r = await t.run(RELAY)
    assert.equal(r.code, 0, r.stderr)
    const mails = t.mails()
    assert.equal(mails.length, 1)
    const [mail] = mails
    assert.match(mail, new RegExp(`^To: ${SECRET_TO.replace(/\./g, '\\.')}$`, 'm'))
    assert.match(mail, /^Subject: Lila asked for a mod$/m)
    assert.ok(mail.includes('A mod where my Sims notice new outfits.\nAnd say something nice!'))
    assert.ok(mail.includes('Game version: 1.112.519.1020'))
    assert.ok(mail.includes('Packs: EP01 Get to Work, GP04 Vampires'))
    assert.ok(mail.includes('Mods she has: MC Command Center, UI Cheats Extension'))
    assert.ok(mail.includes('Build it in T3: gfs-sim-helper'))
    assert.deepEqual(t.seen().seen, [ID])
    // msmtp gets the recipient from the To header, not from its command line.
    const calls = fs.readFileSync(path.join(t.mail, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(calls, [['-t']])
    assert.ok(!fs.existsSync(t.lockFile), 'the lock is released')
  })

  it('sends nothing on the second run', async () => {
    t.addRequest(ID)
    assert.equal((await t.run(RELAY)).code, 0)
    const r = await t.run(RELAY)
    assert.equal(r.code, 0)
    assert.equal(t.mails().length, 1)
    assert.match(r.stdout, /No new requests/)
    // The second run did not read the request again.
    assert.equal(t.rcloneCalls().filter((a) => a[0] === 'cat').length, 1)
  })

  it('leaves a request unseen when the email fails, and sends it on the next run', async () => {
    t.addRequest(ID)
    const failed = await t.run(RELAY, [], { FAKE_MSMTP_FAIL: '1' })
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /msmtp for r-20261126-143000-ab12 failed \(exit 75\)/)
    assert.equal(t.mails().length, 0)
    const seen = fs.existsSync(t.seenFile) ? t.seen().seen : []
    assert.deepEqual(seen, [])

    const retried = await t.run(RELAY)
    assert.equal(retried.code, 0, retried.stderr)
    assert.equal(t.mails().length, 1)
    assert.deepEqual(t.seen().seen, [ID])
  })

  it('skips a bad request, never logs its text, and still sends the good one', async () => {
    const marker = 'PRIVATE-TEXT-MARKER'
    t.addRequest(ID, { text: `${marker} hello\u0007bell` })
    t.addRequest(ID2)
    const r = await t.run(RELAY)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /Skipped request r-20261126-143000-ab12: text has control characters/)
    assert.ok(!(r.stdout + r.stderr).includes(marker))
    assert.equal(t.mails().length, 1)
    assert.ok(!t.mails()[0].includes(marker))
    assert.deepEqual(t.seen(), { format: 1, seen: [ID2], skipped: [ID] })

    // It is logged once, not every run.
    const again = await t.run(RELAY)
    assert.ok(!again.stderr.includes('Skipped'))
    assert.equal(t.mails().length, 1)
  })

  for (const [name, overrides, raw, reason] of [
    ['too long', { text: 'x'.repeat(2001) }, undefined, /longer than 2000/],
    ['wrong format', { format: 2 }, undefined, /format is not 1/],
    ['id mismatch', { id: 'r-20261126-143000-zz99' }, undefined, /does not match/],
    ['not JSON', {}, '{"format":1, "text": "PRIVATE-TEXT-MARKER', /not valid JSON/],
    ['empty text', { text: '   ' }, undefined, /text is empty/],
    ['bidi override', { text: 'PRIVATE-TEXT-MARKER \u202e' }, undefined, /control characters/],
    ['bad mod label', { mods: ['ok', 'PRIVATE-TEXT-MARKER\nX'] }, undefined, /mods has a bad entry/],
    ['huge file', {}, JSON.stringify({ pad: 'PRIVATE-TEXT-MARKER'.repeat(4000) }), /size/],
  ]) {
    it(`skips a request that is ${name}`, async () => {
      t.addRequest(ID, overrides, raw)
      const r = await t.run(RELAY)
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, reason)
      assert.ok(!(r.stdout + r.stderr).includes('PRIVATE-TEXT-MARKER'))
      assert.equal(t.mails().length, 0)
      assert.deepEqual(t.seen().skipped, [ID])
    })
  }

  it('accepts 2000 characters counted as characters, and CRLF line ends', async () => {
    t.addRequest(ID, { text: `${'é'.repeat(1990)}\r\n${'🙂'.repeat(8)}` })
    const r = await t.run(RELAY)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(t.mails().length, 1)
    assert.ok(!t.mails()[0].includes('\r\n🙂'))
  })

  it('ignores files that are not request files without naming them', async () => {
    fs.mkdirSync(path.join(t.drive, 'requests'), { recursive: true })
    fs.writeFileSync(path.join(t.drive, 'requests', 'PRIVATE-TEXT-MARKER.json'), '{}')
    const r = await t.run(RELAY)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Ignored 1 file/)
    assert.ok(!(r.stdout + r.stderr).includes('PRIVATE-TEXT-MARKER'))
    assert.equal(t.mails().length, 0)
  })

  it('treats a missing requests folder as nothing to do, and hides the remote name in errors', async () => {
    const r = await t.run(RELAY)
    assert.equal(r.code, 0, r.stderr)
    const failed = await t.run(RELAY, [], { FAKE_RCLONE_FAIL: 'lsjson' })
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /rclone lsjson failed \(exit 1\)/)
    assert.match(failed.stderr, /<hidden>/)
  })

  it('refuses to run when the config can be read by others', async () => {
    t.addRequest(ID)
    fs.chmodSync(t.configFile, 0o640)
    const r = await t.run(RELAY)
    assert.equal(r.code, 2)
    assert.match(r.stderr, /can be read by other users/)
    assert.equal(t.rcloneCalls().length, 0)
    assert.equal(t.mails().length, 0)
  })

  it('refuses a config with a bad field without printing its value', async () => {
    fs.writeFileSync(t.configFile, JSON.stringify({ to: SECRET_TO, rcloneRemote: 'bad remote/zzhiddenremote' }))
    const r = await t.run(RELAY)
    assert.equal(r.code, 2)
    assert.match(r.stderr, /"rcloneRemote" is missing/)
    assert.ok(!r.stderr.includes('bad remote'))
  })

  it('does not run while another live run holds the lock', async () => {
    t.addRequest(ID)
    fs.mkdirSync(path.dirname(t.lockFile), { recursive: true })
    fs.writeFileSync(t.lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    const r = await t.run(RELAY)
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Another relay run/)
    assert.equal(t.rcloneCalls().length, 0)
    assert.ok(fs.existsSync(t.lockFile), 'the other run keeps its lock')
  })

  it('takes over a lock left by a run that is gone', async () => {
    t.addRequest(ID)
    fs.mkdirSync(path.dirname(t.lockFile), { recursive: true })
    fs.writeFileSync(t.lockFile, JSON.stringify({ pid: 999999, at: '2026-01-01T00:00:00Z' }))
    const r = await t.run(RELAY)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(t.mails().length, 1)
  })
})

describe('m8-relay webhook', () => {
  it('posts the request after the email, and a failed webhook does not resend the email', async () => {
    const received = []
    let status = 200
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) })
        res.writeHead(status).end()
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/hook/SECRET-HOOK-TOKEN-42`
    const t = makeEnv({ webhookUrl: url })
    try {
      t.addRequest(ID)
      const r = await t.run(RELAY)
      assert.equal(r.code, 0, r.stderr)
      assert.equal(received.length, 1)
      assert.equal(received[0].method, 'POST')
      assert.equal(received[0].type, 'application/json')
      assert.equal(received[0].body.id, ID)
      assert.equal(received[0].body.format, 1)

      status = 500
      t.addRequest(ID2)
      const r2 = await t.run(RELAY)
      assert.equal(r2.code, 0, r2.stderr)
      assert.match(r2.stderr, /Webhook for request r-20261126-150000-cd34 failed \(status 500\)/)
      assert.equal(t.mails().length, 2)
      assert.deepEqual(t.seen().seen, [ID, ID2])
      t.assertNoSecrets()
    } finally {
      server.close()
      t.cleanup()
    }
  })
})
