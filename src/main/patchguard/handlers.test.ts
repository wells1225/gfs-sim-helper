// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import { createContext } from '../services.ts'
import { patchGuardHandlers } from './handlers.ts'

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop()!, { recursive: true, force: true })
  }
})

describe('patchGuardHandlers', () => {
  it('wires all 5 patchguard IPC channels end-to-end', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-p16-handlers-')))
    temps.push(root)

    const programFiles = join(root, 'Program Files')
    const installDir = join(programFiles, 'EA Games', 'The Sims 4')
    const documentsDir = join(root, 'Documents')
    const localAppData = join(root, 'LocalAppData')
    const appData = join(root, 'Roaming')
    const desktopDir = join(root, 'Desktop')

    await mkdir(join(installDir, 'Game', 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Game', 'Bin', 'TS4_x64.exe'), 'fake-exe')
    await mkdir(documentsDir, { recursive: true })
    await mkdir(localAppData, { recursive: true })
    await mkdir(appData, { recursive: true })
    await mkdir(desktopDir, { recursive: true })

    let version = '1.129.39.1030'
    const opened: string[] = []
    const host: Host = {
      documentsDir,
      env: { USERNAME: 'Lila', ProgramFiles: programFiles },
      async readRegistry() {
        return installDir
      },
      async listProcesses() {
        return []
      },
      async fileVersion() {
        return version
      }
    }

    const ctx = createContext({
      host,
      paths: appPaths({ localAppData, appData, desktopDir, env: {} }),
      clock: { now: () => new Date('2026-11-26T12:00:00.000Z') },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (t) => Buffer.from(t, 'utf8'),
        decryptString: (b) => Buffer.from(b).toString('utf8')
      },
      emit: () => {},
      reveal: () => {},
      openGame: async (exe) => void opened.push(exe)
    })

    const h = patchGuardHandlers(ctx)

    // 1. First watch stores version
    const w1 = await h['patchguard:watch']()
    expect(w1.changed).toBe(false)
    expect(w1.current).toBe('1.129.39.1030')

    // 2. Game updates -> watch sees change, play stops
    version = '1.130.12.1020'
    const w2 = await h['patchguard:watch']()
    expect(w2.changed).toBe(true)

    const p1 = await h['patchguard:play']({ ignoreUpdate: false })
    expect(p1.kind).toBe('stopped')

    // 3. Seen advances lastSeen -> play starts
    const s1 = await h['patchguard:seen']()
    expect(s1.changed).toBe(false)
    expect(s1.lastSeen).toBe('1.130.12.1020')

    const p2 = await h['patchguard:play']({ ignoreUpdate: false })
    expect(p2).toEqual({ kind: 'started' })
    expect(opened).toEqual([join(installDir, 'Game', 'Bin', 'TS4_x64.exe')])

    // 4. Waiting & clear-holding
    expect(await h['patchguard:waiting']()).toEqual([])
    expect(await h['patchguard:clear-holding']({ entryId: 'missing' })).toEqual({
      kind: 'refused',
      why: 'not-found'
    })
  })
})
