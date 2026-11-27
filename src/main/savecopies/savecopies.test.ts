// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { GameRunState, SaveCopy } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import type { Gate, GateDeps, WriteRequest } from '../ports.ts'
import { runGate } from '../safety/gate.ts'
import { copiesToKeep } from './keep.ts'
import { copyBeforeChange, listSaveCopies, makeSaveCopy, type SaveCopyDeps } from './index.ts'

const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const SIMS_REL = ['Users', 'Player', 'Documents', 'Electronic Arts', 'The Sims 4']

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

interface World {
  folder: string
  deps: SaveCopyDeps
  game: { state: GameRunState | 'throws' }
  requests: WriteRequest[]
  free: { bytes: number }
  now: { at: Date }
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** The p15 fixture, with three slots (each with .ver files) and a Tray that has a subfolder. */
async function makeWorld(): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-savecopies-')))
  roots.push(root)
  await generateFixture(await loadSpec(join(SPECS_DIR, 'p15-save-copies.json')), join(root, 'pc'))
  const folder = join(root, 'pc', ...SIMS_REL)
  for (const slot of ['00000005', '00000009']) {
    await writeFile(join(folder, 'saves', `Slot_${slot}.save`), `a saved game ${slot}`)
    await writeFile(join(folder, 'saves', `Slot_${slot}.save.ver0`), `older ${slot}`)
  }
  await mkdir(join(folder, 'saves', 'scratch'), { recursive: true })
  await writeFile(join(folder, 'saves', 'scratch', 'Slot_00000003.save'), 'scratch')
  await mkdir(join(folder, 'Tray', 'Old'), { recursive: true })
  await writeFile(join(folder, 'Tray', 'Old', '0x1!0x2.trayitem'), 'an old household')
  const player = join(root, 'pc', 'Users', 'Player')
  await mkdir(join(player, 'Desktop'), { recursive: true })
  const paths = appPaths({ localAppData: join(player, 'AppData', 'Local'), desktopDir: join(player, 'Desktop') })
  const game: World['game'] = { state: 'not-running' }
  const gameState = async (): Promise<GameRunState> => {
    if (game.state === 'throws') throw new Error('no process list')
    return game.state
  }
  const gateDeps: GateDeps = {
    paths,
    gameState,
    backupStatus: async () => ({ state: 'none' }),
    shareRoot: async () => null,
    modFolderRoot: () => null
  }
  const requests: WriteRequest[] = []
  const gate: Gate = {
    run: (request) => {
      requests.push(request)
      return runGate(gateDeps, request)
    }
  }
  const free = { bytes: 10 * 1024 ** 3 }
  const now = { at: new Date('2026-11-26T12:00:00.000Z') }
  let ids = 0
  const deps: SaveCopyDeps = {
    gate,
    paths,
    clock: { now: () => now.at },
    newId: () => `20261126-120000-${String((ids += 1)).padStart(4, '0')}`,
    gameState,
    freeBytes: async () => free.bytes
  }
  return { folder, deps, game, requests, free, now }
}

async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const found: string[] = []
  let entries
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, child)))
    else found.push(child)
  }
  return found.sort()
}

describe('makeSaveCopy', () => {
  it('copies every Slot_*.save and all of Tray, with matching hashes, and no .ver or scratch file', async () => {
    const w = await makeWorld()
    const made = await makeSaveCopy(w.deps, w.folder, 'by-hand')
    expect(made.kind).toBe('done')
    if (made.kind !== 'done') return
    const { copy } = made
    expect(copy.status).toBe('checked')
    expect(copy.reason).toBe('by-hand')
    expect(copy.gameVersion).toBe('1.130.12.1020')
    expect(copy.at).toBe('2026-11-26T12:00:00.000Z')
    expect(copy.saves.map((s) => s.name)).toEqual(['Slot_00000002.save', 'Slot_00000005.save', 'Slot_00000009.save'])
    const copyDir = join(w.deps.paths.saveCopiesDir, copy.id)
    expect(await filesUnder(join(copyDir, 'saves'))).toEqual([
      'Slot_00000002.save',
      'Slot_00000005.save',
      'Slot_00000009.save'
    ])
    const trayHers = await filesUnder(join(w.folder, 'Tray'))
    expect(await filesUnder(join(copyDir, 'Tray'))).toEqual(trayHers)
    expect(copy.trayFiles).toBe(trayHers.length)
    for (const save of copy.saves) {
      const hers = await readFile(join(w.folder, 'saves', save.name))
      expect(save.sha256).toBe(sha(hers))
      expect(save.bytes).toBe(hers.byteLength)
      expect(sha(await readFile(join(copyDir, 'saves', save.name)))).toBe(save.sha256)
      expect(save.savedAt).toBe((await stat(join(w.folder, 'saves', save.name))).mtime.toISOString())
    }
    // copy.json is written last and lists it
    expect(JSON.parse(await readFile(join(copyDir, 'copy.json'), 'utf8'))).toEqual(copy)
    expect(await listSaveCopies(w.deps.paths)).toEqual([copy])
    // every write went through the gate as a save copy, and no op touched saves/ or Tray/ as a target
    for (const request of w.requests) {
      expect(request.reason).toBe('save-copy')
      for (const op of request.ops) {
        const target = 'path' in op ? op.path : op.to
        expect(target.startsWith(w.deps.paths.saveCopiesDir)).toBe(true)
      }
    }
  })

  it.each([
    ['running', 'game-running'],
    ['unknown', 'game-state-unknown'],
    ['throws', 'game-state-unknown']
  ] as const)('refuses while the game state is %s, and writes nothing', async (state, why) => {
    const w = await makeWorld()
    w.game.state = state
    expect(await makeSaveCopy(w.deps, w.folder, 'by-hand')).toEqual({ kind: 'refused', why })
    expect(w.requests).toEqual([])
    expect(await filesUnder(w.deps.paths.saveCopiesDir)).toEqual([])
  })

  it('refuses no-folder without a Sims folder', async () => {
    const w = await makeWorld()
    expect(await makeSaveCopy(w.deps, null, 'by-hand')).toEqual({ kind: 'refused', why: 'no-folder' })
    expect(await makeSaveCopy(w.deps, join(w.folder, 'nope'), 'by-hand')).toEqual({ kind: 'refused', why: 'no-folder' })
    expect(w.requests).toEqual([])
  })

  it('refuses disk-full unless free space is at least twice the copy size', async () => {
    const w = await makeWorld()
    let total = 0
    for (const name of ['Slot_00000002.save', 'Slot_00000005.save', 'Slot_00000009.save']) {
      total += (await stat(join(w.folder, 'saves', name))).size
    }
    for (const rel of await filesUnder(join(w.folder, 'Tray'))) total += (await stat(join(w.folder, 'Tray', rel))).size
    w.free.bytes = total * 2 - 1
    expect(await makeSaveCopy(w.deps, w.folder, 'by-hand')).toEqual({ kind: 'refused', why: 'disk-full' })
    expect(w.requests).toEqual([])
    w.free.bytes = total * 2
    expect((await makeSaveCopy(w.deps, w.folder, 'by-hand')).kind).toBe('done')
  })

  it('marks the copy broken when a save changes while it is copied, and still lists it', async () => {
    const w = await makeWorld()
    const run = w.deps.gate.run
    w.deps.gate = {
      run: async (request) => {
        if (request.ops.some((op) => op.op === 'copy')) {
          await writeFile(join(w.folder, 'saves', 'Slot_00000005.save'), 'the game wrote this mid-copy')
        }
        return await run(request)
      }
    }
    const made = await makeSaveCopy(w.deps, w.folder, 'by-hand')
    expect(made.kind).toBe('done')
    if (made.kind !== 'done') return
    expect(made.copy.status).toBe('broken')
    expect((await listSaveCopies(w.deps.paths)).map((c) => c.status)).toEqual(['broken'])
  })

  it('a refused gate request leaves no copy behind and answers error', async () => {
    const w = await makeWorld()
    w.deps.gate = {
      run: async () => ({ status: 'refused', refusal: { reason: 'check-failed', path: '' } })
    }
    expect(await makeSaveCopy(w.deps, w.folder, 'by-hand')).toEqual({ kind: 'refused', why: 'error' })
    expect(await listSaveCopies(w.deps.paths)).toEqual([])
  })

  it('removes copies the keep rule drops, only after the new copy is checked', async () => {
    const w = await makeWorld()
    for (let i = 0; i < 11; i += 1) {
      w.now.at = new Date(Date.UTC(2026, 10, 1 + i, 12))
      expect((await makeSaveCopy(w.deps, w.folder, 'by-hand')).kind).toBe('done')
    }
    const left = await listSaveCopies(w.deps.paths)
    // 10 newest, plus the oldest copy of this game version
    expect(left).toHaveLength(11)
    w.now.at = new Date(Date.UTC(2026, 10, 20, 12))
    await makeSaveCopy(w.deps, w.folder, 'by-hand')
    const after = await listSaveCopies(w.deps.paths)
    expect(after).toHaveLength(11)
    expect(after.map((c) => c.at)).toContain(new Date(Date.UTC(2026, 10, 1, 12)).toISOString())
    expect(after.map((c) => c.at)).not.toContain(new Date(Date.UTC(2026, 10, 2, 12)).toISOString())
    expect(await readdir(w.deps.paths.saveCopiesDir)).toHaveLength(11)
  })
})

describe('listSaveCopies', () => {
  it('lists newest first and skips a folder without copy.json or with a bad one', async () => {
    const w = await makeWorld()
    w.now.at = new Date('2026-11-20T10:00:00.000Z')
    const first = await makeSaveCopy(w.deps, w.folder, 'by-hand')
    w.now.at = new Date('2026-11-21T10:00:00.000Z')
    const second = await makeSaveCopy(w.deps, w.folder, 'game-updated')
    await mkdir(join(w.deps.paths.saveCopiesDir, 'half-made', 'saves'), { recursive: true })
    await mkdir(join(w.deps.paths.saveCopiesDir, 'bad-json'), { recursive: true })
    await writeFile(join(w.deps.paths.saveCopiesDir, 'bad-json', 'copy.json'), '{ nope')
    const list = await listSaveCopies(w.deps.paths)
    expect(list.map((c) => c.id)).toEqual([
      second.kind === 'done' ? second.copy.id : '',
      first.kind === 'done' ? first.copy.id : ''
    ])
  })

  it('answers an empty list when there is no save-copies folder yet', async () => {
    const w = await makeWorld()
    expect(await listSaveCopies(w.deps.paths)).toEqual([])
  })
})

function copyAt(id: string, at: string, gameVersion: string | null, status: SaveCopy['status'] = 'checked'): SaveCopy {
  return { id, at, reason: 'by-hand', gameVersion, saves: [], trayFiles: 0, bytes: 0, status }
}

describe('copiesToKeep', () => {
  it('keeps the newest 10, plus the oldest copy of each of the last 3 game versions', () => {
    // 15 copies across 4 versions, one a day
    const versions = ['1.100.1.1', '1.101.1.1', '1.102.1.1', '1.110.1.1']
    const copies: SaveCopy[] = []
    for (let i = 0; i < 15; i += 1) {
      const version = versions[Math.min(3, Math.floor(i / 4))]!
      copies.push(copyAt(`c${String(i).padStart(2, '0')}`, new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), version))
    }
    // c00-c03: 1.100, c04-c07: 1.101, c08-c11: 1.102, c12-c14: 1.110
    const keep = copiesToKeep(copies)
    expect([...keep].sort()).toEqual(['c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11', 'c12', 'c13', 'c14'])
  })

  it('keeps the oldest checked copy of a version even when older than the newest 10, and never one of an older version', () => {
    const copies: SaveCopy[] = [
      copyAt('old-a', '2026-01-01T00:00:00.000Z', '1.9.0.0'),
      copyAt('v1-broken', '2026-02-01T00:00:00.000Z', '1.10.0.0', 'broken'),
      copyAt('v1-first', '2026-02-02T00:00:00.000Z', '1.10.0.0'),
      copyAt('v2-first', '2026-03-01T00:00:00.000Z', '1.11.0.0'),
      copyAt('v3-first', '2026-04-01T00:00:00.000Z', '1.12.0.0')
    ]
    for (let i = 0; i < 10; i += 1) {
      copies.push(copyAt(`n${i}`, new Date(Date.UTC(2026, 5, 1 + i)).toISOString(), '1.12.0.0'))
    }
    const keep = copiesToKeep(copies)
    expect(keep.has('v1-first')).toBe(true)
    expect(keep.has('v2-first')).toBe(true)
    expect(keep.has('v3-first')).toBe(true)
    expect(keep.has('v1-broken')).toBe(false)
    expect(keep.has('old-a')).toBe(false)
    expect(keep.size).toBe(13)
  })
})

describe('copyBeforeChange', () => {
  it('makes a before-change copy at most once a day, and never throws', async () => {
    const w = await makeWorld()
    await copyBeforeChange(w.deps, w.folder)
    await copyBeforeChange(w.deps, w.folder)
    let list = await listSaveCopies(w.deps.paths)
    expect(list.map((c) => c.reason)).toEqual(['before-change'])
    w.now.at = new Date(w.now.at.getTime() + 25 * 3600_000)
    await copyBeforeChange(w.deps, w.folder)
    list = await listSaveCopies(w.deps.paths)
    expect(list.map((c) => c.reason)).toEqual(['before-change', 'before-change'])
  })

  it('a by-hand copy today does not count, and a refused copy is tried again next time', async () => {
    const w = await makeWorld()
    await makeSaveCopy(w.deps, w.folder, 'by-hand')
    w.game.state = 'running'
    await copyBeforeChange(w.deps, w.folder)
    expect((await listSaveCopies(w.deps.paths)).map((c) => c.reason)).toEqual(['by-hand'])
    w.game.state = 'not-running'
    w.now.at = new Date(w.now.at.getTime() + 60_000)
    await copyBeforeChange(w.deps, w.folder)
    expect((await listSaveCopies(w.deps.paths)).map((c) => c.reason)).toEqual(['before-change', 'by-hand'])
  })

  it('swallows every failure', async () => {
    const w = await makeWorld()
    w.deps.gate = {
      run: async () => {
        throw new Error('boom')
      }
    }
    await expect(copyBeforeChange(w.deps, w.folder)).resolves.toBeUndefined()
    await expect(copyBeforeChange(w.deps, null)).resolves.toBeUndefined()
    w.deps.freeBytes = async () => {
      throw new Error('no statfs')
    }
    await expect(copyBeforeChange(w.deps, w.folder)).resolves.toBeUndefined()
  })
})

