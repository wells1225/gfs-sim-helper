// @vitest-environment node
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
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { BackupStatus, GameRunState, GateRefusal } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import type { AppPaths, GateDeps, GateResult, WriteOp, WriteRequest } from '../ports.ts'
import { runGate, sortPath } from './gate.ts'
import type { GateRoots } from './gate.ts'

// The gate keeps no test seam. Faults are injected here, under its imports.
const disk = vi.hoisted(() => ({
  crossDrive: null as null | { from: string; hits: number },
  corruptNewFiles: null as null | { hits: number },
  realpathFails: null as null | { under: string; code: string; hits: number },
  unlinkFails: null as null | { file: string; hits: number },
  writeFileQuotesItsData: null as null | { hits: number },
  whenTempOpens: null as null | (() => Promise<void>)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const errno = (code: string, syscall: string): Error =>
    Object.assign(new Error(`${code}: injected fault, ${syscall}`), { code, syscall })
  const mocked = {
    ...real,
    rename: (async (from, to) => {
      if (disk.crossDrive && String(from) === disk.crossDrive.from) {
        disk.crossDrive.hits += 1
        throw errno('EXDEV', 'rename')
      }
      await real.rename(from, to)
    }) as typeof real.rename,
    realpath: (async (target: string) => {
      if (disk.realpathFails && target.startsWith(disk.realpathFails.under)) {
        disk.realpathFails.hits += 1
        throw errno(disk.realpathFails.code, 'realpath')
      }
      return await real.realpath(target)
    }) as unknown as typeof real.realpath,
    unlink: (async (file) => {
      if (disk.unlinkFails && String(file) === disk.unlinkFails.file) {
        disk.unlinkFails.hits += 1
        throw errno('EBUSY', 'unlink')
      }
      await real.unlink(file)
    }) as typeof real.unlink,
    open: (async (file, flags, mode) => {
      const handle = await real.open(file, flags, mode)
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
  disk.unlinkFails = null
  disk.writeFileQuotesItsData = null
  disk.whenTempOpens = null
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

  it('refuses a folder with Options.ini whose name is not a Sims folder name', async () => {
    const w = await makeWorld()
    const fake = join(w.root, 'pc', 'Windows')
    await mkdir(join(fake, 'Mods'), { recursive: true })
    await writeFile(join(fake, 'Options.ini'), 'modsdisabled = 0\n')
    await expectRefusal(w, () => w.run([{ op: 'mkdir', path: join(fake, 'Mods', 'New') }], { folderPath: fake }), {
      reason: 'not-a-sims-folder',
      path: fake
    })
  })

  it('refuses a Sims-named folder link whose real target is not a Sims folder', async () => {
    const w = await makeWorld()
    const realTarget = join(w.root, 'pc', 'NotASimsFolder')
    await mkdir(join(realTarget, 'Mods'), { recursive: true })
    await writeFile(join(realTarget, 'Options.ini'), 'modsdisabled = 0\n')
    const linkParent = join(w.root, 'pc', 'Alias')
    await mkdir(linkParent, { recursive: true })
    const fakeSimsLink = join(linkParent, 'The Sims 4')
    await linkFolder(realTarget, fakeSimsLink)
    await expectRefusal(
      w,
      () => w.run([{ op: 'mkdir', path: join(fakeSimsLink, 'Mods', 'New') }], { folderPath: fakeSimsLink }),
      { reason: 'not-a-sims-folder', path: fakeSimsLink }
    )
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
    const from = w.inFolder(...MOD)
    const to = w.inData('backups', 'b1', 'Mods', 'cozy_rug.package')
    const before = await snapshotTree(w.folder)
    expect(await w.run([{ op: 'copy', from, to }], { reason: 'backup' })).toEqual({ status: 'done' })
    expect(await sha256(to)).toBe(await sha256(from))
    expect(Math.abs((await stat(to)).mtimeMs - (await stat(from)).mtimeMs)).toBeLessThan(2)
    expect(await snapshotTree(w.folder)).toEqual(before)
    expect(await readdir(dirname(to))).toEqual(['cozy_rug.package'])
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
      refusedWith({ reason: 'outside-allowed-area', path: target })
    )
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
    expect(await w.run([{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null })).toEqual({ status: 'done' })
    w.paths.desktopDir = 'Desktop'
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

  it('an empty request is done', async () => {
    const w = await makeWorld()
    expect(await w.run([])).toEqual({ status: 'done' })
    expect(w.asked).toEqual([])
  })
})

describe('fail closed: an error while checking refuses', () => {
  it('a real path that cannot be read refuses with link-escape', async () => {
    const w = await makeWorld()
    const from = w.inFolder(...MOD)
    disk.realpathFails = { under: w.inFolder('Mods'), code: 'EACCES', hits: 0 }
    const before = await snapshotTree(w.root)
    expect(await w.run([{ op: 'move', from, to: w.inData('holding', 'x.package') }])).toEqual(
      refusedWith({ reason: 'link-escape', path: from })
    )
    expect(disk.realpathFails.hits, 'the injected error was really hit').toBeGreaterThan(0)
    expect(await snapshotTree(w.root)).toEqual(before)
  })

  it('a Sims folder whose real path cannot be read refuses with not-a-sims-folder', async () => {
    const w = await makeWorld()
    disk.realpathFails = { under: w.folder, code: 'EIO', hits: 0 }
    expect(await w.run([{ op: 'mkdir', path: w.inData('journal') }])).toEqual(
      refusedWith({ reason: 'not-a-sims-folder', path: w.folder })
    )
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
  })

  it('an app data folder whose real path cannot be read refuses everything', async () => {
    const w = await makeWorld()
    disk.realpathFails = { under: dirname(w.dataDir), code: 'EPERM', hits: 0 }
    expect(await w.run([{ op: 'mkdir', path: w.inData('journal') }], { folderPath: null })).toEqual(
      refusedWith({ reason: 'outside-allowed-area', path: w.dataDir })
    )
    expect(disk.realpathFails.hits).toBeGreaterThan(0)
  })

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
    const result = await runGate(null as unknown as GateDeps, { reason: 'fix', folderPath: null, ops: [] })
    expect(result).toMatchObject({ status: 'refused', refusal: { reason: 'outside-allowed-area' } })
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
})
