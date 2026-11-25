import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { IpcInvoke } from '../../../src/shared/ipc.ts'

const execFileAsync = promisify(execFile)
const MAKE_FIXTURE_SCRIPT = resolve(process.cwd(), 'scripts/fixtures/make-fixture.ts')

export interface InOrder<T> {
  readonly __simsHelperInOrder: true
  readonly values: readonly T[]
}

export function inOrder<T>(values: readonly T[]): InOrder<T> {
  return { __simsHelperInOrder: true, values }
}

export type StubIpcMap = {
  [K in keyof IpcInvoke]?: IpcInvoke[K]['res'] | InOrder<IpcInvoke[K]['res']>
}

export interface LaunchAppOptions {
  fixture?: string
  env?: Record<string, string | undefined>
  shareDir?: string // PR 14: a local folder that stands in for Google Drive, as SIMS_HELPER_SHARE_DIR
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  tempDir: string | null
  fixtureRoot: string | null
  desktopDir: string | null
  localAppData: string | null
  consoleErrors: string[]
  close(): Promise<void>
}

function deleteCaseInsensitive(map: Record<string, string>, key: string): void {
  const lower = key.toLowerCase()
  for (const existing of Object.keys(map)) {
    if (existing.toLowerCase() === lower) {
      delete map[existing]
    }
  }
}

function cleanEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string') result[k] = v
  }
  deleteCaseInsensitive(result, 'ELECTRON_RUN_AS_NODE')
  for (const [k, v] of Object.entries(overrides)) {
    deleteCaseInsensitive(result, k)
    if (v !== undefined) {
      result[k] = v
    }
  }
  return result
}

/** The environment for a launched app: updates are off and no host share dir leaks unless the caller says otherwise. */
export function launchEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string | undefined>): Record<string, string> {
  return cleanEnv(base, { SIMS_HELPER_UPDATES: 'off', SIMS_HELPER_SHARE_DIR: undefined, ...overrides })
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  let tempDir: string | null = null
  let fixtureRoot: string | null = null
  let desktopDir: string | null = null
  let localAppData: string | null = null
  let envOverrides: Record<string, string | undefined> = {}

  if (options.fixture) {
    tempDir = await mkdtemp(join(tmpdir(), `sims-helper-e2e-${options.fixture}-`))
    await execFileAsync(process.execPath, [MAKE_FIXTURE_SCRIPT, '--out', tempDir, options.fixture], {
      cwd: process.cwd(),
      timeout: 60_000
    })
    fixtureRoot = join(tempDir, options.fixture)

    const userRoot = join(fixtureRoot, 'Users', 'Player')
    const documentsDir = join(userRoot, 'Documents')
    desktopDir = join(userRoot, 'Desktop')
    localAppData = join(userRoot, 'AppData', 'Local')
    const appData = join(userRoot, 'AppData', 'Roaming')

    await Promise.all([
      mkdir(documentsDir, { recursive: true }),
      mkdir(desktopDir, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
      mkdir(appData, { recursive: true })
    ])

    envOverrides = {
      SIMS_HELPER_DOCUMENTS_DIR: documentsDir,
      SIMS_HELPER_DESKTOP_DIR: desktopDir,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      USERNAME: 'Player',
      USERPROFILE: userRoot,
      OneDrive: join(userRoot, 'OneDrive'),
      OneDriveConsumer: undefined,
      OneDriveCommercial: undefined,
      ProgramFiles: join(fixtureRoot, 'Program Files'),
      'ProgramFiles(x86)': join(fixtureRoot, 'Program Files (x86)')
    }
  }

  const shareDir = options.shareDir?.trim()
  if (shareDir) {
    envOverrides = { ...envOverrides, SIMS_HELPER_SHARE_DIR: shareDir }
  }

  if (options.env) {
    envOverrides = { ...envOverrides, ...options.env }
  }

  const installedExe = process.env['SIMS_HELPER_EXE']
  if (installedExe && !existsSync(installedExe)) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    throw new Error(`Installed executable not found at: ${installedExe}`)
  }

  const env = launchEnv(process.env, envOverrides)
  const launchOptions = installedExe
    ? { executablePath: installedExe, env }
    : { args: [resolve(process.cwd(), 'out/main/index.js')], env }

  const app = await electron.launch(launchOptions)
  const consoleErrors: string[] = []

  try {
    const page = await app.firstWindow()
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })
    await page.waitForLoadState('domcontentloaded')

    return {
      app,
      page,
      tempDir,
      fixtureRoot,
      desktopDir,
      localAppData,
      consoleErrors,
      async close(): Promise<void> {
        try {
          await app.close()
        } finally {
          if (tempDir) {
            await rm(tempDir, { recursive: true, force: true })
          }
        }
      }
    }
  } catch (err) {
    await app.close().catch(() => {})
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    throw err
  }
}

export async function stubIpc(app: ElectronApplication, stubs: StubIpcMap): Promise<void> {
  await app.evaluate(({ ipcMain }, entries) => {
    for (const [channel, value] of entries) {
      ipcMain.removeHandler(channel)
      if (
        value &&
        typeof value === 'object' &&
        '__simsHelperInOrder' in value &&
        (value as { __simsHelperInOrder?: unknown }).__simsHelperInOrder === true
      ) {
        const list = (value as { readonly values: readonly unknown[] }).values
        let index = 0
        ipcMain.handle(channel, async () => {
          const item = list[Math.min(index, list.length - 1)]
          index += 1
          return item
        })
      } else {
        ipcMain.handle(channel, async () => value)
      }
    }
  }, Object.entries(stubs))

  const page = await app.firstWindow()
  await page.reload({ waitUntil: 'domcontentloaded' })
}

export async function shoot(page: Page, prSlug: string, name: string): Promise<void> {
  const outDir = resolve(process.cwd(), 'test-results', 'screens', prSlug)
  await mkdir(outDir, { recursive: true })
  await page.setViewportSize({ width: 960, height: 700 })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await setColorScheme(page, 'light')
  await page.screenshot({ path: join(outDir, `${name}-light.png`) })

  await setColorScheme(page, 'dark')
  await page.screenshot({ path: join(outDir, `${name}-dark.png`) })

  await page.emulateMedia({ colorScheme: 'light' })
}

export async function setColorScheme(page: Page, colorScheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme })
  await nextFrame(page)
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const g = globalThis as unknown as { requestAnimationFrame(cb: () => void): number }
        g.requestAnimationFrame(() => g.requestAnimationFrame(() => done()))
      })
  )
}
