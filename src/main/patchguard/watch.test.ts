// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import { createContext } from '../services.ts'
import { markGameVersionSeen, watchGameVersion } from './watch.ts'

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop()!, { recursive: true, force: true })
  }
})

async function makeHarness(options: { version?: string | null; now?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-p16-watch-')))
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

  let currentVersion = options.version === undefined ? '1.129.39.1030' : options.version
  if (currentVersion !== null) {
    await mkdir(join(installDir, 'Game', 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Game', 'Bin', 'TS4_x64.exe'), 'fake-exe')
  }

  let clockTime = new Date(options.now ?? '2026-11-26T12:00:00.000Z')

  const host: Host = {
    documentsDir,
    env: {
      USERNAME: 'Lila',
      ProgramFiles: programFiles
    },
    async readRegistry() {
      return currentVersion !== null ? installDir : undefined
    },
    async listProcesses() {
      return []
    },
    async fileVersion() {
      return currentVersion ?? undefined
    }
  }

  const paths = appPaths({ localAppData, appData, desktopDir, env: {} })
  const ctx = createContext({
    host,
    paths,
    clock: { now: () => clockTime },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    },
    emit: () => {},
    reveal: () => {}
  })

  return {
    root,
    ctx,
    paths,
    stateFile: join(paths.stateDir, 'game-version.json'),
    setVersion(v: string | null) {
      currentVersion = v
    },
    setNow(iso: string) {
      clockTime = new Date(iso)
    }
  }
}

describe('patchguard watch and seen', () => {
  it('stores current version on first run and reports changed: false', async () => {
    const { ctx, stateFile } = await makeHarness({ version: '1.129.39.1030', now: '2026-11-20T10:00:00.000Z' })

    const watch = await watchGameVersion(ctx)
    expect(watch).toEqual({
      current: '1.129.39.1030',
      lastSeen: '1.129.39.1030',
      changed: false,
      seenAt: '2026-11-20T10:00:00.000Z'
    })

    const saved = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(saved).toEqual({
      format: 1,
      version: '1.129.39.1030',
      seenAt: '2026-11-20T10:00:00.000Z'
    })
  })

  it('reports changed: true when game updates without advancing lastSeen', async () => {
    const { ctx, stateFile, setVersion, setNow } = await makeHarness({
      version: '1.129.39.1030',
      now: '2026-11-20T10:00:00.000Z'
    })

    await watchGameVersion(ctx)
    setVersion('1.130.12.1020')
    setNow('2026-11-26T15:00:00.000Z')

    const watch = await watchGameVersion(ctx)
    expect(watch).toEqual({
      current: '1.130.12.1020',
      lastSeen: '1.129.39.1030',
      changed: true,
      seenAt: '2026-11-20T10:00:00.000Z'
    })

    // Calling watch again still reports changed: true and leaves state file untouched
    const second = await watchGameVersion(ctx)
    expect(second).toEqual(watch)
    const saved = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(saved.version).toBe('1.129.39.1030')
  })

  it('treats an unreadable or invalid state file as first run', async () => {
    const { ctx, paths, stateFile } = await makeHarness({
      version: '1.130.12.1020',
      now: '2026-11-26T15:00:00.000Z'
    })
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(stateFile, '{not valid json', 'utf8')

    const watch = await watchGameVersion(ctx)
    expect(watch).toEqual({
      current: '1.130.12.1020',
      lastSeen: '1.130.12.1020',
      changed: false,
      seenAt: '2026-11-26T15:00:00.000Z'
    })

    // Wrong format number also counts as unreadable/first run
    await writeFile(stateFile, JSON.stringify({ format: 99, version: '1.0.0.0', seenAt: '2020-01-01T00:00:00.000Z' }))
    const watch2 = await watchGameVersion(ctx)
    expect(watch2.changed).toBe(false)
    expect(watch2.lastSeen).toBe('1.130.12.1020')
  })

  it('seen advances lastSeen to current and makes watch report changed: false', async () => {
    const { ctx, setVersion, setNow } = await makeHarness({
      version: '1.129.39.1030',
      now: '2026-11-20T10:00:00.000Z'
    })

    await watchGameVersion(ctx)
    setVersion('1.130.12.1020')
    setNow('2026-11-26T16:30:00.000Z')

    expect((await watchGameVersion(ctx)).changed).toBe(true)

    const seen = await markGameVersionSeen(ctx)
    expect(seen).toEqual({
      current: '1.130.12.1020',
      lastSeen: '1.130.12.1020',
      changed: false,
      seenAt: '2026-11-26T16:30:00.000Z'
    })

    expect(await watchGameVersion(ctx)).toEqual(seen)
  })

  it('returns changed: false with current: null when no game install is found', async () => {
    const { ctx } = await makeHarness({ version: null })
    const watch = await watchGameVersion(ctx)
    expect(watch).toEqual({
      current: null,
      lastSeen: null,
      changed: false,
      seenAt: null
    })
  })
})
