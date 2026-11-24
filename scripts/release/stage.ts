// Stages a built installer for an update feed: the GitHub release (release.yml) or the local feed of the PR 13 proof.
// electron-builder names the installer "Sims Helper Setup <v>.exe", but latest.yml names it "Sims-Helper-Setup-<v>.exe",
// and the updater asks for exactly that name. So the installer is copied under the name latest.yml gives, and its
// SHA-512 is checked against latest.yml, or every update fails with "not found" or a checksum error.
// Usage: node scripts/release/stage.ts --dist dist --out staged [--version 0.3.0]
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LatestInfo {
  version: string
  url: string // files[0].url: the installer's name on the feed
  sha512: string // base64, as latest.yml writes it
}

const BARE_INSTALLER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2]! : trimmed
}

/** Reads what the updater reads from latest.yml: the version and the first file. */
export function readLatest(text: string): LatestInfo {
  const yml = text.replaceAll('\r\n', '\n')
  const version = /^version: *(.+)$/m.exec(yml)?.[1]
  const first = /^files:\n +- url: *(.+)\n +sha512: *(.+)$/m.exec(yml)
  if (!version) throw new Error('latest.yml has no version')
  if (!first) throw new Error('latest.yml has no files[0] with a url and a sha512')
  const url = unquote(first[1]!)
  if (!BARE_INSTALLER_NAME.test(url)) throw new Error(`latest.yml url "${url}" is not a bare installer file name`)
  return { version: unquote(version), url, sha512: unquote(first[2]!) }
}

async function sha512Of(file: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

async function isEmptyOrMissing(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).length === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

export interface StageInput {
  dist: string // electron-builder's output folder, with latest.yml and the installer
  out: string // a new or empty folder: gets the installer under its feed name, and latest.yml
  expectVersion?: string
}

export async function stage({ dist, out, expectVersion }: StageInput): Promise<LatestInfo> {
  const latestText = await readFile(join(dist, 'latest.yml'), 'utf8')
  const latest = readLatest(latestText)
  if (expectVersion !== undefined && latest.version !== expectVersion) {
    throw new Error(`latest.yml names version ${latest.version}, expected ${expectVersion}`)
  }

  // The built file is the feed name with spaces where the feed has hyphens (or the feed name itself).
  const built = (await readdir(dist)).filter((name) => name.toLowerCase().endsWith('.exe') && name.replaceAll(' ', '-') === latest.url)
  if (built.length !== 1) throw new Error(`no installer in ${dist} for ${latest.url} (found ${built.length})`)
  const source = join(dist, built[0]!)

  if ((await sha512Of(source)) !== latest.sha512) {
    throw new Error(`${built[0]}: SHA-512 does not match latest.yml`)
  }
  if (!(await isEmptyOrMissing(out))) throw new Error(`${out} is not empty`)

  await mkdir(out, { recursive: true })
  const target = join(out, latest.url)
  await copyFile(source, target)
  if ((await sha512Of(target)) !== latest.sha512) throw new Error(`${latest.url}: SHA-512 changed while copying`)
  await copyFile(join(dist, 'latest.yml'), join(out, 'latest.yml'))
  return latest
}

function argValue(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

async function main(args: readonly string[]): Promise<void> {
  const dist = argValue(args, '--dist')
  const out = argValue(args, '--out')
  if (!dist || !out) throw new Error('usage: node scripts/release/stage.ts --dist <folder> --out <folder> [--version x.y.z]')
  const expectVersion = argValue(args, '--version')
  const staged = await stage({ dist: resolve(dist), out: resolve(out), ...(expectVersion ? { expectVersion } : {}) })
  console.log(`staged ${staged.url} (version ${staged.version}) and latest.yml in ${resolve(out)}`)
}

const entry = process.argv[1]
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
