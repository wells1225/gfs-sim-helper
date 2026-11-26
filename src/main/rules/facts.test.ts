// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { parseOptionsIni } from './facts.ts'
import { readFolderFacts } from './index.ts'

const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const USER_FOLDER = 'Users/Player/Documents/Electronic Arts/The Sims 4'
const game = (path: string) => ({ path, version: '1.129.39.1030', packs: [] })

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'sims-helper-facts-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('readFolderFacts on fixtures', () => {
  it('reads both switches off, the game exe date and the cache date on patch-day', async () => {
    const root = join(tmp, 'patch-day')
    await generateFixture(await loadSpec(join(SPECS_DIR, 'patch-day.json')), root)
    const facts = await readFolderFacts({
      folderPath: join(root, USER_FOLDER),
      game: game(join(root, 'Program Files (x86)/Origin Games/The Sims 4'))
    })
    expect(facts).toEqual({
      options: { status: 'ok', mods: 'off', scriptMods: 'off' },
      gameUpdatedAt: '2026-11-20T18:00:00.000Z',
      thumbCacheAt: '2026-10-20T10:00:00.000Z'
    })
  })

  it('reads both switches on for clean', async () => {
    const root = join(tmp, 'clean')
    await generateFixture(await loadSpec(join(SPECS_DIR, 'clean.json')), root)
    const facts = await readFolderFacts({
      folderPath: join(root, USER_FOLDER),
      game: game(join(root, 'Program Files/EA Games/The Sims 4'))
    })
    expect(facts.options).toEqual({ status: 'ok', mods: 'on', scriptMods: 'on' })
    expect(facts.thumbCacheAt).toBe('2026-11-20T18:00:00.000Z')
  })
})

describe('readFolderFacts on hand-made folders', () => {
  it('gives missing and nulls for an empty folder with no game', async () => {
    const folder = join(tmp, 'empty')
    await mkdir(folder, { recursive: true })
    expect(await readFolderFacts({ folderPath: folder, game: null })).toEqual({
      options: { status: 'missing' },
      gameUpdatedAt: null,
      thumbCacheAt: null
    })
  })

  it('gives a null game date when the exe is not where the game should be', async () => {
    const folder = join(tmp, 'no-exe')
    await mkdir(folder, { recursive: true })
    const facts = await readFolderFacts({ folderPath: folder, game: game(join(tmp, 'nowhere')) })
    expect(facts.gameUpdatedAt).toBeNull()
  })

  it('reports an Options.ini it cannot read as unreadable', async () => {
    const folder = join(tmp, 'unreadable')
    await mkdir(join(folder, 'Options.ini'), { recursive: true }) // a folder by that name cannot be read as a file
    const facts = await readFolderFacts({ folderPath: folder, game: null })
    expect(facts.options.status).toBe('unreadable')
  })

  it('reads a UTF-16 Options.ini', async () => {
    const folder = join(tmp, 'utf16')
    await mkdir(folder, { recursive: true })
    const text = '[options]\r\nmodsdisabled=0\r\nscriptmodsenabled=0\r\n'
    await writeFile(join(folder, 'Options.ini'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    expect((await readFolderFacts({ folderPath: folder, game: null })).options).toEqual({ status: 'ok', mods: 'on', scriptMods: 'off' })
  })
})

describe('parseOptionsIni', () => {
  it('maps modsdisabled 0/1 to on/off and scriptmodsenabled 1/0 to on/off', () => {
    expect(parseOptionsIni('[options]\nmodsdisabled=1\nscriptmodsenabled=0\n')).toEqual({ mods: 'off', scriptMods: 'off' })
    expect(parseOptionsIni('[options]\nmodsdisabled=0\nscriptmodsenabled=1\n')).toEqual({ mods: 'on', scriptMods: 'on' })
  })

  it('ignores case, spaces, a BOM-free CRLF file and keys outside [options]', () => {
    expect(parseOptionsIni('[other]\r\nmodsdisabled=1\r\n[Options]\r\n ModsDisabled = 0 \r\nSCRIPTMODSENABLED= 1\r\n')).toEqual({ mods: 'on', scriptMods: 'on' })
  })

  it('treats an absent key or an unexpected value as missing', () => {
    expect(parseOptionsIni('[options]\nfullscreen=1\n')).toEqual({ mods: 'missing', scriptMods: 'missing' })
    expect(parseOptionsIni('[options]\nmodsdisabled=yes\nscriptmodsenabled=\n')).toEqual({ mods: 'missing', scriptMods: 'missing' })
    expect(parseOptionsIni('modsdisabled=1\nscriptmodsenabled=0\n')).toEqual({ mods: 'missing', scriptMods: 'missing' })
  })
})
