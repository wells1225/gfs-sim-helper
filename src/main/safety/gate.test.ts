// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, posix, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { BackupStatus, GameRunState, GateRefusal } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import type { AppPaths, GateDeps, GateResult, WriteOp, WriteRequest } from '../ports.ts'
import { runGate, sortPath } from './gate.ts'
import type { GateRoots } from './gate.ts'

// The gate keeps no test seam. Faults are injected here, under its imports.
const disk = vi.hoisted(() => ({
  crossDrive: null as null | { from: string; hits: number; meanwhile?: () => Promise<void> },
  corruptNewFiles: null as null | { hits: number },
  realpathFails: null as null | { under: string; code: string; hits: number },
  beforeRealpath: null as null | ((target: string) => Promise<void>),
  statFails: null as null | { file: string; code: string; hits: number },
  statAs: null as null | { file: string; as: string },
  readdirFails: null as null | { under: string; code: string; hits: number },
  foldersRead: [] as string[],
  unlinkFails: null as null | { file: string; hits: number; meanwhile?: () => Promise<void> },
  noFileIds: null as null | { files: string[]; hits: number },
  writeFileQuotesItsData: null as null | { hits: number },
  whenTempOpens: null as null | (() => Promise<void>),
  noHardLinks: null as null | { code: string; hits: number },
  atTheLastMoment: null as null | (() => Promise<void>),
  flushFails: null as null | { code: string; folders: boolean; hits: number },
  log: null as null | string[]
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const errno = (code: string, syscall: string): Error =>
    Object.assign(new Error(`${code}: injected fault, ${syscall}`), { code, syscall })
  // Runs once, right before the call that gives a file its final name.
  const lastMoment = async (): Promise<void> => {
    const meanwhile = disk.atTheLastMoment
    disk.atTheLastMoment = null
    if (meanwhile) await meanwhile()
  }
  // The moment the disk says "another drive". The fault is off while `meanwhile` runs, so that a test can
  // rename the source itself.
  const otherDrive = async (fault: NonNullable<typeof disk.crossDrive>): Promise<void> => {
    fault.hits += 1
    disk.crossDrive = null
    try {
      await fault.meanwhile?.()
    } finally {
      disk.crossDrive = fault
    }
  }
  const mocked = {
    ...real,
    rename: (async (from, to) => {
      if (disk.crossDrive && String(from) === disk.crossDrive.from) {
        await otherDrive(disk.crossDrive)
        throw errno('EXDEV', 'rename')
      }
      await lastMoment()
      await real.rename(from, to)
      disk.log?.push(`name ${String(to)}`)
    }) as typeof real.rename,
    link: (async (existing, added) => {
      if (disk.crossDrive && String(existing) === disk.crossDrive.from && !disk.noHardLinks) {
        await otherDrive(disk.crossDrive)
        throw errno('EXDEV', 'link')
      }
      await lastMoment()
      if (disk.noHardLinks) {
        disk.noHardLinks.hits += 1
        throw errno(disk.noHardLinks.code, 'link')
      }
      await real.link(existing, added)
      disk.log?.push(`name ${String(added)}`)
    }) as typeof real.link,
    realpath: (async (target: string) => {
      await disk.beforeRealpath?.(target)
      if (disk.realpathFails && target.startsWith(disk.realpathFails.under)) {
        disk.realpathFails.hits += 1
        throw errno(disk.realpathFails.code, 'realpath')
      }
      return await real.realpath(target)
    }) as unknown as typeof real.realpath,
    readdir: (async (folder: string, options?: object) => {
      disk.foldersRead.push(String(folder))
      if (disk.readdirFails && String(folder).startsWith(disk.readdirFails.under)) {
        disk.readdirFails.hits += 1
        throw errno(disk.readdirFails.code, 'scandir')
      }
      return await real.readdir(folder, options as undefined)
    }) as unknown as typeof real.readdir,
    stat: (async (target: string, options?: object) => {
      // One path answers as another: a drive root that holds Options.ini, which no test machine has.
      if (disk.statAs && String(target) === disk.statAs.file) return await real.stat(disk.statAs.as, options)
      if (disk.statFails && String(target) === disk.statFails.file) {
        disk.statFails.hits += 1
        throw errno(disk.statFails.code, 'stat')
      }
      return await real.stat(target, options)
    }) as unknown as typeof real.stat,
    lstat: (async (target: string, options?: { bigint?: boolean }) => {
      const info = await real.lstat(target, options)
      // A disk that gives no file ids answers 0 for every file.
      if (disk.noFileIds && options?.bigint && disk.noFileIds.files.includes(String(target))) {
        disk.noFileIds.hits += 1
        return Object.assign(info, { ino: 0n })
      }
      return info
    }) as unknown as typeof real.lstat,
    unlink: (async (file) => {
      if (disk.unlinkFails && String(file) === disk.unlinkFails.file) {
        disk.unlinkFails.hits += 1
        await disk.unlinkFails.meanwhile?.()
        throw errno('EBUSY', 'unlink')
      }
      await real.unlink(file)
    }) as typeof real.unlink,
    open: (async (file, flags, mode) => {
      const handle = await real.open(file, flags, mode)
      if (disk.log || disk.flushFails) {
        // A new file is opened with 'wx'. The only other handle the gate flushes is a folder's.
        const isFolder = flags !== 'wx'
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (disk.flushFails && disk.flushFails.folders === isFolder) {
            disk.flushFails.hits += 1
            throw errno(disk.flushFails.code, 'fsync')
          }
          await sync()
          disk.log?.push(`flush ${String(file)}`)
        }
        const utimes = handle.utimes.bind(handle)
        handle.utimes = async (atime, mtime) => {
          await utimes(atime, mtime)
          disk.log?.push(`date ${String(file)}`)
        }
      }
      if (disk.whenTempOpens && flags === 'wx') {
        const meanwhile = disk.whenTempOpens
        disk.whenTempOpens = null
        await meanwhile()
      }
      if (disk.writeFileQuotesItsData && flags === 'wx') {
        const faults = disk.writeFileQuotesItsData
        handle.writeFile = (async (data: unknown) => {
          faults.hits += 1
          // Node words a bad argument like this, with the start of the value in the message.
          throw new TypeError(`The "data" argument must be of type string. Received type string ('${String(data)}')`)
        }) as unknown as typeof handle.writeFile
      }
      if (disk.corruptNewFiles && flags === 'wx') {
        const faults = disk.corruptNewFiles
        const write = handle.write.bind(handle) as unknown as (...args: unknown[]) => Promise<unknown>
        let flipped = false
        handle.write = (async (...args: unknown[]) => {
          const chunk = args[0]
          if (!flipped && chunk instanceof Uint8Array && chunk.byteLength > 0) {
            flipped = true
            faults.hits += 1
            const bad = Buffer.from(chunk)
            bad[0] = bad[0]! ^ 0xff
            return await write(bad, ...args.slice(1))
          }
          return await write(...args)
        }) as unknown as typeof handle.write
      }
      return handle
    }) as typeof real.open
  }
  return { ...mocked, default: mocked }
})

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = join(THIS_DIR, '../../../scripts/fixtures/specs')
const ON_WINDOWS = process.platform === 'win32'
const VERIFIED: BackupStatus = { state: 'verified', backupId: 'b1', at: '2026-11-24T18:00:00.000Z' }
const REPORT_NAME = 'Sims Helper report 20261124-131500.zip'

interface World {
  root: string
  folder: string
  dataDir: string
  desktopDir: string
  paths: AppPaths
  deps: GateDeps
  game: GameRunState | (() => never)
  backup: BackupStatus | (() => never)
  asked: string[]
  run(ops: WriteOp[], overrides?: Partial<WriteRequest>): Promise<GateResult>
  inFolder(...parts: string[]): string
  inData(...parts: string[]): string
}

const worlds: string[] = []

async function makeWorld(
  spec = 'clean',
  folderRel = 'Users/Player/Documents/Electronic Arts/The Sims 4',
  under: string | null = null
): Promise<World> {
  // Real path first: macOS /var and a Windows runner's RUNNER~1 temp folder are both aliases.
  const root = under ?? (await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-gate-test-'))))
  if (under === null) {
    worlds.push(root)
    await generateFixture(await loadSpec(join(SPECS_DIR, `${spec}.json`)), join(root, 'pc'))
  }
  const player = join(root, 'pc', 'Users', 'Player')
  const desktopDir = join(player, 'Desktop')
  await mkdir(desktopDir, { recursive: true })
  const paths = appPaths({ localAppData: join(player, 'AppData', 'Local'), desktopDir })
  const world: World = {
    root,
    folder: join(root, 'pc', ...folderRel.split('/')),
    dataDir: paths.dataDir,
    desktopDir,
    paths,
    game: 'not-running',
    backup: VERIFIED,
    asked: [],
    deps: {
      paths,
      async gameState() {
        world.asked.push('game')
        return typeof world.game === 'function' ? world.game() : world.game
      },
      async backupStatus(folderPath) {
        world.asked.push(`backup ${folderPath}`)
        return typeof world.backup === 'function' ? world.backup() : world.backup
      },
      async shareRoot() {
        return null
      }
    },
    run: (ops, overrides = {}) =>
      runGate(world.deps, { reason: 'fix', folderPath: world.folder, ops, ...overrides }),
    inFolder: (...parts) => join(world.folder, ...parts),
    inData: (...parts) => join(world.dataDir, ...parts)
  }
  return world
}

afterEach(async () => {
  disk.crossDrive = null
  disk.corruptNewFiles = null
  disk.realpathFails = null
  disk.beforeRealpath = null
  disk.statFails = null
  disk.statAs = null
  disk.readdirFails = null
  disk.foldersRead = []
  disk.unlinkFails = null
  disk.noFileIds = null
  disk.writeFileQuotesItsData = null
  disk.whenTempOpens = null
  disk.noHardLinks = null
  disk.atTheLastMoment = null
  disk.flushFails = null
  disk.log = null
  for (const root of worlds.splice(0)) await rm(root, { recursive: true, force: true })
})

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  async function walk(dir: string, rel: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        snapshot.set(relPath, `link ${await readlink(full)}`)
      } else if (info.isDirectory()) {
        snapshot.set(relPath, `dir ${info.mtimeMs}`)
        await walk(full, relPath)
      } else {
        snapshot.set(relPath, `file ${info.size} ${info.mtimeMs} ${await sha256(full)}`)
      }
    }
  }
  await walk(root, '')
  return snapshot
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/** A folder link: a junction on Windows (no privilege needed), a symlink elsewhere. */
async function linkFolder(target: string, link: string): Promise<void> {
  await symlink(target, link, 'junction')
}

function refusedWith(refusal: GateRefusal): GateResult {
  return { status: 'refused', refusal }
}

/** Runs a request that must be refused, and checks that nothing on the PC changed. */
async function expectRefusal(world: World, run: () => Promise<GateResult>, refusal: GateRefusal): Promise<void> {
  const before = await snapshotTree(world.root)
  expect(await run()).toEqual(refusedWith(refusal))
  expect(await snapshotTree(world.root)).toEqual(before)
}

const SAVE = ['saves', 'Slot_00000002.save'] as const
const MOD = ['Mods', 'cozy_rug.package'] as const

describe('one test per refusal reason', () => {
  it('saves-or-tray: a path inside saves', async () => {
    const w = await makeWorld()
    const target = w.inFolder(...SAVE)
    await expectRefusal(w, () => w.run([{ op: 'remove', path: target }]), { reason: 'saves-or-tray', path: target })
  })

  it('outside-allowed-area: a path in no zone', async () => {
    const w = await makeWorld()
    const target = join(w.root, 'pc', 'Program Files', 'note.txt')
    await expectRefusal(w, () => w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }]), {
      reason: 'outside-allowed-area',
      path: target
    })
  })

  it('link-escape: a folder link in Mods that leads out of the Sims folder', async () => {
    const w = await makeWorld()
    await linkFolder(join(w.root, 'pc', 'Program Files'), w.inFolder('Mods', 'Elsewhere'))
    const from = w.inFolder('Mods', 'Elsewhere', 'thing.package')
    await expectRefusal(w, () => w.run([{ op: 'move', from, to: w.inData('holding', 'thing.package') }]), {
      reason: 'link-escape',
      path: from
    })
  })

  it('not-a-sims-folder: the folder has no Options.ini', async () => {
    const w = await makeWorld('onedrive', 'Users/Player/Documents/Electronic Arts/Die Sims 4')
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }]), {
      reason: 'not-a-sims-folder',
      path: w.folder
    })
  })

  it('check-failed: a path whose real place cannot be read', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    disk.realpathFails = { under: w.inFolder('Mods'), code: 'EACCES', hits: 0 }
    await expectRefusal(w, () => w.run([{ op: 'move', from, to: w.inData('holding', 'x.package') }]), {
      reason: 'check-failed',
      path: from
    })
    expect(disk.realpathFails.hits, 'the injected error was really hit').toBeGreaterThan(0)
  })

  it('game-running', async () => {
    const w = await makeWorld()
    w.game = 'running'
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }]), { reason: 'game-running' })
  })

  it('game-state-unknown', async () => {
    const w = await makeWorld()
    w.game = 'unknown'
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }]), {
      reason: 'game-state-unknown'
    })
  })

  it('no-verified-backup', async () => {
    const w = await makeWorld()
    w.backup = { state: 'none' }
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }]), {
      reason: 'no-verified-backup',
      backup: 'none'
    })
  })
})

describe('saves and Tray are never written', () => {
  const spellings: [string, (w: World) => string][] = [
    ['a save file', (w) => w.inFolder(...SAVE)],
    ['the saves folder itself', (w) => w.inFolder('saves')],
    ['a new file in saves', (w) => w.inFolder('saves', 'new.save')],
    ['a Tray file', (w) => w.inFolder('Tray', '0x00000000!0x0001020304050607.trayitem')],
    ['the Tray folder itself', (w) => w.inFolder('Tray')],
    ['SAVES in capitals', (w) => w.inFolder('SAVES', 'Slot_00000002.save')],
    ['tray in small letters', (w) => w.inFolder('tray', 'x.trayitem')],
    ['Mods/../saves', (w) => `${w.folder}${sep}Mods${sep}..${sep}saves${sep}Slot_00000002.save`],
    ['Mods\\..\\saves with backslashes', (w) => `${w.folder}\\Mods\\..\\saves\\Slot_00000002.save`],
    ['Mods/../Tray with forward slashes', (w) => `${w.folder}/Mods/../Tray/x.trayitem`],
    ['saves. with a trailing dot', (w) => `${w.folder}${sep}saves.${sep}Slot_00000002.save`],
    ['saves with a trailing space', (w) => `${w.folder}${sep}saves ${sep}Slot_00000002.save`],
    ['Tray. as the last part', (w) => `${w.folder}${sep}Tray.`],
    ['saves with a data stream', (w) => `${w.folder}${sep}saves::$INDEX_ALLOCATION${sep}x`]
  ]

  it.each(spellings)('refuses every kind of write to %s', async (_name, spell) => {
    const w = await makeWorld()
    const target = spell(w)
    const spare = w.inData('spare.bin')
    await mkdir(w.dataDir, { recursive: true })
    await writeFile(spare, 'spare')
    const requests: WriteOp[] = [
      { op: 'mkdir', path: target },
      { op: 'write', path: target, data: 'x', mode: 'create' },
      { op: 'write', path: target, data: 'x', mode: 'replace' },
      { op: 'remove', path: target },
      { op: 'copy', from: spare, to: target },
      { op: 'move', from: spare, to: target },
      { op: 'move', from: target, to: w.inData('taken.save') }
    ]
    const before = await snapshotTree(w.root)
    for (const op of requests) {
      expect(await w.run([op]), op.op).toEqual(refusedWith({ reason: 'saves-or-tray', path: target }))
    }
    expect(await snapshotTree(w.root)).toEqual(before)
  })

  it('refuses saves even while the game runs and with no backup, and asks neither', async () => {
    const w = await makeWorld()
    w.game = 'running'
    w.backup = { state: 'none' }
    const target = w.inFolder(...SAVE)
    await expectRefusal(w, () => w.run([{ op: 'remove', path: target }]), { reason: 'saves-or-tray', path: target })
    expect(w.asked).toEqual([])
  })

  it('refuses a folder link in Mods that points into saves', async () => {
    const w = await makeWorld()
    await linkFolder(w.inFolder('saves'), w.inFolder('Mods', 'Sneaky'))
    const from = w.inFolder('Mods', 'Sneaky', 'Slot_00000002.save')
    await expectRefusal(w, () => w.run([{ op: 'move', from, to: w.inData('holding', 'x.save') }]), {
      reason: 'saves-or-tray',
      path: from
    })
    const to = w.inFolder('Mods', 'Sneaky', 'planted.package')
    await expectRefusal(w, () => w.run([{ op: 'move', from: w.inFolder(...MOD), to }]), {
      reason: 'saves-or-tray',
      path: to
    })
    const made = w.inFolder('Mods', 'Sneaky', 'Deep', 'Folder')
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: made }]), { reason: 'saves-or-tray', path: made })
  })

  it('when saves is itself a link to another place, that place is saves too', async () => {
    const w = await makeWorld()
    const moved = join(w.root, 'pc', 'OtherDrive', 'SimSaves')
    await mkdir(moved, { recursive: true })
    await writeFile(join(moved, 'Slot_00000009.save'), 'save')
    await rm(w.inFolder('saves'), { recursive: true })
    await linkFolder(moved, w.inFolder('saves'))
    await linkFolder(moved, w.inFolder('Mods', 'Sneaky'))
    const from = w.inFolder('Mods', 'Sneaky', 'Slot_00000009.save')
    await expectRefusal(w, () => w.run([{ op: 'move', from, to: w.inData('holding', 'x.save') }]), {
      reason: 'saves-or-tray',
      path: from
    })
  })

  it('refuses a file link in Mods that points at a save', async (ctx) => {
    const w = await makeWorld()
    const link = w.inFolder('Mods', 'sneaky.package')
    try {
      await symlink(w.inFolder(...SAVE), link, 'file')
    } catch {
      ctx.skip() // Windows without the right to make file links
      return
    }
    await expectRefusal(w, () => w.run([{ op: 'move', from: link, to: w.inData('holding', 'x.package') }]), {
      reason: 'saves-or-tray',
      path: link
    })
  })

  it('refuses a hard link in Mods that shares a file with saves', async () => {
    const w = await makeWorld()
    const hardLink = w.inFolder('Mods', 'hardlinked.package')
    await link(w.inFolder(...SAVE), hardLink)
    await expectRefusal(w, () => w.run([{ op: 'move', from: hardLink, to: w.inData('holding', 'hardlinked.package') }]), {
      reason: 'saves-or-tray',
      path: hardLink
    })
  })

  it('refuses every write to a hard link that shares a file with saves or Tray, wherever it is', async () => {
    const w = await makeWorld()
    const tray = w.inFolder('Tray', 'Deep', 'kept.trayitem')
    await mkdir(dirname(tray), { recursive: true })
    await writeFile(tray, 'a household')
    await mkdir(w.dataDir, { recursive: true })
    const inData = w.inData('second-name.bin')
    await link(tray, inData)
    const cache = w.inFolder('clientDB.package')
    await link(w.inFolder(...SAVE), cache)
    const options = w.inFolder('Options.ini')
    await rm(options)
    await link(w.inFolder(...SAVE), options)
    const requests: [WriteOp, string][] = [
      [{ op: 'remove', path: inData }, inData],
      [{ op: 'write', path: inData, data: 'x', mode: 'replace' }, inData],
      [{ op: 'move', from: inData, to: w.inData('elsewhere.bin') }, inData],
      [{ op: 'move', from: w.inFolder(...MOD), to: inData }, inData],
      [{ op: 'remove', path: cache }, cache],
      [{ op: 'write', path: options, data: 'x', mode: 'replace' }, options]
    ]
    for (const [op, path] of requests) {
      await expectRefusal(w, () => w.run([op]), { reason: 'saves-or-tray', path })
    }
    expect(w.asked).toEqual([])
  })

  it('a second name that shares no file with saves or Tray moves like any file', async () => {
    const w = await makeWorld()
    const twin = w.inFolder('Mods', 'twin.package')
    await link(w.inFolder(...MOD), twin)
    const to = w.inData('holding', 'twin.package')
    expect(await w.run([{ op: 'move', from: twin, to }])).toEqual({ status: 'done' })
    expect(await exists(twin)).toBe(false)
    expect(await sha256(to)).toBe(await sha256(w.inFolder(...MOD)))
  })

  it('a file with one name is never compared: saves and Tray are not read', async () => {
    const w = await makeWorld()
    disk.foldersRead = []
    expect(
      await w.run([{ op: 'move', from: w.inFolder(...MOD), to: w.inData('holding', 'cozy_rug.package') }])
    ).toEqual({ status: 'done' })
    expect(disk.foldersRead).toEqual([])
  })

  it('check-failed: saves cannot be read when a second name has to be compared', async () => {
    const w = await makeWorld()
    const twin = w.inFolder('Mods', 'twin.package')
    await link(w.inFolder(...MOD), twin)
    const before = await snapshotTree(w.root)
    disk.readdirFails = { under: w.inFolder('saves'), code: 'EACCES', hits: 0 }
    expect(await w.run([{ op: 'move', from: twin, to: w.inData('holding', 'twin.package') }])).toEqual(
      refusedWith({ reason: 'check-failed', path: twin })
    )
    expect(disk.readdirFails.hits, 'the injected error was really hit').toBe(1)
    disk.readdirFails = null
    expect(await snapshotTree(w.root)).toEqual(before)
  })

  it('a save with a second name is still backed up: the source of a copy is only read', async () => {
    const w = await makeWorld()
    await link(w.inFolder(...SAVE), w.inFolder('saves', 'Slot_00000002.save.twin'))
    const to = w.inData('backups', 'b1', 'saves', 'Slot_00000002.save')
    expect(await w.run([{ op: 'copy', from: w.inFolder(...SAVE), to }], { reason: 'backup' })).toEqual({
      status: 'done'
    })
    expect(await sha256(to)).toBe(await sha256(w.inFolder(...SAVE)))
  })

  it('refuses a link in the app data folder that points into Tray', async () => {
    const w = await makeWorld()
    await mkdir(w.dataDir, { recursive: true })
    await linkFolder(w.inFolder('Tray'), w.inData('shelf'))
    const target = w.inData('shelf', 'x.trayitem')
    await expectRefusal(w, () => w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }]), {
      reason: 'saves-or-tray',
      path: target
    })
    await expectRefusal(w, () => w.run([{ op: 'remove', path: w.inData('shelf') }]), {
      reason: 'saves-or-tray',
      path: w.inData('shelf')
    })
  })

  it('may read a save as the source of a copy into app data: that is the backup', async () => {
    const w = await makeWorld()
    w.game = 'running'
    w.backup = { state: 'none' }
    const from = w.inFolder(...SAVE)
    const to = w.inData('backups', 'b1', 'saves', 'Slot_00000002.save')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    expect(await w.run([{ op: 'copy', from, to }], { reason: 'backup' })).toEqual({ status: 'done' })
    expect(await sha256(to)).toBe(await sha256(from))
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
    expect(w.asked).toEqual([])
  })
})

describe('the Sims folder', () => {
  it('accepts the French folder name with no-break spaces', async () => {
    const w = await makeWorld('nested-scripts', 'Users/Player/Documents/Electronic Arts/Les\u00a0Sims\u00a04')
    const made = w.inFolder('Mods', 'New')
    expect(await w.run([{ op: 'mkdir', path: made }])).toEqual({ status: 'done' })
    expect((await stat(made)).isDirectory()).toBe(true)
  })

  // PR 3 hands over the real path. A folder moved to D:\\SimsData and reached by a link arrives under that name.
  it('accepts a folder with Options.ini whatever its name', async () => {
    const w = await makeWorld()
    const moved = join(w.root, 'pc', 'OtherDrive', 'SimsData')
    await mkdir(join(moved, 'Mods'), { recursive: true })
    await writeFile(join(moved, 'Options.ini'), 'modsdisabled = 0\n')
    const made = join(moved, 'Mods', 'New')
    expect(await w.run([{ op: 'mkdir', path: made }], { folderPath: moved })).toEqual({ status: 'done' })
    expect((await stat(made)).isDirectory()).toBe(true)
    expect(w.asked).toEqual([`backup ${moved}`, 'game'])
    // Its saves and Tray are as closed as any.
    const save = join(moved, 'saves', 'Slot_00000002.save')
    await mkdir(dirname(save), { recursive: true })
    await writeFile(save, 'a save')
    for (const op of [
      { op: 'remove', path: save },
      { op: 'write', path: join(moved, 'Tray', 'x.trayitem'), data: 'x', mode: 'create' }
    ] satisfies WriteOp[]) {
      await expectRefusal(w, () => w.run([op], { folderPath: moved }), { reason: 'saves-or-tray', path: op.path })
    }
  })

  it('refuses a folder without Options.ini, whatever its name', async () => {
    const w = await makeWorld()
    const fake = join(w.root, 'pc', 'Windows')
    await mkdir(join(fake, 'Mods'), { recursive: true })
    await rm(w.inFolder('Options.ini'))
    for (const folderPath of [fake, w.folder]) {
      await expectRefusal(
        w,
        () => w.run([{ op: 'mkdir', path: join(folderPath, 'Mods', 'New') }], { folderPath }),
        { reason: 'not-a-sims-folder', path: folderPath }
      )
    }
  })

  it('refuses a folder with Options.ini that sits inside a saves or Tray folder, under any name', async () => {
    for (const forbidden of ['saves', 'Tray']) {
      const w = await makeWorld()
      for (const name of ['Nested', 'The Sims 4']) {
        const inside = join(w.root, 'pc', 'OtherDrive', forbidden, 'deeper', name)
        await mkdir(join(inside, 'Mods'), { recursive: true })
        await writeFile(join(inside, 'Options.ini'), 'modsdisabled = 0\n')
        for (const op of [
          { op: 'mkdir', path: join(inside, 'Mods', 'New') },
          { op: 'write', path: join(inside, 'Options.ini'), data: 'x', mode: 'replace' }
        ] satisfies WriteOp[]) {
          await expectRefusal(w, () => w.run([op], { folderPath: inside }), {
            reason: 'not-a-sims-folder',
            path: inside
          })
        }
      }
    }
  })

  it('a folder named saves or Tray is never the Sims folder', async () => {
    const w = await makeWorld()
    for (const name of ['saves', 'Tray']) {
      const folderPath = w.inFolder(name)
      await writeFile(join(folderPath, 'Options.ini'), 'modsdisabled = 0\n')
      await mkdir(join(folderPath, 'Mods'), { recursive: true })
      await expectRefusal(
        w,
        () => w.run([{ op: 'mkdir', path: join(folderPath, 'Mods', 'New') }], { folderPath }),
        { reason: 'not-a-sims-folder', path: folderPath }
      )
    }
  })

  // Players move the folder to another drive and leave a link behind. The real folder may have any name.
  it('a folder link needs Options.ini in its real target, whatever either is called', async () => {
    const w = await makeWorld()
    const realTarget = join(w.root, 'pc', 'NotASimsFolder')
    await mkdir(join(realTarget, 'Mods'), { recursive: true })
    const linkParent = join(w.root, 'pc', 'Alias')
    await mkdir(linkParent, { recursive: true })
    const simsLink = join(linkParent, 'The Sims 4')
    await linkFolder(realTarget, simsLink)
    const made = join(simsLink, 'Mods', 'New')
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: made }], { folderPath: simsLink }), {
      reason: 'not-a-sims-folder',
      path: simsLink
    })

    // Options.ini is what makes it one, whatever the real folder is called.
    await writeFile(join(realTarget, 'Options.ini'), 'modsdisabled = 0\n')
    expect(await w.run([{ op: 'mkdir', path: made }], { folderPath: simsLink })).toEqual({ status: 'done' })
    expect((await stat(join(realTarget, 'Mods', 'New'))).isDirectory()).toBe(true)
    expect(w.asked).toEqual([`backup ${simsLink}`, 'game'])
  })

  it('refuses a folder link whose real target is inside saves or Tray', async () => {
    for (const forbidden of ['saves', 'Tray']) {
      const w = await makeWorld()
      const realTarget = w.inFolder(forbidden, 'Nested')
      await mkdir(join(realTarget, 'Mods'), { recursive: true })
      await writeFile(join(realTarget, 'Options.ini'), 'modsdisabled = 0\n')
      const linkParent = join(w.root, 'pc', 'Alias')
      await mkdir(linkParent, { recursive: true })
      const simsLink = join(linkParent, 'The Sims 4')
      await linkFolder(realTarget, simsLink)
      for (const op of [
        { op: 'mkdir', path: join(simsLink, 'Mods', 'New') },
        { op: 'write', path: join(simsLink, 'Options.ini'), data: 'x', mode: 'replace' }
      ] satisfies WriteOp[]) {
        await expectRefusal(w, () => w.run([op], { folderPath: simsLink }), {
          reason: 'not-a-sims-folder',
          path: simsLink
        })
      }
    }
  })

  // Decided 2026-11-24: a drive root is never the Sims folder, even when it holds Options.ini. No root on a
  // test machine holds one, so stat is told it does. ops is empty, so nothing could land on a real root.
  it('refuses a drive or filesystem root that holds Options.ini', async () => {
    const w = await makeWorld()
    const root = parse(w.root).root
    disk.statAs = { file: join(root, 'Options.ini'), as: w.inFolder('Options.ini') }
    await expectRefusal(w, () => w.run([], { folderPath: root }), { reason: 'not-a-sims-folder', path: root })
  })

  it('refuses a folder link whose real target is a drive or filesystem root that holds Options.ini', async () => {
    const w = await makeWorld()
    const root = parse(w.root).root
    const simsLink = join(w.root, 'pc', 'Alias', 'The Sims 4')
    await mkdir(dirname(simsLink), { recursive: true })
    await linkFolder(root, simsLink)
    try {
      disk.statAs = { file: join(simsLink, 'Options.ini'), as: w.inFolder('Options.ini') }
      await expectRefusal(w, () => w.run([], { folderPath: simsLink }), { reason: 'not-a-sims-folder', path: simsLink })
    } finally {
      await rm(simsLink) // the link only: nothing may walk into the root
    }
  })

  // The danger itself: a root on a drive that does not hold app data is taken as the Sims folder, and an op
  // runs there. subst makes such a drive without admin rights; it maps to a folder inside this test's world.
  it.runIf(ON_WINDOWS)('refuses the root of a drive without app data, and makes nothing there', async () => {
    const w = await makeWorld()
    const backing = join(w.root, 'pc', 'OtherDrive')
    await mkdir(join(backing, 'Mods'), { recursive: true })
    await writeFile(join(backing, 'Options.ini'), 'modsdisabled = 0\n')
    let letter: string | null = null
    for (const free of 'ZYXWVUTSRQPONMLKJIHG') {
      const taken = await stat(`${free}:\\`).then(
        () => true,
        (err: { code?: string }) => err.code !== 'ENOENT'
      )
      if (!taken) {
        letter = free
        break
      }
    }
    if (letter === null) throw new Error('no free drive letter for subst')
    const subst = promisify(execFile)
    await subst('subst', [`${letter}:`, backing])
    try {
      const root = `${letter}:\\`
      await expectRefusal(w, () => w.run([{ op: 'mkdir', path: `${root}Mods\\New` }], { folderPath: root }), {
        reason: 'not-a-sims-folder',
        path: root
      })
    } finally {
      await subst('subst', [`${letter}:`, '/D'])
    }
  })

  it.runIf(ON_WINDOWS)('refuses C:\\Windows', async () => {
    const w = await makeWorld()
    await expectRefusal(
      w,
      () => w.run([{ op: 'mkdir', path: 'C:\\Windows\\Mods\\New' }], { folderPath: 'C:\\Windows' }),
      { reason: 'not-a-sims-folder', path: 'C:\\Windows' }
    )
  })

  it('refuses a folder that does not exist, is a file, or is not written out in full', async () => {
    const w = await makeWorld()
    const missing = join(dirname(w.folder), 'Los Sims 4')
    const file = join(dirname(w.folder), 'De Sims 4')
    await writeFile(file, 'not a folder')
    const dotted = `${dirname(w.folder)}${sep}Mods${sep}..${sep}The Sims 4`
    for (const folderPath of [missing, file, dotted, 'The Sims 4', '']) {
      await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inData('x') }], { folderPath }), {
        reason: 'not-a-sims-folder',
        path: folderPath
      })
    }
  })

  it('refuses a Sims folder that sits inside the app data folder (a backup copy is not the game folder)', async () => {
    const w = await makeWorld()
    const copy = w.inData('backups', 'b1', 'The Sims 4')
    await mkdir(join(copy, 'Mods'), { recursive: true })
    await writeFile(join(copy, 'Options.ini'), 'modsdisabled = 0\n')
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: join(copy, 'Mods', 'New') }], { folderPath: copy }), {
      reason: 'not-a-sims-folder',
      path: copy
    })
  })

  it('with no Sims folder named, a path inside one is outside the allowed area', async () => {
    const w = await makeWorld()
    const target = w.inFolder('Mods', 'New')
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: target }], { folderPath: null }), {
      reason: 'outside-allowed-area',
      path: target
    })
  })
})

describe('the game must be closed', () => {
  const guarded: [string, (w: World) => WriteOp][] = [
    ['a mods move', (w) => ({ op: 'move', from: w.inFolder(...MOD), to: w.inData('holding', 'cozy_rug.package') })],
    ['a move into Mods', (w) => ({ op: 'move', from: w.inData('spare.bin'), to: w.inFolder('Mods', 'spare.package') })],
    ['a new folder in Mods', (w) => ({ op: 'mkdir', path: w.inFolder('Mods', 'New') })],
    ['a cache clear', (w) => ({ op: 'remove', path: w.inFolder('localthumbcache.package') })],
    ['an Options.ini edit', (w) => ({ op: 'write', path: w.inFolder('Options.ini'), data: 'x', mode: 'replace' })]
  ]
  const states: [string, World['game'], GateRefusal][] = [
    ['running', 'running', { reason: 'game-running' }],
    ['unknown', 'unknown', { reason: 'game-state-unknown' }],
    [
      'a check that throws',
      () => {
        throw new Error('tasklist failed')
      },
      { reason: 'game-state-unknown' }
    ],
    ['an answer that is not one of the three', 'closed' as GameRunState, { reason: 'game-state-unknown' }],
    ['no answer', undefined as unknown as GameRunState, { reason: 'game-state-unknown' }]
  ]

  for (const [stateName, game, refusal] of states) {
    it.each(guarded)(`${stateName} refuses %s`, async (_name, makeOp) => {
      const w = await makeWorld()
      await mkdir(w.dataDir, { recursive: true })
      await writeFile(w.inData('spare.bin'), 'spare')
      w.game = game
      await expectRefusal(w, () => w.run([makeOp(w)]), refusal)
    })
  }

  it('running or unknown does not block a write to app data, and the game is not even asked', async () => {
    for (const game of ['running', 'unknown'] as const) {
      const w = await makeWorld()
      w.game = game
      w.backup = { state: 'none' }
      const target = w.inData('state', 'settings.json')
      expect(await w.run([{ op: 'write', path: target, data: '{}', mode: 'create' }], { reason: 'state' })).toEqual({
        status: 'done'
      })
      expect(await readFile(target, 'utf8')).toBe('{}')
      expect(w.asked).toEqual([])
    }
  })

  it('asks once per request, after the backup answer, as the last thing before the first change', async () => {
    const w = await makeWorld()
    const seen: boolean[] = []
    const first = w.inFolder('Mods', 'One')
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      seen.push(await exists(first))
      return await realGame()
    }
    const ops: WriteOp[] = [
      { op: 'mkdir', path: first },
      { op: 'mkdir', path: w.inFolder('Mods', 'Two') },
      { op: 'move', from: w.inFolder(...MOD), to: w.inFolder('Mods', 'One', 'cozy_rug.package') }
    ]
    expect(await w.run(ops)).toEqual({ status: 'done' })
    expect(w.asked).toEqual([`backup ${w.folder}`, 'game'])
    expect(seen).toEqual([false])
  })

  it('names the running game ahead of the missing backup', async () => {
    const w = await makeWorld()
    w.game = 'running'
    w.backup = { state: 'none' }
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }]), { reason: 'game-running' })
  })
})

describe('a verified backup must exist', () => {
  const states: [string, World['backup'], 'none' | 'stale' | 'unknown'][] = [
    ['none', { state: 'none' }, 'none'],
    ['stale', { state: 'stale', backupId: 'b0', at: '2026-11-01T00:00:00.000Z' }, 'stale'],
    ['unknown', { state: 'unknown', detail: 'manifest unreadable' }, 'unknown'],
    [
      'a probe that throws',
      () => {
        throw new Error('disk error')
      },
      'unknown'
    ],
    ['an answer with no state', {} as BackupStatus, 'unknown'],
    ['a state the gate does not know', { state: 'copying' } as unknown as BackupStatus, 'unknown']
  ]

  it.each(states)('%s refuses mods, caches and options writes', async (_name, backup, reported) => {
    const w = await makeWorld()
    w.backup = backup
    const ops: WriteOp[] = [
      { op: 'move', from: w.inFolder(...MOD), to: w.inData('holding', 'cozy_rug.package') },
      { op: 'remove', path: w.inFolder('cachestr') },
      { op: 'write', path: w.inFolder('Options.ini'), data: 'x', mode: 'replace' }
    ]
    for (const op of ops) {
      await expectRefusal(w, () => w.run([op]), { reason: 'no-verified-backup', backup: reported })
    }
  })

  it('verified passes, and the probe is asked about the request folder', async () => {
    const w = await makeWorld()
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    expect(await w.run([{ op: 'move', from: w.inFolder(...MOD), to }])).toEqual({ status: 'done' })
    expect(w.asked).toEqual([`backup ${w.folder}`, 'game'])
    expect(await exists(to)).toBe(true)
  })
})

describe('which op may write into which zone', () => {
  type ZoneName = 'mods' | 'caches' | 'options' | 'report'
  const zonePath = (w: World, zone: ZoneName): string =>
    ({
      mods: w.inFolder('Mods', 'cozy_rug.package'),
      caches: w.inFolder('localthumbcache.package'),
      options: w.inFolder('Options.ini'),
      report: join(w.desktopDir, REPORT_NAME)
    })[zone]
  const spare = (w: World): string => w.inData('spare.bin')

  const noCells: [string, ZoneName, (w: World, target: string) => WriteOp][] = [
    ['mkdir', 'caches', (_w, target) => ({ op: 'mkdir', path: target })],
    ['mkdir', 'options', (_w, target) => ({ op: 'mkdir', path: target })],
    ['mkdir', 'report', (_w, target) => ({ op: 'mkdir', path: target })],
    ['copy to', 'mods', (w, target) => ({ op: 'copy', from: spare(w), to: target })],
    ['copy to', 'caches', (w, target) => ({ op: 'copy', from: spare(w), to: target })],
    ['copy to', 'options', (w, target) => ({ op: 'copy', from: spare(w), to: target })],
    ['copy to', 'report', (w, target) => ({ op: 'copy', from: spare(w), to: target })],
    ['move from', 'caches', (w, target) => ({ op: 'move', from: target, to: w.inData('x') })],
    ['move from', 'options', (w, target) => ({ op: 'move', from: target, to: w.inData('x') })],
    ['move from', 'report', (w, target) => ({ op: 'move', from: target, to: w.inData('x') })],
    ['move to', 'caches', (w, target) => ({ op: 'move', from: spare(w), to: target })],
    ['move to', 'options', (w, target) => ({ op: 'move', from: spare(w), to: target })],
    ['move to', 'report', (w, target) => ({ op: 'move', from: spare(w), to: target })],
    ['write (create)', 'mods', (_w, target) => ({ op: 'write', path: target, data: 'x', mode: 'create' })],
    ['write (replace)', 'mods', (_w, target) => ({ op: 'write', path: target, data: 'x', mode: 'replace' })],
    ['write (create)', 'caches', (_w, target) => ({ op: 'write', path: target, data: 'x', mode: 'create' })],
    ['write (replace)', 'caches', (_w, target) => ({ op: 'write', path: target, data: 'x', mode: 'replace' })],
    ['write (create)', 'options', (_w, target) => ({ op: 'write', path: target, data: 'x', mode: 'create' })],
    ['write (replace)', 'report', (_w, target) => ({ op: 'write', path: target, data: 'x', mode: 'replace' })],
    ['remove', 'mods', (_w, target) => ({ op: 'remove', path: target })],
    ['remove', 'options', (_w, target) => ({ op: 'remove', path: target })],
    ['remove', 'report', (_w, target) => ({ op: 'remove', path: target })]
  ]

  it.each(noCells)('no: %s %s', async (_op, zone, makeOp) => {
    const w = await makeWorld()
    await mkdir(w.dataDir, { recursive: true })
    await writeFile(spare(w), 'spare')
    await writeFile(join(w.desktopDir, REPORT_NAME), 'old report')
    const target = zonePath(w, zone)
    await expectRefusal(w, () => w.run([makeOp(w, target)]), { reason: 'outside-allowed-area', path: target })
  })

  it('no: a folder in Mods is never removed, and neither is Mods', async () => {
    const w = await makeWorld()
    for (const target of [w.inFolder('Mods', 'MCCC'), w.inFolder('Mods')]) {
      await expectRefusal(w, () => w.run([{ op: 'remove', path: target }]), {
        reason: 'outside-allowed-area',
        path: target
      })
    }
  })

  it('yes: mkdir in mods, with the folders above it', async () => {
    const w = await makeWorld()
    const made = w.inFolder('Mods', 'Creator', 'Set')
    expect(await w.run([{ op: 'mkdir', path: made }])).toEqual({ status: 'done' })
    expect((await stat(made)).isDirectory()).toBe(true)
    expect(await w.run([{ op: 'mkdir', path: made }]), 'a folder that is already there is fine').toEqual({
      status: 'done'
    })
  })

  it('yes: mkdir in app data, and of the app data folder itself', async () => {
    const w = await makeWorld()
    expect(
      await w.run([
        { op: 'mkdir', path: w.dataDir },
        { op: 'mkdir', path: w.inData('journal') }
      ])
    ).toEqual({ status: 'done' })
    expect((await stat(w.inData('journal'))).isDirectory()).toBe(true)
    expect(w.asked).toEqual([])
  })

  it('yes: copy into app data keeps the bytes and the file date and leaves the source alone', async () => {
    const w = await makeWorld()
    // A copy only reads Mods. It is how the backup is made, so it waits for neither the game nor a backup.
    w.game = 'running'
    w.backup = { state: 'none' }
    const from = w.inFolder(...MOD)
    const to = w.inData('backups', 'b1', 'Mods', 'cozy_rug.package')
    const before = await snapshotTree(w.folder)
    expect(await w.run([{ op: 'copy', from, to }], { reason: 'backup' })).toEqual({ status: 'done' })
    expect(await sha256(to)).toBe(await sha256(from))
    expect(Math.abs((await stat(to)).mtimeMs - (await stat(from)).mtimeMs)).toBeLessThan(2)
    expect(await snapshotTree(w.folder)).toEqual(before)
    expect(await readdir(dirname(to))).toEqual(['cozy_rug.package'])
    expect(w.asked).toEqual([])
  })

  it('yes: move out of Mods, back into Mods, inside Mods and inside app data', async () => {
    const w = await makeWorld()
    const home = w.inFolder(...MOD)
    const hash = await sha256(home)
    const date = (await stat(home)).mtimeMs
    const held = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const heldElsewhere = w.inData('holding', 'e2', 'cozy_rug.package')
    const deeper = w.inFolder('Mods', 'Rugs', 'cozy_rug.package')
    for (const [from, to] of [
      [home, held],
      [held, heldElsewhere],
      [heldElsewhere, deeper],
      [deeper, home]
    ] as const) {
      expect(await w.run([{ op: 'move', from, to }])).toEqual({ status: 'done' })
      expect(await exists(from), `${from} is gone`).toBe(false)
      expect(await sha256(to)).toBe(hash)
      expect((await stat(to)).mtimeMs).toBe(date)
    }
  })

  it('yes: write replaces Options.ini through a temp file and leaves nothing behind', async () => {
    const w = await makeWorld()
    const target = w.inFolder('Options.ini')
    const names = (await readdir(w.folder)).sort()
    expect(await w.run([{ op: 'write', path: target, data: 'modsdisabled = 0\n', mode: 'replace' }])).toEqual({
      status: 'done'
    })
    expect(await readFile(target, 'utf8')).toBe('modsdisabled = 0\n')
    expect((await readdir(w.folder)).sort()).toEqual(names)
  })

  it('yes: write in app data creates text and bytes, and replace overwrites or creates', async () => {
    const w = await makeWorld()
    const text = w.inData('journal', 'e1.json')
    const bytes = w.inData('assist', 'key.bin')
    expect(
      await w.run(
        [
          { op: 'write', path: text, data: '{"a":1}', mode: 'create' },
          { op: 'write', path: bytes, data: new Uint8Array([0, 1, 2, 255]), mode: 'replace' },
          { op: 'write', path: text, data: '{"a":2}', mode: 'replace' }
        ],
        { folderPath: null, reason: 'journal' }
      )
    ).toEqual({ status: 'done' })
    expect(await readFile(text, 'utf8')).toBe('{"a":2}')
    expect([...(await readFile(bytes))]).toEqual([0, 1, 2, 255])
    expect((await readdir(dirname(text))).sort()).toEqual(['e1.json'])
  })

  it('yes: remove clears the exact cache entries, files and folders', async () => {
    const w = await makeWorld()
    const ops: WriteOp[] = [
      { op: 'remove', path: w.inFolder('localthumbcache.package') },
      { op: 'remove', path: w.inFolder('avatarcache.package') },
      { op: 'remove', path: w.inFolder('cachestr') },
      { op: 'remove', path: w.inFolder('onlinethumbnailcache') },
      { op: 'remove', path: w.inFolder('clientDB.package') } // not there: nothing to do
    ]
    expect(await w.run(ops)).toEqual({ status: 'done' })
    expect((await readdir(w.folder)).sort()).toEqual(
      ['Config.log', 'GameVersion.txt', 'Mods', 'Options.ini', 'Tray', 'cache', 'saves'].sort()
    )
  })

  it('no: remove takes nothing inside a cache folder, and no folder that is not on the list', async () => {
    const w = await makeWorld()
    for (const target of [w.inFolder('cachestr', 'spotlight_en-us.package'), w.inFolder('cache'), w.folder]) {
      await expectRefusal(w, () => w.run([{ op: 'remove', path: target }]), {
        reason: 'outside-allowed-area',
        path: target
      })
    }
  })

  it('remove fails when a cache name holds the wrong kind of thing', async () => {
    const w = await makeWorld()
    await mkdir(w.inFolder('clientDB.package'))
    await writeFile(w.inFolder('clientDB.package', 'keep.txt'), 'keep')
    const result = await w.run([{ op: 'remove', path: w.inFolder('clientDB.package') }])
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(w.inFolder('clientDB.package', 'keep.txt'))).toBe(true)
  })

  it('yes: remove in app data takes a file or a folder with everything in it, but never the folder itself', async () => {
    const w = await makeWorld()
    await mkdir(w.inData('backups', 'b0', 'Mods'), { recursive: true })
    await writeFile(w.inData('backups', 'b0', 'Mods', 'a.package'), 'a')
    await writeFile(w.inData('old.json'), '{}')
    expect(
      await w.run(
        [
          { op: 'remove', path: w.inData('backups', 'b0') },
          { op: 'remove', path: w.inData('old.json') },
          { op: 'remove', path: w.inData('never-there') }
        ],
        { folderPath: null, reason: 'backup' }
      )
    ).toEqual({ status: 'done' })
    expect(await readdir(w.dataDir)).toEqual(['backups'])
    expect(await readdir(w.inData('backups'))).toEqual([])
    await expectRefusal(w, () => w.run([{ op: 'remove', path: w.dataDir }]), {
      reason: 'outside-allowed-area',
      path: w.dataDir
    })
  })

  it('remove in app data does not follow a link into saves', async () => {
    const w = await makeWorld()
    await mkdir(w.inData('old'), { recursive: true })
    await linkFolder(w.inFolder('saves'), w.inData('old', 'shortcut'))
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    expect(await w.run([{ op: 'remove', path: w.inData('old') }], { folderPath: null })).toEqual({ status: 'done' })
    expect(await exists(w.inData('old'))).toBe(false)
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
  })
})

describe('the report zone', () => {
  it('takes exactly one file name pattern, on the Desktop, with create', async () => {
    const w = await makeWorld()
    const target = join(w.desktopDir, REPORT_NAME)
    w.game = 'running'
    w.backup = { state: 'none' }
    expect(
      await w.run([{ op: 'write', path: target, data: new Uint8Array([80, 75]), mode: 'create' }], {
        folderPath: null,
        reason: 'report'
      })
    ).toEqual({ status: 'done' })
    expect([...(await readFile(target))]).toEqual([80, 75])
    expect(await readdir(w.desktopDir)).toEqual([REPORT_NAME])
    expect(w.asked).toEqual([])
  })

  it('refuses every other name and place', async () => {
    const w = await makeWorld()
    await mkdir(join(w.desktopDir, 'Reports'))
    for (const target of [
      join(w.desktopDir, 'Sims Helper report.zip'),
      join(w.desktopDir, 'Sims Helper report 20261124-131500.exe'),
      join(w.desktopDir, 'Sims Helper report 20261124-131500.zip.lnk'),
      join(w.desktopDir, 'Sims Helper report 2026112-131500.zip'),
      join(w.desktopDir, 'x Sims Helper report 20261124-131500.zip'),
      join(w.desktopDir, 'Reports', REPORT_NAME),
      join(dirname(w.desktopDir), REPORT_NAME),
      w.desktopDir
    ]) {
      await expectRefusal(
        w,
        () => w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }], { folderPath: null }),
        { reason: 'outside-allowed-area', path: target }
      )
    }
  })

  it('a Desktop that cannot be resolved means no report zone, and holds up nothing else', async () => {
    const w = await makeWorld()
    disk.realpathFails = { under: w.desktopDir, code: 'EACCES', hits: 0 }
    const target = join(w.desktopDir, REPORT_NAME)
    expect(await w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }], { folderPath: null })).toEqual(
      refusedWith({ reason: 'check-failed', path: target })
    )
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
    const elsewhere = join(w.desktopDir, 'notes.txt')
    expect(await w.run([{ op: 'write', path: elsewhere, data: 'x', mode: 'create' }], { folderPath: null })).toEqual(
      refusedWith({ reason: 'outside-allowed-area', path: elsewhere })
    )
    expect(await w.run([{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null })).toEqual({ status: 'done' })
    disk.realpathFails = null
    w.paths.desktopDir = 'Desktop'
    expect(await w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }], { folderPath: null })).toEqual(
      refusedWith({ reason: 'outside-allowed-area', path: target })
    )
    expect(await w.run([{ op: 'mkdir', path: w.inData('state') }], { folderPath: null })).toEqual({ status: 'done' })
  })

  it('never overwrites a report that is already there', async () => {
    const w = await makeWorld()
    const target = join(w.desktopDir, REPORT_NAME)
    await writeFile(target, 'first')
    const result = await w.run([{ op: 'write', path: target, data: 'second', mode: 'create' }], { folderPath: null })
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await readFile(target, 'utf8')).toBe('first')
    expect(await readdir(w.desktopDir)).toEqual([REPORT_NAME])
  })
})

describe('where the app data folder may be', () => {
  async function expectEverythingRefused(w: World): Promise<void> {
    const requests: [WriteOp[], Partial<WriteRequest>][] = [
      [[{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null }],
      [[{ op: 'write', path: join(w.desktopDir, REPORT_NAME), data: 'x', mode: 'create' }], { folderPath: null }],
      [[{ op: 'move', from: w.inFolder(...MOD), to: w.inData('holding', 'x.package') }], {}],
      [[{ op: 'remove', path: w.inFolder('localthumbcache.package') }], {}],
      [[], {}]
    ]
    for (const [ops, overrides] of requests) {
      await expectRefusal(w, () => w.run(ops, overrides), { reason: 'outside-allowed-area', path: w.dataDir })
    }
  }

  async function moveDataDir(w: World, localAppData: string): Promise<void> {
    w.paths = appPaths({ localAppData, desktopDir: w.desktopDir })
    w.deps.paths = w.paths
    w.dataDir = w.paths.dataDir
  }

  it('inside the Sims folder: every request is refused', async () => {
    const w = await makeWorld()
    await moveDataDir(w, w.folder)
    await expectEverythingRefused(w)
  })

  it('inside another folder with a Sims folder name: every request is refused', async () => {
    const w = await makeWorld()
    await moveDataDir(w, join(w.root, 'pc', 'Users', 'Player', 'Documents', 'Electronic Arts', 'Les\u00a0Sims\u00a04'))
    await expectEverythingRefused(w)
  })

  it('under a OneDrive root from the environment: every request is refused', async () => {
    const w = await makeWorld()
    const cloud = join(w.root, 'pc', 'Users', 'Player', 'Cloud')
    await moveDataDir(w, join(cloud, 'AppData'))
    w.paths.oneDriveRoots = [cloud.toUpperCase()]
    await expectEverythingRefused(w)
  })

  it('under a OneDrive root spelled in other letter case, beyond A to Z: every request is refused', async () => {
    const w = await makeWorld()
    // Neither folder exists, so only the names can be compared. To forbid, they are compared widely.
    await moveDataDir(w, join(w.root, 'pc', 'Users', 'Jos\u00e9', 'Cloud', 'AppData'))
    w.paths.oneDriveRoots = [join(w.root, 'pc', 'Users', 'JOS\u00c9', 'CLOUD')]
    await expectEverythingRefused(w)
  })

  it('under a folder whose name starts with OneDrive: every request is refused', async () => {
    const w = await makeWorld()
    await moveDataDir(w, join(w.root, 'pc', 'Users', 'Player', 'onedrive - Personal', 'AppData'))
    await expectEverythingRefused(w)
  })

  it('reached through a link into OneDrive: every request is refused', async () => {
    const w = await makeWorld()
    const cloud = join(w.root, 'pc', 'Users', 'Player', 'OneDrive', 'Stuff')
    await mkdir(cloud, { recursive: true })
    await linkFolder(cloud, join(w.root, 'pc', 'Users', 'Player', 'Stuff'))
    await moveDataDir(w, join(w.root, 'pc', 'Users', 'Player', 'Stuff'))
    await expectEverythingRefused(w)
  })

  it('under a symlinked OneDrive root whose env value has a trailing separator: every request is refused', async () => {
    const w = await makeWorld()
    const cloud = join(w.root, 'pc', 'Users', 'Player', 'Cloud')
    await mkdir(cloud, { recursive: true })
    const cloudLink = join(w.root, 'pc', 'Users', 'Player', 'SyncLink')
    await linkFolder(cloud, cloudLink)
    await moveDataDir(w, join(cloud, 'AppData'))
    w.paths.oneDriveRoots = [`${cloudLink}${sep}`]
    await expectEverythingRefused(w)
  })

  it('not written out in full: every request is refused', async () => {
    const w = await makeWorld()
    for (const dataDir of ['SimsHelper', '', `${w.dataDir}${sep}..${sep}SimsHelper`]) {
      w.paths.dataDir = dataDir
      w.dataDir = dataDir
      await expectRefusal(w, () => w.run([{ op: 'mkdir', path: join(w.root, 'x') }]), {
        reason: 'outside-allowed-area',
        path: dataDir
      })
    }
  })

  it('a drive or filesystem root as dataDir refuses every request', async () => {
    const w = await makeWorld()
    const rootDir = parse(w.root).root
    w.paths.dataDir = rootDir
    w.dataDir = rootDir
    const target = w.inFolder(...SAVE)
    await expectRefusal(w, () => w.run([{ op: 'remove', path: target }], { folderPath: null }), {
      reason: 'outside-allowed-area',
      path: rootDir
    })
  })
})

describe('paths Windows would read differently are refused', () => {
  const odd: [string, (w: World) => string][] = [
    ['a relative path', () => join('Mods', 'a.package')],
    ['a path with ..', (w) => `${w.folder}${sep}Mods${sep}A${sep}..${sep}a.package`],
    ['a doubled separator', (w) => `${w.folder}${sep}Mods${sep}${sep}a.package`],
    ['a trailing separator', (w) => `${w.folder}${sep}Mods${sep}A${sep}`],
    ['a UNC path', () => '\\\\server\\share\\The Sims 4\\Mods\\a.package'],
    ['a \\\\?\\ path', (w) => `\\\\?\\${w.inFolder('Mods', 'a.package')}`],
    ['a \\\\.\\ path', (w) => `\\\\.\\${w.inFolder('Mods', 'a.package')}`],
    ['a part that ends in a dot', (w) => w.inFolder('Mods', 'A.', 'a.package')],
    ['a file name that ends in a space', (w) => w.inFolder('Mods', 'a.package ')],
    ['a data stream', (w) => `${w.inFolder('Mods', 'a.package')}:hidden`],
    ['a device name', (w) => w.inFolder('Mods', 'NUL')],
    ['a device name with an extension', (w) => w.inFolder('Mods', 'con.package')],
    ['a device name with spaces before the extension', (w) => w.inFolder('Mods', 'NUL .package')],
    ['a COM device name with spaces before the extension', (w) => w.inFolder('Mods', 'COM1   .package')],
    ['a wildcard', (w) => w.inFolder('Mods', '*.package')],
    ['an empty path', () => '']
  ]

  it.each(odd)('%s', async (_name, spell) => {
    const w = await makeWorld()
    const target = spell(w)
    for (const op of [
      { op: 'mkdir', path: target },
      { op: 'move', from: target, to: w.inData('x.package') },
      { op: 'move', from: w.inFolder(...MOD), to: target }
    ] satisfies WriteOp[]) {
      await expectRefusal(w, () => w.run([op]), { reason: 'outside-allowed-area', path: target })
    }
  })

  it('the source of a copy must be inside the Sims folder or app data, written out in full', async () => {
    const w = await makeWorld()
    const to = w.inData('copy.bin')
    for (const from of [
      join(w.root, 'pc', 'Program Files', 'EA Games', 'The Sims 4', 'Game', 'Bin', 'TS4_x64.exe'),
      join(w.desktopDir, 'photo.png'),
      `${w.folder}${sep}Mods${sep}..${sep}Options.ini`,
      'Options.ini'
    ]) {
      await expectRefusal(w, () => w.run([{ op: 'copy', from, to }]), { reason: 'outside-allowed-area', path: from })
    }
  })

  it('the source of a copy may not be reached through a link that leaves both', async () => {
    const w = await makeWorld()
    await linkFolder(join(w.root, 'pc', 'Program Files'), w.inFolder('Mods', 'Elsewhere'))
    const from = w.inFolder('Mods', 'Elsewhere', 'EA Games', 'The Sims 4', 'Game', 'Bin', 'TS4_x64.exe')
    await expectRefusal(w, () => w.run([{ op: 'copy', from, to: w.inData('copy.bin') }]), {
      reason: 'link-escape',
      path: from
    })
  })
})

describe('links', () => {
  it('link-escape: app data reached through a link that lands in Mods', async () => {
    const w = await makeWorld()
    await mkdir(w.dataDir, { recursive: true })
    await linkFolder(w.inFolder('Mods'), w.inData('holding'))
    const target = w.inData('holding', 'cozy_rug.package')
    await expectRefusal(w, () => w.run([{ op: 'remove', path: target }]), { reason: 'link-escape', path: target })
  })

  it('link-escape: a link that points nowhere is never written through', async () => {
    const w = await makeWorld()
    await mkdir(w.dataDir, { recursive: true })
    await linkFolder(join(w.root, 'gone'), w.inData('holding'))
    const target = w.inData('holding', 'x.package')
    await expectRefusal(w, () => w.run([{ op: 'move', from: w.inFolder(...MOD), to: target }]), {
      reason: 'link-escape',
      path: target
    })
  })

  it('a folder link inside Mods that stays inside Mods is followed', async () => {
    const w = await makeWorld()
    await linkFolder(w.inFolder('Mods', 'CAS'), w.inFolder('Mods', 'Shortcut'))
    const from = w.inFolder('Mods', 'Shortcut', 'Hair', 'sample_waves.package')
    const to = w.inData('holding', 'sample_waves.package')
    expect(await w.run([{ op: 'move', from, to }])).toEqual({ status: 'done' })
    expect(await exists(w.inFolder('Mods', 'CAS', 'Hair', 'sample_waves.package'))).toBe(false)
    expect(await exists(to)).toBe(true)
  })

  it('only a real file moves or is copied: a link and a folder both fail and stay', async (ctx) => {
    const w = await makeWorld()
    const link = w.inFolder('Mods', 'alias.package')
    try {
      await symlink(w.inFolder(...MOD), link, 'file')
    } catch {
      ctx.skip() // Windows without the right to make file links
      return
    }
    const before = await snapshotTree(w.root)
    for (const from of [link, w.inFolder('Mods', 'MCCC')]) {
      expect(await w.run([{ op: 'move', from, to: w.inData('holding', 'x') }])).toMatchObject({
        status: 'failed',
        opsDone: 0
      })
      expect(await w.run([{ op: 'copy', from, to: w.inData('copies', 'x') }])).toMatchObject({
        status: 'failed',
        opsDone: 0
      })
    }
    expect(await snapshotTree(w.root)).toEqual(before)
  })

  it('an earlier op cannot bring a link into Mods for a later op to walk through', async () => {
    const w = await makeWorld()
    await mkdir(w.inData('holding', 'box'), { recursive: true })
    await linkFolder(w.inFolder('saves'), w.inData('holding', 'box', 'inner'))
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    const result = await w.run([
      { op: 'move', from: w.inData('holding', 'box'), to: w.inFolder('Mods', 'box') },
      { op: 'move', from: w.inFolder('Mods', 'box', 'inner', 'Slot_00000002.save'), to: w.inData('taken.save') }
    ])
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
    expect(await exists(w.inFolder('Mods', 'box'))).toBe(false)
    expect(await exists(w.inData('taken.save'))).toBe(false)
  })

  it('TOCTOU: a parent folder in Mods swapped to a link into saves during gameState does not move a save', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const decoy = join(sub, 'Slot_00000002.save')
    await writeFile(decoy, 'decoy mod')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(w.inFolder('saves'), sub)
      return await realGame()
    }
    const result = await w.run([{ op: 'move', from: decoy, to: w.inData('holding', 'taken.save') }])
    expect(result.status).not.toBe('done')
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
  })

  it('TOCTOU: a parent folder in app data swapped to a link into saves during gameState does not overwrite or remove a save', async () => {
    for (const op of [
      (target: string): WriteOp => ({ op: 'write', path: target, data: 'corrupted', mode: 'replace' }),
      (target: string): WriteOp => ({ op: 'remove', path: target })
    ]) {
      const w = await makeWorld()
      const sub = w.inData('sub')
      await mkdir(sub, { recursive: true })
      const target = join(sub, 'Slot_00000002.save')
      await writeFile(target, 'app data copy')
      const savesBefore = await snapshotTree(w.inFolder('saves'))
      const realGame = w.deps.gameState
      w.deps.gameState = async () => {
        await rm(sub, { recursive: true })
        await linkFolder(w.inFolder('saves'), sub)
        return await realGame()
      }
      const result = await w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'TriggerGuard') }, op(target)])
      expect(result.status).not.toBe('done')
      expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
    }
  })

  it('TOCTOU: a folder swapped for a link that stays inside Mods is refused too, and nothing moves', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    for (const folder of [sub, other]) {
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'same_name.package'), `the one in ${basename(folder)}`)
    }
    const from = join(sub, 'same_name.package')
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(other, sub)
      return await realGame()
    }
    const before = await snapshotTree(other)
    expect(await w.run([{ op: 'move', from, to: w.inData('holding', 'same_name.package') }])).toEqual(
      refusedWith({ reason: 'link-escape', path: from })
    )
    expect(await snapshotTree(other)).toEqual(before)
    expect(await exists(w.inData('holding', 'same_name.package'))).toBe(false)
    expect(w.asked).toEqual([`backup ${w.folder}`, 'game'])
  })

  it('TOCTOU: a Sims folder link pointed at another folder while the game is asked refuses the request', async () => {
    const w = await makeWorld()
    const places = ['First', 'Second'].map((name) => join(w.root, 'pc', 'OtherDrive', name))
    for (const place of places) {
      await mkdir(join(place, 'Mods'), { recursive: true })
      await writeFile(join(place, 'Options.ini'), 'modsdisabled = 0\n')
    }
    await mkdir(join(w.root, 'pc', 'Alias'), { recursive: true })
    const simsLink = join(w.root, 'pc', 'Alias', 'The Sims 4')
    await linkFolder(places[0]!, simsLink)
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      await rm(simsLink, { recursive: true })
      await linkFolder(places[1]!, simsLink)
      return await realGame()
    }
    const result = await w.run([{ op: 'mkdir', path: join(simsLink, 'Mods', 'New') }], { folderPath: simsLink })
    expect(result).toEqual(refusedWith({ reason: 'link-escape', path: simsLink }))
    for (const place of places) expect(await readdir(join(place, 'Mods'))).toEqual([])
  })

  it('refused means no op ran: a path that changes while the game is asked stops the ops before it too', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    for (const folder of [sub, other]) {
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'same_name.package'), `the one in ${basename(folder)}`)
    }
    const from = join(sub, 'same_name.package')
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(other, sub)
      return await realGame()
    }
    const before = await snapshotTree(other)
    // The first two ops are fine on their own. A caller that reads `refused` drops its journal entry, so
    // they must not have run. (The test below is the other half: once an op has run, the answer is `failed`.)
    const result = await w.run([
      { op: 'mkdir', path: w.inData('journal') },
      { op: 'write', path: w.inData('journal', 'e1.json'), data: '{}', mode: 'create' },
      { op: 'move', from, to: w.inData('holding', 'same_name.package') }
    ])
    expect(result).toEqual(refusedWith({ reason: 'link-escape', path: from }))
    expect(await exists(w.inData('journal'))).toBe(false)
    expect(await exists(w.inData('holding'))).toBe(false)
    expect(await snapshotTree(other)).toEqual(before)
  })

  it('refused, not failed, when the look right before the first op finds a path changed: nothing ran', async () => {
    const w = await makeWorld()
    const sub = w.inData('sub')
    await mkdir(sub, { recursive: true })
    const target = join(sub, 'Slot_00000002.save')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    // No guarded zone, so the game is not asked: the second look at the path is the one before the first op.
    let looks = 0
    disk.beforeRealpath = async (asked) => {
      if (asked !== target) return
      looks += 1
      if (looks !== 2) return
      await rm(sub, { recursive: true })
      await linkFolder(w.inFolder('saves'), sub)
    }
    const result = await w.run([
      { op: 'write', path: target, data: 'corrupted', mode: 'replace' },
      { op: 'mkdir', path: w.inData('never') }
    ])
    expect(looks, 'the path was looked at a second time').toBeGreaterThanOrEqual(2)
    expect(result).toEqual(refusedWith({ reason: 'saves-or-tray', path: target }))
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
    expect(await exists(w.inData('never'))).toBe(false)
  })

  it('refused with check-failed when the look right before the first op cannot be made', async () => {
    const w = await makeWorld()
    const target = w.inData('journal', 'e1.json')
    let looks = 0
    disk.beforeRealpath = async (asked) => {
      if (asked !== target) return
      looks += 1
      if (looks === 2) disk.realpathFails = { under: target, code: 'EIO', hits: 0 }
    }
    const before = await snapshotTree(w.root)
    const result = await w.run([{ op: 'write', path: target, data: '{}', mode: 'create' }])
    expect(disk.realpathFails?.hits, 'the injected error was really hit').toBe(1)
    expect(result).toEqual(refusedWith({ reason: 'check-failed', path: target }))
    expect(await snapshotTree(w.root)).toEqual(before)
  })

  it('TOCTOU: a folder swapped while an earlier op runs stops the request before the op that would go through it', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const decoy = join(sub, 'Slot_00000002.save')
    await writeFile(decoy, 'decoy mod')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    let swapped = false
    disk.whenTempOpens = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(w.inFolder('saves'), sub)
      swapped = true
    }
    const note = w.inData('journal', 'e1.json')
    const result = await w.run([
      { op: 'write', path: note, data: '{}', mode: 'create' },
      { op: 'move', from: decoy, to: w.inData('holding', 'taken.save') },
      { op: 'mkdir', path: w.inData('never') }
    ])
    expect(swapped, 'the folder was really swapped during the first op').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 1 })
    expect(result.status === 'failed' ? result.detail : '').toContain('saves-or-tray')
    expect(await readFile(note, 'utf8')).toBe('{}')
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
    expect(await exists(w.inData('holding', 'taken.save'))).toBe(false)
    expect(await exists(w.inData('never'))).toBe(false)
  })

  it('TOCTOU: a move across drives does not remove a save when the source folder is swapped during the copy', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const decoy = join(sub, 'Slot_00000002.save')
    await writeFile(decoy, 'decoy mod')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    disk.crossDrive = { from: decoy, hits: 0 }
    let swapped = false
    // Fires when the finished copy is about to get its name. Every file handle is closed by then.
    disk.atTheLastMoment = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(w.inFolder('saves'), sub)
      swapped = true
    }
    const result = await w.run([{ op: 'move', from: decoy, to: w.inData('holding', 'taken.save') }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(swapped, 'the folder was really swapped during the copy').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
  })

  it('an earlier op may make the folder that later ops go into', async () => {
    const w = await makeWorld()
    const to = w.inData('holding', 'e1', 'cozy_rug.package')
    expect(
      await w.run([
        { op: 'mkdir', path: w.inData('holding', 'e1') },
        { op: 'move', from: w.inFolder(...MOD), to },
        { op: 'write', path: w.inData('holding', 'e1', 'note.json'), data: '{}', mode: 'create' },
        { op: 'remove', path: w.inData('holding', 'e1', 'note.json') }
      ])
    ).toEqual({ status: 'done' })
    expect(await readdir(dirname(to))).toEqual(['cozy_rug.package'])
  })
})

// The gate makes every folder and file in app data, and never a link. A link there was made by something else,
// and a path through it names one thing and reaches another: a copy in holding that is really a file in a backup.
describe('a path in app data leads only to its own name', () => {
  const BACKUP_BYTES = 'her only way back'

  /** A verified backup of one mod, and a holding folder that is really a link into that backup. */
  async function holdingLinkedIntoBackup(w: World): Promise<{ kept: string; through: string }> {
    const kept = w.inData('backups', 'b1', 'files', 'Mods')
    await mkdir(kept, { recursive: true })
    await writeFile(join(kept, 'cozy_rug.package'), BACKUP_BYTES)
    await mkdir(w.inData('holding', 'e1'), { recursive: true })
    const through = w.inData('holding', 'e1', 'Mods')
    await linkFolder(kept, through)
    return { kept, through }
  }

  type ThroughLink = (w: World, through: string) => { op: WriteOp; refused: string }
  const writes: [string, ThroughLink][] = [
    [
      'remove of a copy in holding',
      (_w, through) => {
        const path = join(through, 'cozy_rug.package')
        return { op: { op: 'remove', path }, refused: path }
      }
    ],
    [
      'write (replace) over a copy in holding',
      (_w, through) => {
        const path = join(through, 'cozy_rug.package')
        return { op: { op: 'write', path, data: 'overwritten', mode: 'replace' }, refused: path }
      }
    ],
    [
      'write (create) beside it',
      (_w, through) => {
        const path = join(through, 'note.json')
        return { op: { op: 'write', path, data: '{}', mode: 'create' }, refused: path }
      }
    ],
    [
      'move of the copy back into Mods',
      (w, through) => {
        const from = join(through, 'cozy_rug.package')
        return { op: { op: 'move', from, to: w.inFolder('Mods', 'back.package') }, refused: from }
      }
    ],
    [
      'move of the copy inside app data',
      (w, through) => {
        const from = join(through, 'cozy_rug.package')
        return { op: { op: 'move', from, to: w.inData('holding', 'e1', 'aside.package') }, refused: from }
      }
    ],
    [
      'move of a mod into holding',
      (w, through) => {
        const to = join(through, 'second.package')
        return { op: { op: 'move', from: w.inFolder(...MOD), to }, refused: to }
      }
    ],
    [
      'copy of a mod into holding',
      (w, through) => {
        const to = join(through, 'second.package')
        return { op: { op: 'copy', from: w.inFolder(...MOD), to }, refused: to }
      }
    ],
    [
      'mkdir in holding',
      (_w, through) => {
        const path = join(through, 'New')
        return { op: { op: 'mkdir', path }, refused: path }
      }
    ]
  ]

  it.each(writes)('link-escape: %s, through a folder link from holding into a backup', async (_name, build) => {
    const w = await makeWorld()
    const { kept, through } = await holdingLinkedIntoBackup(w)
    const { op, refused } = build(w, through)
    // As PR 9's undo sends it: the Sims folder named, the game closed, the backup verified.
    await expectRefusal(w, () => w.run([op], { reason: 'undo' }), { reason: 'link-escape', path: refused })
    expect(await readdir(kept)).toEqual(['cozy_rug.package'])
    expect(await readFile(join(kept, 'cozy_rug.package'), 'utf8')).toBe(BACKUP_BYTES)
  })

  it('link-escape: a folder link from one holding entry into another', async () => {
    const w = await makeWorld()
    const held = w.inData('holding', 'e2', 'Mods', 'held.package')
    await mkdir(dirname(held), { recursive: true })
    await writeFile(held, 'a mod that entry e2 holds')
    await linkFolder(w.inData('holding', 'e2'), w.inData('holding', 'e1'))
    const target = w.inData('holding', 'e1', 'Mods', 'held.package')
    await expectRefusal(w, () => w.run([{ op: 'remove', path: target }], { reason: 'undo' }), {
      reason: 'link-escape',
      path: target
    })
    expect(await readFile(held, 'utf8')).toBe('a mod that entry e2 holds')
  })

  it('link-escape: a folder link from holding into the journal, and from the state folder to the key', async () => {
    const w = await makeWorld()
    await mkdir(w.inData('journal'), { recursive: true })
    await writeFile(w.inData('journal', 'e0.json'), '{"id":"e0"}')
    await mkdir(w.inData('assist'), { recursive: true })
    await writeFile(w.inData('assist', 'key.bin'), 'sealed key')
    await mkdir(w.inData('holding'), { recursive: true })
    await linkFolder(w.inData('journal'), w.inData('holding', 'e1'))
    await linkFolder(w.inData('assist'), w.inData('state'))
    for (const target of [w.inData('holding', 'e1', 'e0.json'), w.inData('state', 'key.bin')]) {
      for (const op of [
        { op: 'remove', path: target },
        { op: 'write', path: target, data: '{}', mode: 'replace' }
      ] satisfies WriteOp[]) {
        await expectRefusal(w, () => w.run([op], { folderPath: null, reason: 'state' }), {
          reason: 'link-escape',
          path: target
        })
      }
    }
  })

  it('link-escape: a file link in holding that points at a file in a backup', async (ctx) => {
    const w = await makeWorld()
    const kept = w.inData('backups', 'b1', 'files', 'Mods', 'cozy_rug.package')
    await mkdir(dirname(kept), { recursive: true })
    await writeFile(kept, BACKUP_BYTES)
    const link = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    await mkdir(dirname(link), { recursive: true })
    try {
      await symlink(kept, link, 'file')
    } catch {
      ctx.skip() // Windows without the right to make file links
      return
    }
    for (const op of [
      { op: 'remove', path: link },
      { op: 'write', path: link, data: 'overwritten', mode: 'replace' },
      { op: 'move', from: link, to: w.inFolder('Mods', 'back.package') }
    ] satisfies WriteOp[]) {
      await expectRefusal(w, () => w.run([op], { reason: 'undo' }), { reason: 'link-escape', path: link })
    }
  })

  it('a link is never removed by its own path, and goes with the folder it sits in, which is not followed', async () => {
    const w = await makeWorld()
    const { kept, through } = await holdingLinkedIntoBackup(w)
    await expectRefusal(w, () => w.run([{ op: 'remove', path: through }], { reason: 'undo' }), {
      reason: 'link-escape',
      path: through
    })
    expect(await w.run([{ op: 'remove', path: w.inData('holding', 'e1') }], { reason: 'undo' })).toEqual({
      status: 'done'
    })
    expect(await exists(w.inData('holding', 'e1'))).toBe(false)
    expect(await readFile(join(kept, 'cozy_rug.package'), 'utf8')).toBe(BACKUP_BYTES)
  })

  it('TOCTOU: a holding folder swapped for a link into a backup while the game is asked removes nothing', async () => {
    const w = await makeWorld()
    const kept = w.inData('backups', 'b1', 'files', 'Mods')
    await mkdir(kept, { recursive: true })
    await writeFile(join(kept, 'cozy_rug.package'), BACKUP_BYTES)
    const sub = w.inData('holding', 'e1', 'Mods')
    await mkdir(sub, { recursive: true })
    const target = join(sub, 'cozy_rug.package')
    await writeFile(target, 'the copy in holding')
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(kept, sub)
      return await realGame()
    }
    const result = await w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'TriggerGuard') }, { op: 'remove', path: target }])
    expect(result).toEqual(refusedWith({ reason: 'link-escape', path: target }))
    expect(await readFile(join(kept, 'cozy_rug.package'), 'utf8')).toBe(BACKUP_BYTES)
    expect(await exists(w.inFolder('Mods', 'TriggerGuard'))).toBe(false)
  })

  it('an app data folder that is itself reached through a link takes every write PR 9 sends', async () => {
    const w = await makeWorld()
    const player = join(w.root, 'pc', 'Users', 'Player')
    await mkdir(join(player, 'BigDisk', 'Local'), { recursive: true })
    await linkFolder(join(player, 'BigDisk', 'Local'), join(player, 'LocalLink'))
    w.paths = appPaths({ localAppData: join(player, 'LocalLink'), desktopDir: w.desktopDir })
    w.deps.paths = w.paths
    w.dataDir = w.paths.dataDir
    const realData = join(player, 'BigDisk', 'Local', 'SimsHelper')
    const manifest = w.inData('backups', 'b2', 'manifest.json')
    const stored = w.inData('backups', 'b2', 'files', 'Mods', 'cozy_rug.package')
    const held = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const entry = w.inData('journal', 'e1.json')
    const modBytes = await sha256(w.inFolder(...MOD))

    // A backup: its folders and its list, the copies, then the list again.
    expect(
      await w.run(
        [
          { op: 'mkdir', path: w.inData('backups') },
          { op: 'mkdir', path: w.inData('backups', 'b2') },
          { op: 'mkdir', path: w.inData('backups', 'b2', 'files') },
          { op: 'write', path: manifest, data: '{"state":"copying"}', mode: 'create' }
        ],
        { folderPath: null, reason: 'backup' }
      )
    ).toEqual({ status: 'done' })
    expect(
      await w.run(
        [
          { op: 'mkdir', path: dirname(stored) },
          { op: 'copy', from: w.inFolder(...MOD), to: stored }
        ],
        { reason: 'backup' }
      )
    ).toEqual({ status: 'done' })
    expect(
      await w.run([{ op: 'write', path: manifest, data: '{"state":"verified"}', mode: 'replace' }], {
        folderPath: null,
        reason: 'backup'
      })
    ).toEqual({ status: 'done' })
    // A journal entry, a fix that moves a mod into holding, its undo, the cleanup of holding, and a state file.
    expect(
      await w.run(
        [
          { op: 'mkdir', path: w.inData('journal') },
          { op: 'write', path: entry, data: '{"id":"e1"}', mode: 'create' }
        ],
        { folderPath: null, reason: 'journal' }
      )
    ).toEqual({ status: 'done' })
    expect(
      await w.run([
        { op: 'mkdir', path: dirname(held) },
        { op: 'move', from: w.inFolder(...MOD), to: held }
      ])
    ).toEqual({ status: 'done' })
    expect(await w.run([{ op: 'move', from: held, to: w.inFolder(...MOD) }], { reason: 'undo' })).toEqual({
      status: 'done'
    })
    await writeFile(held, 'a copy left in holding')
    expect(await w.run([{ op: 'remove', path: held }], { reason: 'undo' })).toEqual({ status: 'done' })
    expect(
      await w.run([{ op: 'write', path: entry, data: '{"id":"e1","state":"undone"}', mode: 'replace' }], {
        folderPath: null,
        reason: 'journal'
      })
    ).toEqual({ status: 'done' })
    expect(
      await w.run(
        [
          { op: 'mkdir', path: w.inData('state') },
          { op: 'write', path: w.inData('state', 'update.json'), data: '{}', mode: 'replace' }
        ],
        { folderPath: null, reason: 'state' }
      )
    ).toEqual({ status: 'done' })
    expect(
      await w.run([{ op: 'write', path: w.inData('assist', 'key.bin'), data: new Uint8Array([1, 2, 3]), mode: 'replace' }], {
        folderPath: null,
        reason: 'key'
      })
    ).toEqual({ status: 'done' })

    expect(await sha256(join(realData, 'backups', 'b2', 'files', 'Mods', 'cozy_rug.package'))).toBe(modBytes)
    expect(await sha256(w.inFolder(...MOD))).toBe(modBytes)
    expect(await readFile(join(realData, 'backups', 'b2', 'manifest.json'), 'utf8')).toBe('{"state":"verified"}')
    expect(await readFile(join(realData, 'journal', 'e1.json'), 'utf8')).toBe('{"id":"e1","state":"undone"}')
    expect(await readdir(join(realData, 'holding', 'e1', 'Mods'))).toEqual([])
    expect((await readdir(join(realData, 'state'))).sort()).toEqual(['update.json'])
    expect(await exists(join(realData, 'assist', 'key.bin'))).toBe(true)
  })
})

describe('doing the ops', () => {
  it('a refused request changes nothing, even when its first ops were fine', async () => {
    const w = await makeWorld()
    const bad = w.inFolder('saves', 'x.save')
    await expectRefusal(
      w,
      () =>
        w.run([
          { op: 'mkdir', path: w.inData('journal') },
          { op: 'move', from: w.inFolder(...MOD), to: w.inData('holding', 'cozy_rug.package') },
          { op: 'write', path: bad, data: 'x', mode: 'create' }
        ]),
      { reason: 'saves-or-tray', path: bad }
    )
    expect(w.asked).toEqual([])
  })

  it('never overwrites: copy, move and write (create) onto an existing target fail and leave it alone', async () => {
    const w = await makeWorld()
    const taken = w.inData('holding', 'taken.package')
    await mkdir(dirname(taken), { recursive: true })
    await writeFile(taken, 'already here')
    const before = await snapshotTree(w.root)
    const ops: WriteOp[] = [
      { op: 'copy', from: w.inFolder(...MOD), to: taken },
      { op: 'move', from: w.inFolder(...MOD), to: taken },
      { op: 'write', path: taken, data: 'new', mode: 'create' },
      { op: 'move', from: w.inFolder(...MOD), to: w.inFolder('Mods', 'Resource.cfg') }
    ]
    for (const op of ops) {
      const result = await w.run([op])
      expect(result, op.op).toMatchObject({ status: 'failed', opsDone: 0 })
      expect(await snapshotTree(w.root), op.op).toEqual(before)
    }
  })

  it('never overwrites a target that appears while the new file is still being written', async () => {
    const w = await makeWorld()
    const target = w.inData('holding', 'late.package')
    const from = w.inFolder(...MOD)
    const ops: WriteOp[] = [
      { op: 'write', path: target, data: 'ours', mode: 'create' },
      { op: 'copy', from, to: target },
      { op: 'move', from, to: target }
    ]
    for (const op of ops) {
      await rm(target, { force: true })
      if (op.op === 'move') disk.crossDrive = { from, hits: 0 }
      let appeared = false
      disk.whenTempOpens = async () => {
        await writeFile(target, 'someone else was first')
        appeared = true
      }
      expect(await w.run([op]), op.op).toMatchObject({ status: 'failed', opsDone: 0 })
      expect(appeared, `${op.op}: the other file really appeared`).toBe(true)
      expect(await readFile(target, 'utf8'), op.op).toBe('someone else was first')
      expect(await readdir(dirname(target)), op.op).toEqual(['late.package'])
      expect(await exists(from), op.op).toBe(true)
    }
  })

  it('never overwrites a target that appears at the very last moment, on one drive or across two', async () => {
    const w = await makeWorld()
    const target = w.inData('holding', 'late.package')
    const from = w.inFolder(...MOD)
    const ops: [string, WriteOp, boolean][] = [
      ['write', { op: 'write', path: target, data: 'ours', mode: 'create' }, false],
      ['copy', { op: 'copy', from, to: target }, false],
      ['move on one drive', { op: 'move', from, to: target }, false],
      ['move across drives', { op: 'move', from, to: target }, true]
    ]
    // On a disk with no hard links the gate looks right before it renames: the file appears just before that look.
    const cases = [false, true].flatMap((noHardLinks) =>
      ops.map(
        ([name, op, crossDrive]) =>
          [`${name}${noHardLinks ? ', no hard links' : ''}`, op, crossDrive, noHardLinks] as const
      )
    )
    for (const [name, op, crossDrive, noHardLinks] of cases) {
      await rm(target, { force: true })
      disk.crossDrive = crossDrive ? { from, hits: 0 } : null
      disk.noHardLinks = noHardLinks ? { code: 'EPERM', hits: 0 } : null
      let appeared = false
      disk.atTheLastMoment = async () => {
        await writeFile(target, 'someone else was first')
        appeared = true
      }
      expect(await w.run([op]), name).toMatchObject({ status: 'failed', opsDone: 0 })
      expect(appeared, `${name}: the other file really appeared`).toBe(true)
      expect(await readFile(target, 'utf8'), name).toBe('someone else was first')
      expect(await readdir(dirname(target)), name).toEqual(['late.package'])
      expect(await exists(from), name).toBe(true)
    }
  })

  it('a move on one drive whose source cannot be removed takes the new name back', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const before = await snapshotTree(w.folder)
    disk.unlinkFails = { file: from, hits: 0 }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await snapshotTree(w.folder)).toEqual(before)
    expect(await readdir(dirname(to))).toEqual([])
  })

  // After the new name is given the file has two names. If the old one cannot be removed and is then gone,
  // the new name is the last one: removing it would lose the file. Another file at the old path changes nothing.
  it('a move on one drive: when the source cannot be removed and another file now stands at its path, the new name is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    await mkdir(sub, { recursive: true })
    await mkdir(other, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    let replaced = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        // The other file has two names of its own, so only its id tells it from the source.
        await writeFile(join(other, 'only_copy.package'), 'the only copy of this mod')
        await link(join(other, 'only_copy.package'), join(other, 'second_name.package'))
        await rm(sub, { recursive: true })
        await linkFolder(other, sub)
        replaced = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(to), 'the last name of the mod is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the file at the target was left in place/)
  })

  // Held before and after this fix: a source that is gone cannot be asked for its id, and that is not proof.
  it('a move on one drive: when the source cannot be removed and is then gone, the new name is kept', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    disk.unlinkFails = { file: from, hits: 0, meanwhile: async () => await rm(from) }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(await exists(from), 'the source is really gone').toBe(false)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await sha256(to), 'the last name of the mod is still at the target').toBe(hash)
  })

  // Here the old path now leads to the new name itself: one name, reached by two paths. The ids match, and
  // removing "the new name" would still remove the last one.
  it('a move on one drive: when the source cannot be removed and its path now leads to the new name, the new name is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    let replaced = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        await rm(sub, { recursive: true })
        await linkFolder(dirname(to), sub)
        replaced = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(to), 'the last name of the mod is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the file at the target was left in place/)
  })

  // The same swap, and the mod has one more name elsewhere. Now the ids match and the file has two names,
  // yet neither is the source path: taking the new name back would leave the mod only where nobody looks.
  it('a move on one drive: when the source path now leads to the new name and the mod has another name elsewhere, the new name is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    await link(from, w.inFolder('Mods', 'another_name.package'))
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    let replaced = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        await rm(sub, { recursive: true })
        await linkFolder(dirname(to), sub)
        replaced = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(to), 'the new name is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the file at the target was left in place/)
  })

  // Follow-up to the last check, 2026-11-24 (Opus). The new name is taken back only from where the gate put
  // it. Here the mod has one more name in Mods, and the target folder now leads to the folder that holds it:
  // the path of the new name reaches that other name. Same file, two real names, so the proof of the source
  // passes, and only a look at the target path keeps a name in Mods from being removed.
  it('a move on one drive: when the source cannot be removed and the target folder was swapped, no other name of the mod is removed through it', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const elsewhere = w.inFolder('Mods', 'Elsewhere')
    const bystander = join(elsewhere, 'cozy_rug.package')
    await mkdir(elsewhere, { recursive: true })
    await link(from, bystander)
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const aside = w.inData('holding', 'aside')
    const before = await snapshotTree(w.folder)
    let swapped = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        await rename(dirname(to), aside)
        await linkFolder(elsewhere, dirname(to))
        swapped = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(swapped, 'the target folder was really swapped').toBe(true)
    expect(await exists(bystander), 'the other name in Mods is still there').toBe(true)
    expect(await snapshotTree(w.folder), 'nothing in the Sims folder changed').toEqual(before)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect((result as { detail: string }).detail).toMatch(/the file at the target was left in place/)
    expect(await sha256(join(aside, 'cozy_rug.package')), 'the new name is where the gate put it').toBe(hash)
  })

  // Pins the count of names. The old path leads to the new name, as two tests above, and the file has that
  // one name. If the paths were followed without the count, a folder pointed elsewhere between the look at
  // the files and the look at the paths would show two different real names for a file that has one, and
  // the last name would be removed. The count answers first, so the second swap here never gets its turn.
  it('a move on one drive: when the source path leads to the new name and is pointed elsewhere while the two are compared, the new name is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    await mkdir(sub, { recursive: true })
    await mkdir(other, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    await writeFile(join(other, 'only_copy.package'), 'a different mod')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    let replaced = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        await rm(sub, { recursive: true })
        await linkFolder(dirname(to), sub)
        replaced = true
        let pointedElsewhere = false
        disk.beforeRealpath = async (target) => {
          if (target !== from || pointedElsewhere) return
          pointedElsewhere = true
          await rm(sub)
          await linkFolder(other, sub)
        }
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced').toBe(true)
    expect(await exists(to), 'the last name of the mod is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect((result as { detail: string }).detail).toMatch(/the file at the target was left in place/)
  })

  // With no file id there is no way to tell that both names are one file: every file answers 0, so the
  // ids match for any two. In doubt the new name stays.
  it('a move on one drive: when the source cannot be removed on a disk that gives no file ids, the new name is kept', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    disk.unlinkFails = { file: from, hits: 0 }
    disk.noFileIds = { files: [from, to], hits: 0 }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(disk.noFileIds.hits, 'the source was really asked for its id').toBeGreaterThan(0)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await sha256(from), 'the source is untouched').toBe(hash)
    expect(await sha256(to), 'the new name is still at the target').toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the file at the target was left in place/)
  })

  it('on a disk with no hard links it looks first and then renames, and still never overwrites', async () => {
    for (const code of ['EPERM', 'ENOSYS', 'EISDIR']) {
      const w = await makeWorld()
      const from = w.inFolder(...MOD)
      const hash = await sha256(from)
      const moved = w.inData('holding', 'moved.package')
      const copied = w.inData('holding', 'copied.package')
      const written = w.inData('holding', 'written.json')
      disk.noHardLinks = { code, hits: 0 }
      expect(
        await w.run([
          { op: 'copy', from, to: copied },
          { op: 'write', path: written, data: '{}', mode: 'create' },
          { op: 'move', from, to: moved }
        ]),
        code
      ).toEqual({ status: 'done' })
      expect(disk.noHardLinks.hits, `${code}: a hard link was tried for each`).toBe(3)
      expect(await sha256(moved)).toBe(hash)
      expect(await sha256(copied)).toBe(hash)
      expect(await exists(from)).toBe(false)
      expect((await readdir(dirname(moved))).sort()).toEqual(['copied.package', 'moved.package', 'written.json'])

      const before = await snapshotTree(w.root)
      for (const op of [
        { op: 'copy', from: moved, to: copied },
        { op: 'write', path: written, data: 'new', mode: 'create' },
        { op: 'move', from: copied, to: moved }
      ] satisfies WriteOp[]) {
        expect(await w.run([op]), `${code} ${op.op}`).toMatchObject({ status: 'failed', opsDone: 0 })
      }
      expect(await snapshotTree(w.root)).toEqual(before)

      // Across drives the copy still gets its name by looking first.
      disk.crossDrive = { from: moved, hits: 0 }
      const far = w.inData('holding', 'far.package')
      expect(await w.run([{ op: 'move', from: moved, to: far }]), code).toEqual({ status: 'done' })
      expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
      expect(await sha256(far)).toBe(hash)
      expect(await exists(moved)).toBe(false)
      disk.crossDrive = null
      disk.noHardLinks = null
    }
  })

  it('runs one request at a time: a second request waits until the first is over', async () => {
    const w = await makeWorld()
    let letGo = (): void => undefined
    const held = new Promise<void>((resolve) => {
      letGo = resolve
    })
    let gameWasAsked = (): void => undefined
    const asked = new Promise<void>((resolve) => {
      gameWasAsked = resolve
    })
    const realGame = w.deps.gameState
    w.deps.gameState = async () => {
      gameWasAsked()
      await held
      return await realGame()
    }
    const first = w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }])
    await asked
    const note = w.inData('state', 'settings.json')
    const second = w.run([{ op: 'write', path: note, data: '{}', mode: 'create' }], {
      folderPath: null,
      reason: 'state'
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const ranEarly = await exists(note)
    letGo()
    expect(await first).toEqual({ status: 'done' })
    expect(await second).toEqual({ status: 'done' })
    expect(ranEarly, 'the second request ran while the first was still waiting for the game').toBe(false)
    expect(await readFile(note, 'utf8')).toBe('{}')
  })

  it('a refused, a failed and an unreadable request each leave the gate open for the next', async () => {
    const w = await makeWorld()
    const results = await Promise.all([
      w.run([{ op: 'remove', path: w.inFolder(...SAVE) }]),
      w.run([{ op: 'move', from: w.inFolder('Mods', 'gone.package'), to: w.inData('holding', 'gone.package') }]),
      runGate(null as unknown as GateDeps, null as unknown as WriteRequest),
      w.run([{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null })
    ])
    expect(results.map((result) => result.status)).toEqual(['refused', 'failed', 'refused', 'done'])
  })

  it('a source that changes while it is copied fails the copy', async () => {
    const w = await makeWorld()
    const source = w.inData('growing.bin')
    await mkdir(w.dataDir, { recursive: true })
    await writeFile(source, 'first part')
    const target = w.inData('copies', 'growing.bin')
    let grew = false
    disk.whenTempOpens = async () => {
      await writeFile(source, 'first part and more')
      grew = true
    }
    expect(await w.run([{ op: 'copy', from: source, to: target }])).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(grew).toBe(true)
    expect(await readdir(dirname(target))).toEqual([])
  })

  it('a write and a copy are on the disk before the gate says done: the file before it gets its name, the folder after', async () => {
    const w = await makeWorld()
    const note = w.inData('journal', 'e1.json')
    const kept = w.inData('backups', 'b1', 'cozy_rug.package')
    const options = w.inFolder('Options.ini')
    disk.log = []
    expect(
      await w.run([
        { op: 'write', path: note, data: '{}', mode: 'create' },
        { op: 'copy', from: w.inFolder(...MOD), to: kept },
        { op: 'write', path: options, data: 'modsdisabled = 1\n', mode: 'replace' }
      ])
    ).toEqual({ status: 'done' })
    const log = disk.log
    const tempOf = (did: string, target: string): number =>
      log.findIndex((entry) => entry.startsWith(`${did} ${target}.`) && entry.endsWith('.sims-helper-tmp'))
    for (const target of [note, kept, options]) {
      const flushed = tempOf('flush', target)
      const named = log.indexOf(`name ${target}`)
      expect(flushed, `${target} is flushed`).toBeGreaterThanOrEqual(0)
      expect(named, `${target} gets its name after the flush`).toBeGreaterThan(flushed)
      // Windows gives Node no way to flush a folder.
      if (!ON_WINDOWS) {
        expect(log.indexOf(`flush ${dirname(target)}`, named), `the folder of ${target} is flushed`).toBeGreaterThan(named)
      }
    }
    // The file date a copy keeps is part of what is flushed.
    expect(tempOf('date', kept)).toBeGreaterThanOrEqual(0)
    expect(tempOf('flush', kept)).toBeGreaterThan(tempOf('date', kept))
  })

  it.each(['write', 'copy'] as const)('a %s the disk cannot flush fails, and nothing takes the name', async (kind) => {
    const w = await makeWorld()
    const target = w.inData('kept', 'new.bin')
    const op: WriteOp =
      kind === 'write'
        ? { op: 'write', path: target, data: 'x', mode: 'create' }
        : { op: 'copy', from: w.inFolder(...MOD), to: target }
    disk.flushFails = { code: 'EIO', folders: false, hits: 0 }
    const result = await w.run([op], { reason: 'backup' })
    expect(disk.flushFails.hits, 'the flush was really asked for').toBe(1)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(result.status === 'failed' ? result.detail : '').toContain('EIO')
    expect(await readdir(dirname(target))).toEqual([])
  })

  it.skipIf(ON_WINDOWS)('a folder the disk cannot flush fails the op: done is never said for a name that may not last', async () => {
    const w = await makeWorld()
    const target = w.inData('kept', 'new.bin')
    disk.flushFails = { code: 'EIO', folders: true, hits: 0 }
    const result = await w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }])
    expect(disk.flushFails.hits, 'the flush was really asked for').toBe(1)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(result.status === 'failed' ? result.detail : '').toContain('EIO')
  })

  it('failed reports how many ops ran, and those really happened', async () => {
    const w = await makeWorld()
    const taken = w.inData('holding', 'taken.package')
    await mkdir(dirname(taken), { recursive: true })
    await writeFile(taken, 'already here')
    const result = await w.run([
      { op: 'mkdir', path: w.inData('journal') },
      { op: 'move', from: w.inFolder(...MOD), to: w.inData('holding', 'cozy_rug.package') },
      { op: 'move', from: w.inFolder('Mods', 'Resource.cfg'), to: taken },
      { op: 'write', path: w.inData('journal', 'e1.json'), data: '{}', mode: 'create' }
    ])
    expect(result).toMatchObject({ status: 'failed', opsDone: 2 })
    expect((await stat(w.inData('journal'))).isDirectory()).toBe(true)
    expect(await exists(w.inData('holding', 'cozy_rug.package'))).toBe(true)
    expect(await exists(w.inFolder(...MOD))).toBe(false)
    expect(await exists(w.inFolder('Mods', 'Resource.cfg'))).toBe(true)
    expect(await readFile(taken, 'utf8')).toBe('already here')
    expect(await exists(w.inData('journal', 'e1.json'))).toBe(false)
  })

  it('a missing source fails', async () => {
    const w = await makeWorld()
    for (const op of [
      { op: 'move', from: w.inFolder('Mods', 'gone.package'), to: w.inData('holding', 'gone.package') },
      { op: 'copy', from: w.inFolder('Mods', 'gone.package'), to: w.inData('copies', 'gone.package') }
    ] satisfies WriteOp[]) {
      expect(await w.run([op])).toMatchObject({ status: 'failed', opsDone: 0 })
    }
  })

  it('detail names the op and the path, and never the contents', async () => {
    const w = await makeWorld()
    const target = w.inData('assist', 'key.bin')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'old')
    const secret = 'sk-ant-made-up-key-0123456789'
    const asText = await w.run([{ op: 'write', path: target, data: secret, mode: 'create' }], { reason: 'key' })
    // A folder where the file should go makes the final rename fail, after the secret reached the temp file.
    const blocked = w.inData('assist', 'blocked.bin')
    await mkdir(join(blocked, 'x'), { recursive: true })
    const asBytes = await w.run(
      [{ op: 'write', path: blocked, data: new TextEncoder().encode(secret), mode: 'replace' }],
      { reason: 'key' }
    )
    for (const [result, file] of [
      [asText, target],
      [asBytes, blocked]
    ] as const) {
      expect(result.status).toBe('failed')
      const detail = result.status === 'failed' ? result.detail : ''
      expect(detail).toContain('write')
      expect(detail).toContain(file)
      expect(detail).not.toContain('sk-ant')
      expect(detail).not.toContain('0123456789')
    }
    expect((await readdir(dirname(target))).sort()).toEqual(['blocked.bin', 'key.bin'])

    // Node can quote an argument in its own error message. The gate never passes that message on.
    disk.writeFileQuotesItsData = { hits: 0 }
    const fresh = w.inData('assist', 'fresh.bin')
    const quoted = await w.run([{ op: 'write', path: fresh, data: secret, mode: 'create' }], { reason: 'key' })
    expect(disk.writeFileQuotesItsData.hits, 'the quoting error was really thrown').toBe(1)
    expect(quoted).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(JSON.stringify(quoted)).not.toContain('sk-ant')
    expect(JSON.stringify(quoted)).toContain(fresh.replaceAll('\\', '\\\\'))
    expect((await readdir(dirname(target))).sort()).toEqual(['blocked.bin', 'key.bin'])
  })

  it.skipIf(ON_WINDOWS)('the key file is readable by her account only', async () => {
    const w = await makeWorld()
    const target = w.inData('assist', 'key.bin')
    expect(await w.run([{ op: 'write', path: target, data: 'x', mode: 'create' }], { reason: 'key' })).toEqual({
      status: 'done'
    })
    expect((await stat(target)).mode & 0o077).toBe(0)
  })

  it('makes missing folders above a new file in Mods and app data, and nowhere else', async () => {
    const w = await makeWorld()
    await rm(w.desktopDir, { recursive: true })
    const report = join(w.desktopDir, REPORT_NAME)
    expect(
      await w.run([{ op: 'write', path: report, data: 'x', mode: 'create' }], { folderPath: null })
    ).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(w.desktopDir)).toBe(false)
    const deep = w.inFolder('Mods', 'A', 'B', 'cozy_rug.package')
    expect(await w.run([{ op: 'move', from: w.inFolder(...MOD), to: deep }])).toEqual({ status: 'done' })
    expect(await exists(deep)).toBe(true)
  })

  it('move across drives: the target has the same hash and date, and the source is gone', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    const date = (await stat(from)).mtimeMs
    disk.crossDrive = { from, hits: 0 }
    expect(await w.run([{ op: 'move', from, to }])).toEqual({ status: 'done' })
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(await sha256(to)).toBe(hash)
    expect(Math.abs((await stat(to)).mtimeMs - date)).toBeLessThan(2)
    expect(await exists(from)).toBe(false)
    expect(await readdir(dirname(to))).toEqual(['cozy_rug.package'])
  })

  it('move across drives: when the copy does not match, the source stays and nothing is left at the target', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const before = await snapshotTree(w.folder)
    disk.crossDrive = { from, hits: 0 }
    disk.corruptNewFiles = { hits: 0 }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.corruptNewFiles.hits, 'the copy was really damaged').toBe(1)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await snapshotTree(w.folder)).toEqual(before)
    expect(await readdir(dirname(to))).toEqual([])
  })

  it('move across drives: when the source cannot be removed, the copy is taken back', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const before = await snapshotTree(w.folder)
    disk.crossDrive = { from, hits: 0 }
    disk.unlinkFails = { file: from, hits: 0 }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await snapshotTree(w.folder)).toEqual(before)
    expect(await readdir(dirname(to))).toEqual([])
  })

  // `failed` with opsDone 0 says the move did not run. The copy can go only because the source is proven
  // still in place: its folder was moved aside and linked back, so the same file still stands at the source
  // path. (Until the last check of 2026-11-24 this test deleted the original and still wanted the target
  // empty, which is the loss of the only copy. That case is the "original is gone" test below.)
  it('move across drives: when the source folder is swapped during the copy and the source is still the same file, nothing is left at the target', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const aside = w.inFolder('Mods', 'Aside')
    await mkdir(sub, { recursive: true })
    const from = join(sub, 'still_here.package')
    await writeFile(from, 'a mod that stays')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'still_here.package')
    disk.crossDrive = { from, hits: 0 }
    let swapped = false
    disk.atTheLastMoment = async () => {
      await rename(sub, aside)
      await linkFolder(aside, sub)
      swapped = true
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(swapped, 'the folder was really swapped during the copy').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect((result as { detail: string }).detail).toContain('link-escape')
    expect((result as { detail: string }).detail).not.toMatch(/left in place/)
    expect(await sha256(join(aside, 'still_here.package')), 'the original is untouched').toBe(hash)
    expect(await sha256(from), 'and it still stands at the source path').toBe(hash)
    expect(await readdir(dirname(to))).toEqual([])
  })

  // Only the source folder is swapped, for a link into saves. The target is left alone. The source path now
  // leads to a real save of the same name, and nothing in saves may change. The decoy the copy was made from
  // is gone, so the copy is the only one left: it stays, and the answer says so. (The TOCTOU test in the
  // links group makes the same swap and checks saves. This one also says what becomes of the copy.)
  it('move across drives: when only the source folder is swapped for a link into saves during the copy, saves is untouched and the copy is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const from = join(sub, 'Slot_00000002.save')
    await writeFile(from, 'decoy mod')
    const to = w.inData('holding', 'e1', 'Mods', 'Slot_00000002.save')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    expect(savesBefore.has('Slot_00000002.save'), 'a real save has the name of the decoy').toBe(true)
    disk.crossDrive = { from, hits: 0 }
    let swapped = false
    disk.atTheLastMoment = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(w.inFolder('saves'), sub)
      swapped = true
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(swapped, 'the source folder was really swapped during the copy').toBe(true)
    // Asked first, so that a save that was touched shows as that, whatever the answer was.
    expect(await snapshotTree(w.inFolder('saves')), 'saves is byte for byte as it was').toEqual(savesBefore)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect((result as { detail: string }).detail).toContain('saves-or-tray')
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
    expect(await readdir(dirname(to))).toEqual(['Slot_00000002.save'])
    expect(await readFile(to, 'utf8'), 'the only copy of the decoy is still at the target').toBe('decoy mod')
  })

  // The copy is taken back only from where the gate put it. A target folder that was swapped as well could
  // lead the removal to a file somewhere else, so the copy stays and the answer says so.
  it('move across drives: when the target folder was swapped as well, the copy is kept and the detail says so', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    await mkdir(sub, { recursive: true })
    const from = join(sub, 'Slot_00000002.save')
    await writeFile(from, 'decoy mod')
    const to = w.inData('holding', 'e1', 'Mods', 'Slot_00000002.save')
    const elsewhere = w.inData('holding', 'elsewhere')
    const savesBefore = await snapshotTree(w.inFolder('saves'))
    disk.crossDrive = { from, hits: 0 }
    let swapped = false
    disk.atTheLastMoment = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(w.inFolder('saves'), sub)
      await rename(dirname(to), elsewhere)
      await linkFolder(elsewhere, dirname(to))
      swapped = true
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(swapped, 'both folders were really swapped during the copy').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
    expect(await readFile(join(elsewhere, 'Slot_00000002.save'), 'utf8')).toBe('decoy mod')
    expect(await snapshotTree(w.inFolder('saves'))).toEqual(savesBefore)
  })

  // The same care when the source cannot be removed: the copy is taken back only from where the gate put it.
  // Here the target folder now leads to another folder, which holds a file of the same name and size.
  it('move across drives: when the source cannot be removed and the target folder was swapped, nothing is removed through it', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const aside = w.inData('holding', 'aside')
    const elsewhere = w.inData('holding', 'elsewhere')
    const bystander = join(elsewhere, 'cozy_rug.package')
    const sameSize = Buffer.alloc((await stat(from)).size, 'b')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(bystander, sameSize)
    const before = await snapshotTree(w.folder)
    disk.crossDrive = { from, hits: 0 }
    let swapped = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        await rename(dirname(to), aside)
        await linkFolder(elsewhere, dirname(to))
        swapped = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(swapped, 'the target folder was really swapped').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(bystander), 'the file in the other folder is still there').toBe(true)
    expect(await readFile(bystander)).toEqual(sameSize)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
    expect(await exists(join(aside, 'cozy_rug.package')), 'the copy is where the gate put it').toBe(true)
    expect(await snapshotTree(w.folder)).toEqual(before)
  })

  // With the source no longer surely there, the copy may be the only one left. It stays, and the answer says so.
  it('move across drives: when the source cannot be removed and is then gone, the copy is kept and the detail says so', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    disk.crossDrive = { from, hits: 0 }
    disk.unlinkFails = { file: from, hits: 0, meanwhile: async () => await rm(from) }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  // Last check, 2026-11-24 (Opus). When the re-check after the copy fails, the copy is taken back on the word
  // "the source stays", which nothing checks. Here the source's folder was replaced during the copy and the
  // original is gone, so the copy is the only one left. It must stay, and the answer must say so.
  it('move across drives: when the source folder is replaced during the copy and the original is gone, the copy is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    await mkdir(sub, { recursive: true })
    await mkdir(other, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    disk.crossDrive = { from, hits: 0 }
    let replaced = false
    disk.atTheLastMoment = async () => {
      await rm(sub, { recursive: true })
      await linkFolder(other, sub)
      replaced = true
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced during the copy').toBe(true)
    expect(await exists(join(other, 'only_copy.package')), 'the original is gone').toBe(false)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(to), 'the only copy of the mod is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  // Last check, 2026-11-24 (Opus). When the source cannot be removed, "the source is surely still there" is
  // judged by its path and size alone. Here its folder now leads to another folder that holds a different file
  // of the same name and size, and the original is gone. The copy is the only one left. It must stay.
  it('move across drives: when the source cannot be removed and a same-size file now stands at its path, the copy is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    await mkdir(sub, { recursive: true })
    await mkdir(other, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    disk.crossDrive = { from, hits: 0 }
    let replaced = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        await rm(sub, { recursive: true })
        await writeFile(join(other, 'only_copy.package'), 'a different mod, same len')
        await linkFolder(other, sub)
        replaced = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(to), 'the only copy of the mod is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  // Another file with the same bytes is still another file: the original is gone, and whoever put this one
  // there may take it away again. Only the source itself, by its file id, lets the copy go.
  it('move across drives: when the source cannot be removed and another file with the same bytes now stands at its path, the copy is kept', async () => {
    const w = await makeWorld()
    const sub = w.inFolder('Mods', 'Sub')
    const other = w.inFolder('Mods', 'Other')
    await mkdir(sub, { recursive: true })
    await mkdir(other, { recursive: true })
    const from = join(sub, 'only_copy.package')
    await writeFile(from, 'the only copy of this mod')
    const hash = await sha256(from)
    const to = w.inData('holding', 'e1', 'Mods', 'only_copy.package')
    disk.crossDrive = { from, hits: 0 }
    let replaced = false
    disk.unlinkFails = {
      file: from,
      hits: 0,
      meanwhile: async () => {
        // Written before the original goes, so the two are different files with different ids.
        await writeFile(join(other, 'only_copy.package'), 'the only copy of this mod')
        await rm(sub, { recursive: true })
        await linkFolder(other, sub)
        replaced = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(replaced, 'the folder was really replaced').toBe(true)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await exists(to), 'the copy is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  // The same file, with other bytes written into it meanwhile. The copy now holds the only copy of the old bytes.
  it('move across drives: when the source cannot be removed and was rewritten with the same size, the copy is kept', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    const otherBytes = Buffer.alloc((await stat(from)).size, 'b')
    disk.crossDrive = { from, hits: 0 }
    disk.unlinkFails = { file: from, hits: 0, meanwhile: async () => await writeFile(from, otherBytes) }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(await readFile(from), 'the source was really rewritten').toEqual(otherBytes)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await sha256(to), 'the copy still holds the old bytes').toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  // Pins "a plain file" in the proof of the source. Right when the disk says "another drive", the mod is
  // moved aside and a file link to it takes its place. From then on the source path holds that link: the id
  // read before the copy is the link's, and so is the id read after it, and the bytes read through the link
  // are the bytes of the copy. Only the kind of thing at the path says it is not the file that was copied.
  it('move across drives: when a file link took the place of the source before the copy, the copy is kept', async (ctx) => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const aside = w.inFolder('Mods', 'Aside', 'cozy_rug.package')
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    await mkdir(dirname(aside), { recursive: true })
    try {
      await symlink(from, join(w.root, 'probe.package'), 'file')
    } catch {
      ctx.skip() // Windows without the right to make file links
      return
    }
    let swapped = false
    disk.crossDrive = {
      from,
      hits: 0,
      meanwhile: async () => {
        await rename(from, aside)
        await symlink(aside, from, 'file')
        swapped = true
      }
    }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(swapped, 'the source was really swapped for a link').toBe(true)
    expect((await lstat(from)).isSymbolicLink(), 'the link still stands at the source path').toBe(true)
    expect(await sha256(aside), 'the mod itself is untouched').toBe(hash)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect((result as { detail: string }).detail).toContain('link-escape')
    expect(await exists(to), 'the copy is still at the target').toBe(true)
    expect(await sha256(to)).toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  // With no file id there is no way to tell the source from another file at its path. In doubt the copy stays.
  it('move across drives: when the source cannot be removed on a disk that gives no file ids, the copy is kept', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    const to = w.inData('holding', 'e1', 'Mods', 'cozy_rug.package')
    const hash = await sha256(from)
    disk.crossDrive = { from, hits: 0 }
    disk.unlinkFails = { file: from, hits: 0 }
    disk.noFileIds = { files: [from], hits: 0 }
    const result = await w.run([{ op: 'move', from, to }])
    expect(disk.crossDrive.hits, 'the cross-drive error was really hit').toBe(1)
    expect(disk.unlinkFails.hits, 'the removal error was really hit').toBe(1)
    expect(disk.noFileIds.hits, 'the source was really asked for its id').toBeGreaterThan(0)
    expect(result).toMatchObject({ status: 'failed', opsDone: 0 })
    expect(await sha256(from), 'the source is untouched').toBe(hash)
    expect(await sha256(to), 'the copy is still at the target').toBe(hash)
    expect((result as { detail: string }).detail).toMatch(/the copy at the target was left in place/)
  })

  it('an empty request is done', async () => {
    const w = await makeWorld()
    expect(await w.run([])).toEqual({ status: 'done' })
    expect(w.asked).toEqual([])
  })
})

describe('fail closed: an error while checking refuses with check-failed', () => {
  it('the source of a copy whose real place cannot be read', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    disk.realpathFails = { under: w.inFolder('Mods'), code: 'EIO', hits: 0 }
    await expectRefusal(w, () => w.run([{ op: 'copy', from, to: w.inData('copies', 'x.package') }]), {
      reason: 'check-failed',
      path: from
    })
    expect(disk.realpathFails.hits, 'the injected error was really hit').toBeGreaterThan(0)
  })

  it('a Sims folder whose real path cannot be read', async () => {
    const w = await makeWorld()
    disk.realpathFails = { under: w.folder, code: 'EIO', hits: 0 }
    expect(await w.run([{ op: 'mkdir', path: w.inData('journal') }])).toEqual(
      refusedWith({ reason: 'check-failed', path: w.folder })
    )
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
  })

  it('a Sims folder that cannot be looked at: only a missing one is not-a-sims-folder', async () => {
    const w = await makeWorld()
    for (const file of [w.folder, w.inFolder('Options.ini')]) {
      disk.statFails = { file, code: 'EACCES', hits: 0 }
      await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inData('journal') }]), {
        reason: 'check-failed',
        path: w.folder
      })
      expect(disk.statFails.hits, 'the injected error was really hit').toBe(1)
      disk.statFails = { file, code: 'ENOENT', hits: 0 }
      await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inData('journal') }]), {
        reason: 'not-a-sims-folder',
        path: w.folder
      })
    }
  })

  it('a saves folder whose real path cannot be read, or that is a link to nowhere', async () => {
    const w = await makeWorld()
    const saves = w.inFolder('saves')
    disk.realpathFails = { under: saves, code: 'EACCES', hits: 0 }
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inData('journal') }]), {
      reason: 'check-failed',
      path: saves
    })
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
    disk.realpathFails = null

    // Saves moved to a drive that is not plugged in: where they are cannot be known, so nothing is touched.
    const tray = w.inFolder('Tray')
    await rm(tray, { recursive: true })
    await linkFolder(join(w.root, 'unplugged', 'Tray'), tray)
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inFolder('Mods', 'New') }]), {
      reason: 'check-failed',
      path: tray
    })
  })

  it('an app data folder whose real path cannot be read refuses everything', async () => {
    const w = await makeWorld()
    disk.realpathFails = { under: dirname(w.dataDir), code: 'EPERM', hits: 0 }
    expect(await w.run([{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null })).toEqual(
      refusedWith({ reason: 'check-failed', path: w.dataDir })
    )
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
  })

  it('a OneDrive root whose real path cannot be read refuses everything', async () => {
    const w = await makeWorld()
    const cloud = join(w.root, 'pc', 'Users', 'Player', 'Cloud')
    await mkdir(cloud, { recursive: true })
    w.paths.oneDriveRoots = [cloud]
    disk.realpathFails = { under: cloud, code: 'EACCES', hits: 0 }
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null }), {
      reason: 'check-failed',
      path: cloud
    })
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
  })

  it('a gate with nothing to check against', async () => {
    const result = await runGate(null as unknown as GateDeps, { reason: 'fix', folderPath: null, ops: [] })
    expect(result).toEqual(refusedWith({ reason: 'check-failed', path: '' }))
  })
})

describe('a request the gate cannot read', () => {
  it('a request the gate does not understand is refused', async () => {
    const w = await makeWorld()
    const good = w.inData('x')
    const strange: unknown[] = [
      { op: 'chmod', path: good },
      { op: 'write', path: good, data: 'x', mode: 'append' },
      { op: 'write', path: good, data: { toString: () => 'x' }, mode: 'create' },
      { op: 'write', path: good, mode: 'create' },
      { op: 'mkdir', path: 42 },
      { op: 'move', from: good },
      { path: good },
      null,
      'mkdir'
    ]
    const before = await snapshotTree(w.root)
    for (const op of strange) {
      const result = await w.run([{ op: 'mkdir', path: w.inData('first') }, op as WriteOp])
      expect(result, JSON.stringify(op)).toMatchObject({ status: 'refused', refusal: { reason: 'outside-allowed-area' } })
    }
    for (const request of [null, {}, { ops: 'all' }, { folderPath: w.folder, ops: null }]) {
      const result = await runGate(w.deps, request as unknown as WriteRequest)
      expect(result, JSON.stringify(request)).toMatchObject({
        status: 'refused',
        refusal: { reason: 'outside-allowed-area' }
      })
    }
    expect(await snapshotTree(w.root)).toEqual(before)
  })
})

describe('Windows on a real disk', () => {
  it.runIf(ON_WINDOWS)('a short 8.3 name is expanded by realpath, and a path through one is sorted by where it leads', async (ctx) => {
    // A GitHub runner's temp folder is C:\\Users\\RUNNER~1\\...: a ready-made short name.
    const shortTemp = tmpdir()
    const longTemp = await realpath(shortTemp)
    if (!shortTemp.includes('~') || shortTemp.toLowerCase() === longTemp.toLowerCase()) {
      ctx.skip() // no short name on the way to this temp folder
      return
    }
    const longRoot = await mkdtemp(join(longTemp, 'sims-helper-gate-test-'))
    worlds.push(longRoot)
    const shortRoot = join(shortTemp, basename(longRoot))
    expect((await realpath(shortRoot)).toLowerCase()).toBe(longRoot.toLowerCase())

    await generateFixture(await loadSpec(join(SPECS_DIR, 'clean.json')), join(longRoot, 'pc'))
    const long = await makeWorld('clean', undefined, longRoot)
    const short = await makeWorld('clean', undefined, shortRoot)

    // Named in full on one side and by the short name on the other: the two do not match by name.
    const mixed = short.inFolder('Mods', 'New')
    expect(await long.run([{ op: 'mkdir', path: mixed }])).toEqual(
      refusedWith({ reason: 'outside-allowed-area', path: mixed })
    )
    // Everything through the short name: saves is still saves, and Mods is still Mods.
    const save = short.inFolder(...SAVE)
    expect(await short.run([{ op: 'remove', path: save }])).toEqual(refusedWith({ reason: 'saves-or-tray', path: save }))
    expect(await short.run([{ op: 'mkdir', path: short.inFolder('Mods', 'New') }])).toEqual({ status: 'done' })
    expect((await stat(long.inFolder('Mods', 'New'))).isDirectory()).toBe(true)
    // App data named through the short name still leads to its own name below the real app data folder.
    const state = short.inData('state', 'update.json')
    expect(
      await short.run([{ op: 'write', path: state, data: '{}', mode: 'replace' }], { folderPath: null, reason: 'state' })
    ).toEqual({ status: 'done' })
    expect(await readFile(long.inData('state', 'update.json'), 'utf8')).toBe('{}')
    expect(await short.run([{ op: 'remove', path: state }], { folderPath: null, reason: 'state' })).toEqual({
      status: 'done'
    })
    expect(await exists(long.inData('state', 'update.json'))).toBe(false)
  })

  it.runIf(ON_WINDOWS)('letter case on a real disk: MODS is Mods and SAVES is saves', async () => {
    const w = await makeWorld()
    const shouted = join(w.folder.toUpperCase(), 'MODS', 'COZY_RUG.PACKAGE')
    const to = w.inData('holding', 'cozy_rug.package')
    expect(await w.run([{ op: 'move', from: shouted, to }], { folderPath: w.folder.toUpperCase() })).toEqual({
      status: 'done'
    })
    expect(await exists(w.inFolder(...MOD))).toBe(false)
    const save = join(w.folder.toUpperCase(), 'SAVES', 'SLOT_00000002.SAVE')
    expect(await w.run([{ op: 'remove', path: save }])).toEqual(refusedWith({ reason: 'saves-or-tray', path: save }))
  })
})

describe('sortPath, the name check, with Windows paths (runs on any machine)', () => {
  const sims = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'
  const roots: GateRoots = {
    folderPath: sims,
    dataDir: 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper',
    desktopDir: 'C:\\Users\\Lila\\Desktop'
  }
  const sort = (target: string): string => {
    const sorted = sortPath(win32, roots, target)
    return `${sorted.zone}${sorted.atRoot ? ' root' : ''}${sorted.wellFormed ? '' : ' malformed'}`
  }

  it.each([
    [`${sims}\\saves\\Slot_00000001.save`, 'forbidden'],
    [`${sims}\\saves`, 'forbidden'],
    [`${sims}\\Tray`, 'forbidden'],
    [`${sims}\\SAVES\\x`, 'forbidden'],
    [`${sims}\\tray\\x.trayitem`, 'forbidden'],
    ['c:\\users\\lila\\documents\\electronic arts\\the sims 4\\SaVeS\\x', 'forbidden'],
    [`${sims}\\Mods\\..\\saves\\x`, 'forbidden malformed'],
    [`${sims}/Mods/../saves/x`, 'forbidden malformed'],
    ['C:/Users/Lila/Documents/Electronic Arts/The Sims 4/Tray/x', 'forbidden malformed'],
    [`${sims}\\saves.\\x`, 'forbidden malformed'],
    [`${sims}\\saves...\\x`, 'forbidden malformed'],
    [`${sims}\\saves \\x`, 'forbidden malformed'],
    [`${sims}\\saves . .\\x`, 'forbidden malformed'],
    [`${sims}\\Tray.`, 'forbidden malformed'],
    [`${sims}\\saves::$INDEX_ALLOCATION\\x`, 'forbidden malformed'],
    [`${sims}\\saves:stream`, 'forbidden malformed'],
    [`${sims}\\\u017faves\\x`, 'forbidden'],
    [`\\\\?\\${sims}\\saves\\x`, 'forbidden malformed'],
    [`\\\\.\\${sims}\\Tray\\x`, 'forbidden malformed'],
    [`//?/${sims}\\saves\\x`, 'forbidden malformed'],
    [`${sims}\\Mods`, 'mods root'],
    [`${sims}\\Mods\\a.package`, 'mods'],
    [`${sims}\\MODS\\Deep\\Folder\\a.ts4script`, 'mods'],
    [`${sims}\\Mods\\a.package:hidden`, 'mods malformed'],
    [`${sims}\\Mods\\Folder.\\a.package`, 'mods malformed'],
    [`${sims}\\Mods\\a.package `, 'mods malformed'],
    [`${sims}\\Mods\\NUL`, 'mods malformed'],
    [`${sims}\\Mods\\con.package`, 'mods malformed'],
    [`${sims}\\Mods\\NUL .package`, 'mods malformed'],
    [`${sims}\\Mods\\CON   .txt`, 'mods malformed'],
    [`${sims}\\Mods\\COM1`, 'mods malformed'],
    [`${sims}\\Mods\\COM1 .package`, 'mods malformed'],
    [`${sims}\\Mods\\what?.package`, 'mods malformed'],
    [`${sims}\\Mods\\\\a.package`, 'mods malformed'],
    [`${sims}\\Mods\\`, 'mods root malformed'],
    [`\\\\?\\${sims}\\Mods\\a.package`, 'mods malformed'],
    [`${sims}\\Modsx\\a.package`, 'sims-other'],
    [`${sims}\\localthumbcache.package`, 'caches'],
    [`${sims}\\LOCALTHUMBCACHE.PACKAGE`, 'caches'],
    [`${sims}\\houseDescription-client.package`, 'caches'],
    [`${sims}\\cachestr`, 'caches'],
    [`${sims}\\onlinethumbnailcache`, 'caches'],
    [`${sims}\\cachestr\\x.package`, 'sims-other'],
    [`${sims}\\cache`, 'sims-other'],
    [`${sims}\\Options.ini`, 'options'],
    [`${sims}\\options.INI`, 'options'],
    [`${sims}\\Options.ini\\x`, 'sims-other'],
    [`${sims}\\Options.ini.bak`, 'sims-other'],
    [sims, 'sims-other'],
    ['C:\\Users\\Lila\\Documents\\Electronic Arts', 'none'],
    ['C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4x\\Mods\\a.package', 'none'],
    ['C:\\Users\\Lila\\Documents\\Electronic Arts\\Die Sims 4\\saves\\x', 'none'],
    ['C:\\Users\\Lila\\AppData\\Local\\SimsHelper', 'app-data root'],
    ['C:\\Users\\Lila\\AppData\\Local\\SimsHelper\\backups\\b1\\saves\\Slot_00000001.save', 'app-data'],
    ['c:\\users\\lila\\appdata\\local\\simshelper\\journal\\e1.json', 'app-data'],
    ['C:\\Users\\Lila\\AppData\\Local\\SimsHelperX\\x', 'none'],
    ['C:\\Users\\Lila\\AppData\\Local', 'none'],
    ['C:\\Users\\Lila\\Desktop\\Sims Helper report 20261124-131500.zip', 'report'],
    ['C:\\Users\\Lila\\Desktop\\Sims Helper report 20261124-131500.zip:x', 'none malformed'],
    ['C:\\Users\\Lila\\Desktop\\Sims Helper report 20261124-131500.ZIP', 'none'],
    ['C:\\Users\\Lila\\Desktop\\Reports\\Sims Helper report 20261124-131500.zip', 'none'],
    ['C:\\Users\\Lila\\Desktop', 'none'],
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'none'],
    ['C:Mods\\a.package', 'none malformed'],
    ['Mods\\a.package', 'none malformed'],
    ['\\\\server\\share\\The Sims 4\\Mods\\a.package', 'none malformed'],
    ['\\\\localhost\\C$\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\a.package', 'none malformed'],
    ['\\\\?\\UNC\\server\\share\\x', 'none malformed'],
    ['', 'none malformed']
  ])('%s is %s', (target, expected) => {
    expect(sort(target)).toBe(expected)
  })

  it('a path with no drive letter is malformed, whatever the current drive is', () => {
    const rooted = '\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\a.package'
    expect(sortPath(win32, roots, rooted).wellFormed).toBe(false)
  })

  it('with no Sims folder and no Desktop there are no such zones', () => {
    const bare: GateRoots = { folderPath: null, dataDir: roots.dataDir, desktopDir: null }
    expect(sortPath(win32, bare, `${sims}\\Mods\\a.package`).zone).toBe('none')
    expect(sortPath(win32, bare, `${sims}\\saves\\x`).zone).toBe('none')
    expect(sortPath(win32, bare, 'C:\\Users\\Lila\\Desktop\\Sims Helper report 20261124-131500.zip').zone).toBe('none')
    expect(sortPath(win32, bare, `${roots.dataDir}\\x`).zone).toBe('app-data')
  })

  it('reads backslashes as separators on a machine that does not', () => {
    const home: GateRoots = { folderPath: '/home/l/The Sims 4', dataDir: '/home/l/data', desktopDir: null }
    expect(sortPath(posix, home, '/home/l/The Sims 4/Mods\\..\\saves\\x')).toMatchObject({
      zone: 'forbidden',
      wellFormed: false
    })
    expect(sortPath(posix, home, '/home/l/The Sims 4/Mods/a\\b.package')).toMatchObject({ wellFormed: false })
    expect(sortPath(posix, home, '/home/l/The Sims 4/Mods/a.package')).toEqual({
      zone: 'mods',
      atRoot: false,
      wellFormed: true
    })
  })

  it('Unicode Kelvin sign U+212A is not folded into ASCII k on allow checks', () => {
    expect(sortPath(win32, roots, `${sims}\\localthumbcache.pac\u212aage`).zone).toBe('sims-other')
    const kateRoots: GateRoots = {
      folderPath: null,
      dataDir: 'C:\\Users\\Kate\\AppData\\Local\\SimsHelper',
      desktopDir: null
    }
    expect(sortPath(win32, kateRoots, 'C:\\Users\\\u212aate\\AppData\\Local\\SimsHelper\\x').zone).toBe('none')
  })
})
