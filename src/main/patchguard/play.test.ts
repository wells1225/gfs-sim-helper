// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import { createContext } from '../services.ts'
import { playGame } from './play.ts'

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop()!, { recursive: true, force: true })
  }
})

async function makePlayHarness(
  options: {
    version?: string | null
    storedVersion?: string | null
    running?: boolean
    createX64Exe?: boolean
    createDx9Exe?: boolean
    openGameFails?: boolean
  } = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-p16-play-')))
  temps.push(root)

  const programFiles = join(root, 'Program Files')
  const installDir = join(programFiles, 'EA Games', 'The Sims 4')
  const documentsDir = join(root, 'Documents')
  const localAppData = join(root, 'LocalAppData')
  const appData = join(root, 'Roaming')
  const desktopDir = join(root, 'Desktop')

  await mkdir(documentsDir, { recursive: true })
  await mkdir(localAppData, { recursive: true })
  await mkdir(appData, { recursive: true })
  await mkdir(desktopDir, { recursive: true })

  const hasInstall = options.version !== null
  const version = options.version === undefined ? '1.130.12.1020' : options.version
  const exePath = join(installDir, 'Game', 'Bin', 'TS4_x64.exe')
  if (hasInstall) {
    await mkdir(join(installDir, 'Game', 'Bin'), { recursive: true })
    if (options.createX64Exe !== false) {
      await writeFile(exePath, 'fake-x64-exe')
    }
    if (options.createDx9Exe) {
      await writeFile(join(installDir, 'Game', 'Bin', 'TS4_DX9_x64.exe'), 'fake-dx9-exe')
    }
  }

  const paths = appPaths({ localAppData, appData, desktopDir, env: {} })
  if (options.storedVersion) {
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(
      join(paths.stateDir, 'game-version.json'),
      JSON.stringify({ format: 1, version: options.storedVersion, seenAt: '2026-11-20T10:00:00.000Z' }),
      'utf8'
    )
  }

  const opened: string[] = []
  const host: Host = {
    documentsDir,
    env: { USERNAME: 'Lila', ProgramFiles: programFiles },
    async readRegistry() {
      return hasInstall ? installDir : undefined
    },
    async listProcesses() {
      return options.running ? ['TS4_x64.exe'] : []
    },
    async fileVersion() {
      return version ?? undefined
    }
  }

  const ctx = createContext({
    host,
    paths,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    },
    emit: () => {},
    reveal: () => {},
    openGame: async (path) => {
      opened.push(path)
      if (options.openGameFails) throw new Error('launch failed')
    }
  })

  return { ctx, paths, exePath, opened }
}

describe('patchguard play', () => {
  it('refuses with already-running when the game is open and does not call openGame', async () => {
    const { ctx, opened } = await makePlayHarness({ running: true })
    expect(await playGame(ctx, { ignoreUpdate: false })).toEqual({ kind: 'refused', why: 'already-running' })
    expect(opened).toEqual([])
  })

  it('stops with game-updated when version changed and ignoreUpdate is false', async () => {
    const { ctx, opened } = await makePlayHarness({
      version: '1.130.12.1020',
      storedVersion: '1.129.39.1030'
    })

    const answer = await playGame(ctx, { ignoreUpdate: false })
    expect(answer).toEqual({
      kind: 'stopped',
      why: 'game-updated',
      watch: {
        current: '1.130.12.1020',
        lastSeen: '1.129.39.1030',
        changed: true,
        seenAt: '2026-11-20T10:00:00.000Z'
      }
    })
    expect(opened).toEqual([])
  })

  it('opens TS4_x64.exe (never TS4_DX9_x64.exe) when version changed and ignoreUpdate is true', async () => {
    const { ctx, exePath, opened } = await makePlayHarness({
      version: '1.130.12.1020',
      storedVersion: '1.129.39.1030',
      createDx9Exe: true
    })

    expect(await playGame(ctx, { ignoreUpdate: true })).toEqual({ kind: 'started' })
    expect(opened).toEqual([exePath])
  })

  it('opens TS4_x64.exe without writing any state file on first run', async () => {
    const { ctx, paths, exePath, opened } = await makePlayHarness({
      version: '1.130.12.1020',
      storedVersion: null
    })

    expect(await playGame(ctx, { ignoreUpdate: false })).toEqual({ kind: 'started' })
    expect(opened).toEqual([exePath])
    await expect(stat(join(paths.stateDir, 'game-version.json'))).rejects.toThrow()
  })

  it('refuses with no-install when install is missing or only TS4_DX9_x64.exe exists', async () => {
    const missing = await makePlayHarness({ version: null })
    expect(await playGame(missing.ctx, { ignoreUpdate: false })).toEqual({ kind: 'refused', why: 'no-install' })
    expect(missing.opened).toEqual([])

    const dx9Only = await makePlayHarness({
      version: '1.130.12.1020',
      createX64Exe: false,
      createDx9Exe: true
    })
    expect(await playGame(dx9Only.ctx, { ignoreUpdate: false })).toEqual({ kind: 'refused', why: 'no-install' })
    expect(dx9Only.opened).toEqual([])
  })

  it('refuses with error when openGame fails', async () => {
    const { ctx, exePath, opened } = await makePlayHarness({
      version: '1.130.12.1020',
      storedVersion: '1.130.12.1020',
      openGameFails: true
    })

    expect(await playGame(ctx, { ignoreUpdate: false })).toEqual({ kind: 'refused', why: 'error' })
    expect(opened).toEqual([exePath])
  })
})
