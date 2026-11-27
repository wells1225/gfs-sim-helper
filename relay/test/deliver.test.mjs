import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DELIVER, makeEnv } from './helpers.mjs'

const ID = 'r-20261126-143000-ab12'
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

describe('deliver', () => {
  let t
  let mod
  beforeEach(() => {
    t = makeEnv()
    t.addRequest(ID)
    mod = path.join(t.root, 'built-mod')
    fs.mkdirSync(mod)
  })
  afterEach(() => {
    t.assertNoSecrets()
    t.cleanup()
  })

  const args = (...extra) => [ID, mod, '--title', 'Outfit Reactions', '--note', 'Sims react to new outfits.', ...extra]
  const out = () => path.join(t.drive, 'from-tyler', ID)

  it('uploads the files, then writes ready.json last with hashes', async () => {
    const pkg = Buffer.from('DBPF package bytes')
    const script = Buffer.from('PK script bytes')
    fs.writeFileSync(path.join(mod, 'OutfitReactions.package'), pkg)
    fs.writeFileSync(path.join(mod, 'OutfitReactions.ts4script'), script)

    const r = await t.run(DELIVER, args('--has-script'))
    assert.equal(r.code, 0, r.stderr)

    const ready = JSON.parse(fs.readFileSync(path.join(out(), 'ready.json'), 'utf8'))
    assert.deepEqual(ready, {
      format: 1,
      requestId: ID,
      title: 'Outfit Reactions',
      note: 'Sims react to new outfits.',
      files: [
        { name: 'OutfitReactions.package', bytes: pkg.length, sha256: sha(pkg) },
        { name: 'OutfitReactions.ts4script', bytes: script.length, sha256: sha(script) },
      ],
      hasScript: true,
    })
    assert.deepEqual(fs.readFileSync(path.join(out(), 'files', 'OutfitReactions.package')), pkg)
    assert.deepEqual(fs.readFileSync(path.join(out(), 'files', 'OutfitReactions.ts4script')), script)

    const writes = t.rcloneCalls().filter((a) => a[0] === 'copy' || a[0] === 'copyto')
    assert.equal(writes.length, 2)
    assert.equal(writes[0][0], 'copy')
    assert.match(writes[0][2], /:from-tyler\/r-20261126-143000-ab12\/files$/)
    assert.equal(writes.at(-1)[0], 'copyto')
    assert.match(writes.at(-1)[2], /:from-tyler\/r-20261126-143000-ab12\/ready\.json$/)
  })

  it('sets hasScript false for package-only mods without the flag', async () => {
    fs.writeFileSync(path.join(mod, 'Simple.package'), 'x')
    const r = await t.run(DELIVER, args())
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(out(), 'ready.json'), 'utf8')).hasScript, false)
  })

  it('sets hasScript when a .ts4script is there even without the flag', async () => {
    fs.writeFileSync(path.join(mod, 'A.ts4script'), 'x')
    const r = await t.run(DELIVER, args())
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(out(), 'ready.json'), 'utf8')).hasScript, true)
  })

  for (const [what, setup, reason] of [
    ['a .txt file', () => fs.writeFileSync(path.join(mod, 'readme.txt'), 'x'), /only \.package and \.ts4script/],
    ['a .zip file', () => fs.writeFileSync(path.join(mod, 'mod.zip'), 'x'), /only \.package and \.ts4script/],
    ['a name with ".."', () => fs.writeFileSync(path.join(mod, 'a..b.package'), 'x'), /has "\.\."/],
    ['a subfolder', () => fs.mkdirSync(path.join(mod, 'sub.package')), /not a plain file/],
    [
      'a link',
      () => {
        fs.writeFileSync(path.join(t.root, 'outside.package'), 'x')
        fs.symlinkSync(path.join(t.root, 'outside.package'), path.join(mod, 'link.package'))
      },
      /not a plain file/,
    ],
    ['an empty file', () => fs.writeFileSync(path.join(mod, 'empty.package'), ''), /empty/],
    [
      'a file over 200 MB',
      () => {
        const fd = fs.openSync(path.join(mod, 'big.package'), 'w')
        fs.ftruncateSync(fd, 200_000_001)
        fs.closeSync(fd)
      },
      /over 200 MB/,
    ],
  ]) {
    it(`refuses ${what} and uploads nothing`, async () => {
      fs.writeFileSync(path.join(mod, 'Good.package'), 'x')
      setup()
      const r = await t.run(DELIVER, args())
      assert.equal(r.code, 2)
      assert.match(r.stderr, reason)
      assert.ok(!fs.existsSync(out()))
      assert.equal(t.rcloneCalls().length, 0)
    })
  }

  it('refuses a folder with no mod files', async () => {
    const r = await t.run(DELIVER, args())
    assert.equal(r.code, 2)
    assert.match(r.stderr, /has no \.package or \.ts4script/)
  })

  it('refuses a request id that is not in the shared folder', async () => {
    fs.writeFileSync(path.join(mod, 'Good.package'), 'x')
    const r = await t.run(DELIVER, ['r-20261126-143000-zz99', mod, '--title', 'T', '--note', 'N'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /no request r-20261126-143000-zz99/)
    assert.ok(!fs.existsSync(path.join(t.drive, 'from-tyler')))
  })

  it('refuses a malformed id, a missing title or note, and a second delivery', async () => {
    fs.writeFileSync(path.join(mod, 'Good.package'), 'x')
    assert.match((await t.run(DELIVER, ['../evil', mod, '--title', 'T', '--note', 'N'])).stderr, /should look like/)
    assert.match((await t.run(DELIVER, [ID, mod, '--note', 'N'])).stderr, /--title is required/)
    assert.match((await t.run(DELIVER, [ID, mod, '--title', 'T'])).stderr, /--note is required/)
    assert.equal((await t.run(DELIVER, args())).code, 0)
    const again = await t.run(DELIVER, args())
    assert.equal(again.code, 2)
    assert.match(again.stderr, /already has a ready\.json/)
  })

  it('hides the remote name when rclone fails, and writes no ready.json', async () => {
    fs.writeFileSync(path.join(mod, 'Good.package'), 'x')
    const r = await t.run(DELIVER, args(), { FAKE_RCLONE_FAIL: 'copy' })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /rclone copy of the mod files failed/)
    assert.ok(!fs.existsSync(path.join(out(), 'ready.json')))
  })

  it('refuses when the config is group readable', async () => {
    fs.writeFileSync(path.join(mod, 'Good.package'), 'x')
    fs.chmodSync(t.configFile, 0o644)
    const r = await t.run(DELIVER, args())
    assert.equal(r.code, 2)
    assert.match(r.stderr, /can be read by other users/)
    assert.equal(t.rcloneCalls().length, 0)
  })
})
