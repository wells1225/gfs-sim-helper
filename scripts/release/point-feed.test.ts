// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localFeed, pointFeed } from './point-feed.ts'

// What electron-builder 26.18.0 put in the installed app (copied from a CI run's log).
const INSTALLED = 'owner: wells1225\nrepo: gfs-sim-helper\nprovider: github\nupdaterCacheDirName: sims-helper-updater\n'

describe('localFeed', () => {
  it('swaps the GitHub provider for a local generic feed and keeps the cache folder name', () => {
    expect(localFeed(INSTALLED, 47613)).toBe(
      'provider: generic\nurl: http://127.0.0.1:47613/\nupdaterCacheDirName: sims-helper-updater\n'
    )
  })

  it('reads a file with Windows line ends', () => {
    expect(localFeed(INSTALLED.replaceAll('\n', '\r\n'), 47613)).toContain('updaterCacheDirName: sims-helper-updater')
  })

  it('refuses a file that does not name the GitHub repo', () => {
    for (const text of [INSTALLED.replace('wells1225', 'someone'), INSTALLED.replace('provider: github', 'provider: generic'), '']) {
      expect(() => localFeed(text, 47613)).toThrow(/does not name the GitHub feed/)
    }
  })

  it('refuses a file with no cache folder name', () => {
    expect(() => localFeed(INSTALLED.replace(/updaterCacheDirName.*\n/, ''), 47613)).toThrow(/updaterCacheDirName/)
  })

  it('refuses a port that is not a number in range', () => {
    for (const port of [0, 70000, Number.NaN, 1.5]) expect(() => localFeed(INSTALLED, port)).toThrow(/port/)
  })
})

describe('pointFeed', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sims-helper-feed-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rewrites the file in place', async () => {
    const file = join(dir, 'app-update.yml')
    await writeFile(file, INSTALLED)
    await pointFeed(file, 47613)
    expect(await readFile(file, 'utf8')).toBe(localFeed(INSTALLED, 47613))
  })
})
