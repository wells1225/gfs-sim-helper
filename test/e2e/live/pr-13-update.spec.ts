// The PR 13 proof on real Windows (.github/workflows/pr-13-update.yml): installed version A updates itself to B,
// served from a local feed, through the real updater and the real installer. A tampered B is refused.
// It skips itself unless SIMS_HELPER_UPDATE_FEED_DIR names a folder staged by scripts/release/stage.ts.
import { expect, test, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { launchApp, type LaunchedApp } from '../support/app.ts'

const run = promisify(execFile)

const FEED_DIR = process.env['SIMS_HELPER_UPDATE_FEED_DIR']
const FEED_PORT = Number(process.env['SIMS_HELPER_UPDATE_FEED_PORT'] ?? '47613')
const UPDATES_ON = { SIMS_HELPER_UPDATES: undefined } // launchApp switches updates off unless told otherwise

test.describe.configure({ mode: 'serial' })
test.skip(!FEED_DIR, 'needs SIMS_HELPER_UPDATE_FEED_DIR: the pr-13-update workflow sets it')

let server: Server
let latestOverride: string | null = null
let versionB = ''

test.beforeAll(async () => {
  const dir = FEED_DIR!
  // Read here, not with scripts/release/stage.ts: Playwright loads specs as CommonJS, and that script is a module.
  versionB = /^version: *(\S+)/m.exec(await readFile(join(dir, 'latest.yml'), 'utf8'))?.[1] ?? ''
  if (!versionB) throw new Error(`no version in ${join(dir, 'latest.yml')}`)
  server = createServer((req, res) => {
    // The updater adds ?noCache=..., so only the file name counts. Nothing outside the feed folder is served.
    const name = basename(decodeURIComponent(new URL(req.url ?? '/', 'http://feed').pathname))
    console.log(`feed: ${req.method} ${req.url}`)
    const send = (body: Buffer) => {
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' })
      res.end(body)
    }
    if (name === 'latest.yml' && latestOverride !== null) return send(Buffer.from(latestOverride))
    readFile(join(dir, name)).then(send, () => {
      res.writeHead(404, { 'Content-Length': 0 })
      res.end()
    })
  })
  await new Promise<void>((done) => server.listen(FEED_PORT, '127.0.0.1', done))
})

test.afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()))
})

async function powershell(script: string): Promise<string> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60_000 })
  return stdout.trim()
}

interface AppProcess {
  pid: number
  commandLine: string
}

/** The main "Sims Helper.exe" processes (not Electron's helper processes, which carry --type=). */
async function mainAppProcesses(): Promise<AppProcess[]> {
  const json = await powershell(
    `@(Get-CimInstance Win32_Process -Filter "Name='Sims Helper.exe'" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`
  )
  const rows = (json ? JSON.parse(json) : []) as { ProcessId: number; CommandLine: string | null }[] | { ProcessId: number; CommandLine: string | null }
  return (Array.isArray(rows) ? rows : [rows])
    .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine ?? '' }))
    .filter((row) => !row.commandLine.includes('--type='))
}

async function installerRunning(pendingDir: string): Promise<boolean> {
  const out = await powershell(
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${pendingDir.replaceAll("'", "''")}', 'OrdinalIgnoreCase') }).Count`
  )
  return Number(out) > 0
}

async function exeVersion(exe: string): Promise<string> {
  return await powershell(`(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`)
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 1000))
  }
}

async function appFacts(app: ElectronApplication) {
  return await app.evaluate(({ app: electronApp }) => ({
    version: electronApp.getVersion(),
    userData: electronApp.getPath('userData'),
    documents: electronApp.getPath('documents'),
    localAppData: process.env['LOCALAPPDATA'] ?? ''
  }))
}

async function closeQuietly(running: LaunchedApp | null): Promise<void> {
  await running?.close().catch(() => {})
}

const isUnder = (path: string, parent: string) => path.toLowerCase().startsWith(`${parent.toLowerCase().replace(/\\+$/, '')}\\`)

test('a tampered update is refused: the download fails, nothing is kept, the version stays', async () => {
  test.setTimeout(4 * 60_000)
  const good = await readFile(join(FEED_DIR!, 'latest.yml'), 'utf8')
  const wrong = createHash('sha512').update('not the installer').digest('base64')
  latestOverride = good.replace(/sha512: *\S+/g, `sha512: ${wrong}`)

  let running: LaunchedApp | null = null
  try {
    running = await launchApp({ env: UPDATES_ON })
    const { app, page } = running
    const before = await appFacts(app)
    console.log(`version A: ${before.version}, feed offers B: ${versionB}`)

    await expect(page.getByText('A new version of Sims Helper is ready.')).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Update now' }).click()
    await expect(page.getByText("The update didn't download. Nothing changed.")).toBeVisible({ timeout: 120_000 })

    const pendingDir = join(before.localAppData, 'sims-helper-updater', 'pending')
    const kept = await readdir(pendingDir).catch(() => [] as string[])
    console.log(`pending folder after the refused download: ${pendingDir} -> [${kept.join(', ')}]`)
    expect(kept.filter((name) => name.toLowerCase().endsWith('.exe'))).toEqual([])
    expect((await appFacts(app)).version).toBe(before.version)
  } finally {
    latestOverride = null
    await closeQuietly(running)
  }
})

test('version A updates itself to B: Update now, Restart now, and B opens', async () => {
  test.setTimeout(8 * 60_000)
  const exe = process.env['SIMS_HELPER_EXE']!
  let running: LaunchedApp | null = null
  try {
    running = await launchApp({ env: UPDATES_ON })
    const { app, page } = running
    const before = await appFacts(app)
    expect(before.version).not.toBe(versionB)

    await expect(page.getByText('A new version of Sims Helper is ready.')).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Update now' }).click()
    await expect(page.getByText('The update is ready. Sims Helper will close and open again to finish.')).toBeVisible({
      timeout: 180_000
    })

    const cacheDir = join(before.localAppData, 'sims-helper-updater')
    const pendingDir = join(cacheDir, 'pending')
    console.log(`updater cache folder: ${cacheDir} -> pending [${(await readdir(pendingDir)).join(', ')}]`)
    console.log(`userData: ${before.userData}`)
    console.log(`Documents: ${before.documents}`)
    expect(isUnder(cacheDir, before.documents)).toBe(false)
    expect(isUnder(before.userData, before.documents)).toBe(false)

    const closed = app.waitForEvent('close', { timeout: 60_000 })
    await page.getByRole('button', { name: 'Restart now' }).click()
    await closed
    running = null
    console.log('A closed itself for the install')

    const reopened = await until('the installer to finish and open the app again', 240_000, async () => {
      if (await installerRunning(pendingDir)) return null
      const [main] = await mainAppProcesses()
      return main ?? null
    })
    console.log(`reopened by the installer: pid ${reopened.pid}, command line: ${reopened.commandLine}`)
    expect.soft(reopened.commandLine).toContain('--updated')
    const installed = await exeVersion(exe)
    console.log(`installed exe version: ${installed}`)
    expect(installed.startsWith(versionB)).toBe(true)

    await run('taskkill', ['/F', '/T', '/IM', 'Sims Helper.exe']).catch(() => {})
    await until('the reopened app to stop', 30_000, async () => (await mainAppProcesses()).length === 0)

    running = await launchApp() // updates off again, so B never asks GitHub
    const after = await appFacts(running.app)
    console.log(`version after the update: ${after.version}`)
    expect(after.version).toBe(versionB)
  } finally {
    await closeQuietly(running)
  }
})
