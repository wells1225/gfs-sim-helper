// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLatest, stage } from './stage.ts'

const INSTALLER = Buffer.from('MZ pretend installer bytes for 0.3.0')
const SHA = createHash('sha512').update(INSTALLER).digest('base64')

// The shape electron-builder 26.18.0 writes (copied from a CI run's log).
function latestYml(options: { url?: string; sha512?: string; version?: string; eol?: string } = {}): string {
  const url = options.url ?? 'Sims-Helper-Setup-0.3.0.exe'
  const sha512 = options.sha512 ?? SHA
  const lines = [
    `version: ${options.version ?? '0.3.0'}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-24T22:00:40.718Z'",
    ''
  ]
  return lines.join(options.eol ?? '\n')
}

let root: string
let dist: string
let out: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sims-helper-stage-'))
  dist = join(root, 'dist')
  out = join(root, 'staged')
  await mkdir(dist)
  await writeFile(join(dist, 'Sims Helper Setup 0.3.0.exe'), INSTALLER)
  await writeFile(join(dist, 'Sims Helper Setup 0.3.0.exe.blockmap'), 'blockmap')
  await writeFile(join(dist, 'builder-debug.yml'), 'debug')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readLatest', () => {
  it('reads the version, the first file url and its sha512, with either line ending', () => {
    for (const eol of ['\n', '\r\n']) {
      expect(readLatest(latestYml({ eol }))).toEqual({ version: '0.3.0', url: 'Sims-Helper-Setup-0.3.0.exe', sha512: SHA })
    }
  })

  it('accepts a quoted url', () => {
    expect(readLatest(latestYml({ url: "'Sims-Helper-Setup-0.3.0.exe'" })).url).toBe('Sims-Helper-Setup-0.3.0.exe')
  })

  it('refuses a url that is not a bare installer file name', () => {
    for (const url of ['../Sims-Helper-Setup-0.3.0.exe', 'sub/Sims-Helper-Setup-0.3.0.exe', 'https://x/y.exe', 'Sims Helper Setup 0.3.0.exe', 'a.zip']) {
      expect(() => readLatest(latestYml({ url }))).toThrow(/not a bare installer file name/)
    }
  })

  it('refuses a file with no files entry', () => {
    expect(() => readLatest('version: 0.3.0\n')).toThrow(/files\[0\]/)
  })
})

describe('stage', () => {
  it('copies the installer under the exact name latest.yml gives, hyphens for spaces, beside latest.yml', async () => {
    await writeFile(join(dist, 'latest.yml'), latestYml())
    const staged = await stage({ dist, out })
    expect(staged).toEqual({ version: '0.3.0', url: 'Sims-Helper-Setup-0.3.0.exe', sha512: SHA })
    expect((await readdir(out)).sort()).toEqual(['Sims-Helper-Setup-0.3.0.exe', 'latest.yml'])
    expect(await readFile(join(out, 'Sims-Helper-Setup-0.3.0.exe'))).toEqual(INSTALLER)
    expect(await readFile(join(out, 'latest.yml'), 'utf8')).toBe(latestYml())
  })

  it('fails when the installer does not match the sha512 in latest.yml, and stages nothing', async () => {
    await writeFile(join(dist, 'latest.yml'), latestYml({ sha512: createHash('sha512').update('other').digest('base64') }))
    await expect(stage({ dist, out })).rejects.toThrow(/SHA-512 does not match/)
    await expect(readdir(out)).rejects.toThrow()
  })

  it('fails when the version is not the one expected', async () => {
    await writeFile(join(dist, 'latest.yml'), latestYml())
    await expect(stage({ dist, out, expectVersion: '0.4.0' })).rejects.toThrow(/names version 0.3.0, expected 0.4.0/)
  })

  it('fails when no built installer has that name', async () => {
    await writeFile(join(dist, 'latest.yml'), latestYml({ url: 'Sims-Helper-Setup-0.9.0.exe' }))
    await expect(stage({ dist, out })).rejects.toThrow(/no installer in .* for Sims-Helper-Setup-0.9.0.exe/)
  })

  it('fails when the output folder already holds files', async () => {
    await writeFile(join(dist, 'latest.yml'), latestYml())
    await mkdir(out)
    await writeFile(join(out, 'old.exe'), 'old')
    await expect(stage({ dist, out })).rejects.toThrow(/is not empty/)
  })
})
