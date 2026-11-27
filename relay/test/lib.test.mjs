import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { redact, takeLock, writeFileAtomic } from '../lib.mjs'
import { buildEmail } from '../request.mjs'

describe('takeLock', () => {
  let dir
  let file
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-'))
    file = path.join(dir, 'run.lock')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes a complete lock with a token, and leaves no temp files', () => {
    const release = takeLock(file)
    assert.ok(release)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(data.pid, process.pid)
    assert.equal(typeof data.token, 'string')
    assert.ok(data.token.length >= 16)
    assert.deepEqual(fs.readdirSync(dir), ['run.lock'])
    assert.equal(fs.statSync(file).mode & 0o077, 0)
    release()
    assert.deepEqual(fs.readdirSync(dir), [])
  })

  it('refuses while a live holder has it', () => {
    const release = takeLock(file)
    assert.equal(takeLock(file), null)
    release()
    const again = takeLock(file)
    assert.ok(again)
    again()
  })

  it('takes over a lock held by a live pid once it is older than an hour', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'old', at: '2026-01-01T00:00:00Z' }))
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(file, old, old)
    const release = takeLock(file)
    assert.ok(release)
    assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'old')
    release()
  })

  it('does not delete a lock another holder took over', () => {
    const release = takeLock(file)
    // Another run decided ours was stale and replaced it.
    fs.rmSync(file)
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'theirs', at: new Date().toISOString() }))
    release()
    assert.ok(fs.existsSync(file), 'the other holder keeps its lock')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'theirs')
  })

  it('leaves a recovery in progress alone', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, token: 'dead', at: '2026-01-01T00:00:00Z' }))
    fs.writeFileSync(`${file}.recover`, '')
    assert.equal(takeLock(file), null)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'dead')
  })
})

describe('writeFileAtomic', () => {
  it('leaves no temp file behind when the write fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-atomic-'))
    try {
      // Renaming a file over a folder fails.
      fs.mkdirSync(path.join(dir, 'target'))
      assert.throws(() => writeFileAtomic(path.join(dir, 'target'), 'x'))
      assert.deepEqual(fs.readdirSync(dir), ['target'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('redact', () => {
  for (const line of [
    '{"access_token": "ya29.SECRETVALUE", "expiry": "x"}',
    '{"refresh_token":"1//SECRETVALUE"}',
    "token: 'SECRETVALUE'",
    'Authorization: Bearer SECRETVALUE',
    'client_secret=SECRETVALUE',
  ]) {
    it(`hides the value in ${line.slice(0, 30)}`, () => {
      const out = redact(line)
      assert.ok(!out.includes('SECRETVALUE'), out)
      assert.ok(out.includes('<hidden>'))
    })
  }
})

describe('buildEmail', () => {
  const request = {
    format: 1,
    id: 'r-20261126-143000-ab12',
    at: '2026-11-26T14:30:00.000Z',
    text: 'hello',
    game: { version: '1.0', packs: [] },
    mods: [],
  }

  it('refuses a To address with a line break', () => {
    assert.throws(() => buildEmail('a@b.test\r\nBcc: c@d.test', request))
    assert.throws(() => buildEmail('a@b.test\nBcc: c@d.test', request))
  })

  it('keeps every line under the SMTP limit of 998 bytes', () => {
    const mail = buildEmail('a@b.test', {
      ...request,
      text: 'é'.repeat(2000),
      game: { version: '1.0', packs: Array.from({ length: 200 }, (_, i) => `Pack number ${i} with a long name`) },
      mods: Array.from({ length: 1000 }, (_, i) => `${'M'.repeat(150)} ${i}`),
    })
    for (const line of mail.split('\n')) assert.ok(Buffer.byteLength(line) <= 998, `line of ${Buffer.byteLength(line)} bytes`)
  })
})
