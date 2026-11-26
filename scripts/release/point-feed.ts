// CI only: points a copy of Sims Helper installed on the runner at a local feed, for the update proof
// (pr-13-update.yml, and release.yml's proof). It first checks the installed app names the GitHub repo, as every
// shipped copy must. The app's own code never changes its feed; this edits the runner's installed file.
// Usage: node scripts/release/point-feed.ts --app-update "<install>\resources\app-update.yml" --port 47613
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const GITHUB_FEED = ['provider: github', 'owner: wells1225', 'repo: gfs-sim-helper']

export function localFeed(installedText: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port ${port} is not a TCP port`)
  const lines = installedText.replaceAll('\r\n', '\n').split('\n').map((line) => line.trim())
  if (!GITHUB_FEED.every((line) => lines.includes(line))) {
    throw new Error('the installed app-update.yml does not name the GitHub feed for wells1225/gfs-sim-helper')
  }
  const cacheDir = lines.find((line) => line.startsWith('updaterCacheDirName:'))
  if (!cacheDir) throw new Error('the installed app-update.yml has no updaterCacheDirName')
  return `provider: generic\nurl: http://127.0.0.1:${port}/\n${cacheDir}\n`
}

export async function pointFeed(appUpdateFile: string, port: number): Promise<void> {
  await writeFile(appUpdateFile, localFeed(await readFile(appUpdateFile, 'utf8'), port))
}

function argValue(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const entry = process.argv[1]
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const args = process.argv.slice(2)
  const file = argValue(args, '--app-update')
  const port = Number(argValue(args, '--port'))
  if (!file) {
    console.error('usage: node scripts/release/point-feed.ts --app-update <file> --port <port>')
    process.exitCode = 1
  } else {
    pointFeed(file, port).then(
      async () => console.log(`${file} now reads:\n${await readFile(file, 'utf8')}`),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    )
  }
}
