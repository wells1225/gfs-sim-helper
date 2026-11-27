// @vitest-environment node
// After main: the API key never reaches the report zip. The key is stored through PR 8's real gate, then PR 7's
// real buildReport writes the zip through the same gate, and every entry name and every unzipped byte is searched.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackupStatus } from '../../shared/model.ts'
import { sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Gate, GateDeps, SafeStorageLike } from '../ports.ts'
import { makeRedactor } from '../redact.ts'
import { buildReport } from '../report/index.ts'
import { runGate } from '../safety/gate.ts'
import { setKey } from './key-store.ts'

// Made up, and distinct, so a hit can only come from the key store.
const KEY = 'sk-ant-TEST-LEAK-CHECK-9999'
const MASK = 0x5a
const SEAL_MARK = [0x76, 0x31]

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

/** Masks every byte, so key.bin never holds the key in the clear (key-store.ts refuses one that does). */
function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Uint8Array.from([...SEAL_MARK, ...Buffer.from(text, 'utf8').map((b) => b ^ MASK)]),
    decryptString: (data) => {
      if (data[0] !== SEAL_MARK[0] || data[1] !== SEAL_MARK[1]) throw new Error('not sealed by this fake')
      return Buffer.from(data.subarray(2).map((b) => b ^ MASK)).toString('utf8')
    }
  }
}

describe('the report zip after a key is stored', () => {
  it('holds neither key.bin nor the key, in any entry name or content', async () => {
    // Real path first: macOS /var is a link, and the gate refuses a path that leads somewhere else.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-report-leak-')))
    roots.push(root)
    const player = join(root, 'Users', 'Player')
    const simsFolder = join(player, 'Documents', 'Electronic Arts', 'The Sims 4')
    const desktopDir = join(player, 'Desktop')
    const paths = appPaths({ localAppData: join(player, 'AppData', 'Local'), desktopDir })
    const cfFile = join(player, 'AppData', 'Roaming', 'CurseForge', 'agent', 'GameInstances', 'AddonGameInstance.json')

    await mkdir(join(simsFolder, 'Mods'), { recursive: true })
    await mkdir(desktopDir, { recursive: true })
    await mkdir(join(cfFile, '..'), { recursive: true })
    await writeFile(join(simsFolder, 'lastException_63887259912.txt'), 'AttributeError: NoneType object\n')
    await writeFile(join(simsFolder, 'Options.ini'), '[options]\nversion = 1\n')
    await writeFile(join(simsFolder, 'GameVersion.txt'), '1.129.39.1030\n')
    await writeFile(cfFile, '{"installedAddons":[]}\n')

    const gateDeps: GateDeps = {
      paths,
      gameState: async () => 'not-running',
      backupStatus: async (): Promise<BackupStatus> => ({ state: 'none' }),
      shareRoot: async () => null,
      modFolderRoot: () => null
    }
    const gate: Gate = { run: (request) => runGate(gateDeps, request) }

    // 1. The key goes into key.bin through the real gate, sealed.
    expect(await setKey({ gate, paths, safeStorage: fakeSafeStorage() }, KEY)).toBe('set')
    const keyBytes = await readFile(paths.keyFile)
    expect(keyBytes.length).toBeGreaterThan(1)
    expect(keyBytes.includes(Buffer.from(KEY, 'utf8'))).toBe(false)

    // 2. The report of a scan of that folder, written by PR 7's builder through the same gate.
    const base = sampleScan()
    const scan = sampleScan({
      folder: { ...base.folder, path: simsFolder },
      inventory: { ...base.inventory, curseForge: { status: 'found', file: cfFile, addons: [] } }
    })
    const { result, file } = await buildReport(
      { gate, paths, clock: { now: () => new Date(2026, 10, 25, 12, 0, 0) }, redact: makeRedactor({ USERNAME: 'Player' }) },
      scan
    )
    expect(result.status).toBe('saved')
    expect(file).not.toBeNull()
    expect((await stat(file!)).isFile()).toBe(true)

    // 3. Every entry, unzipped, searched for the key file's name and the key itself.
    const entries = unzipSync(new Uint8Array(await readFile(file!)))
    const names = Object.keys(entries)
    expect(names).toEqual(
      expect.arrayContaining([
        'lastException_63887259912.txt',
        'Options.ini',
        'GameVersion.txt',
        'scan.json',
        'AddonGameInstance.json'
      ])
    )
    const keyBytesClear = Buffer.from(KEY, 'utf8')
    for (const name of names) {
      expect(name.toLowerCase()).not.toContain('key.bin')
      expect(name).not.toContain(KEY)
      const content = Buffer.from(entries[name]!)
      expect(content.includes(keyBytesClear), `${name} holds the key`).toBe(false)
      expect(content.toString('utf8').toLowerCase(), `${name} names key.bin`).not.toContain('key.bin')
    }
  })
})
