// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { GameRunState, SaveCopy } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import type { Gate, GateDeps, WriteRequest } from '../ports.ts'
import { runGate } from '../safety/gate.ts'
import { makeSaveCopy, type SaveCopyDeps } from './index.ts'
import { nextSlotName, putBackSave } from './put-back.ts'

const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const SIMS_REL = ['Users', 'Player', 'Documents', 'Electronic Arts', 'The Sims 4']

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

interface World {
  folder: string
  deps: SaveCopyDeps
  game: { state: GameRunState }
  requests: WriteRequest[]
}

async function makeWorld(): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-putback-')))
  roots.push(root)
  await generateFixture(await loadSpec(join(SPECS_DIR, 'p15-save-copies.json')), join(root, 'pc'))
  const folder = join(root, 'pc', ...SIMS_REL)
  await writeFile(join(folder, 'saves', 'Slot_00000005.save'), 'the farm, as it was')
  await writeFile(join(folder, 'saves', 'Slot_00000009.save'), 'the city legacy')
  await writeFile(join(folder, 'saves', 'Slot_00000009.save.ver0'), 'the city legacy, older')
  const player = join(root, 'pc', 'Users', 'Player')
  await mkdir(join(player, 'Desktop'), { recursive: true })
  const paths = appPaths({ localAppData: join(player, 'AppData', 'Local'), desktopDir: join(player, 'Desktop') })
  const game: World['game'] = { state: 'not-running' }
  const gameState = async (): Promise<GameRunState> => game.state
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
  let ids = 0
  const deps: SaveCopyDeps = {
    gate,
    paths,
    clock: { now: () => new Date('2026-11-26T12:00:00.000Z') },
    newId: () => `20261126-120000-${String((ids += 1)).padStart(4, '0')}`,
    gameState,
    freeBytes: async () => 10 * 1024 ** 3
  }
  return { folder, deps, game, requests }
}

async function madeCopy(w: World): Promise<SaveCopy> {
  const made = await makeSaveCopy(w.deps, w.folder, 'by-hand')
  if (made.kind !== 'done') throw new Error(`no copy: ${made.why}`)
  w.requests.length = 0
  return made.copy
}

/** Every file under saves/ and Tray/, with its hash. */
async function snapshot(dir: string, rel = ''): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) for (const [k, v] of await snapshot(dir, child)) found.set(k, v)
    else found.set(child, sha(await readFile(join(dir, child))))
  }
  return found
}

describe('nextSlotName', () => {
  it('is the lowest number above the highest slot in saves/', () => {
    expect(nextSlotName(['Slot_00000002.save', 'Slot_00000009.save', 'Slot_00000009.save.ver0'])).toBe(
      'Slot_0000000a.save'
    )
    expect(nextSlotName(['Slot_0000000a.save.ver4', 'Options.ini', 'scratch'])).toBe('Slot_0000000b.save')
    expect(nextSlotName(['Slot_0000000A.save'])).toBe('Slot_0000000b.save')
    expect(nextSlotName(['Slot_0ffffffe.save'])).toBe('Slot_0fffffff.save')
    expect(nextSlotName(['Slot_0ffffffe.save'])).toBe('Slot_0fffffff.save')
  })

  it('matches Slot_ and .save in any letter case, as Windows does', () => {
    expect(nextSlotName(['SLOT_0000000A.SAVE'])).toBe('Slot_0000000b.save')
    expect(nextSlotName(['slot_0000000c.save.ver0'])).toBe('Slot_0000000d.save')
    expect(nextSlotName(['Slot_00000002.save', 'SLOT_00000010.SAVE.VER1'])).toBe('Slot_00000011.save')
  })

  it('never gives Slot_00000001.save, the old autosave slot the Load menu hides: an empty saves/ starts at 02', () => {
    expect(nextSlotName([])).toBe('Slot_00000002.save')
    expect(nextSlotName(['Slot_00000001.save'])).toBe('Slot_00000002.save')
    expect(nextSlotName(['Options.ini', 'scratch'])).toBe('Slot_00000002.save')
  })

  it('has no free slot above Slot_0fffffff.save', () => {
    expect(nextSlotName(['Slot_0fffffff.save'])).toBeNull()
    expect(nextSlotName(['Slot_10000000.save'])).toBeNull()
    expect(nextSlotName(['Slot_ffffffff.save.ver1'])).toBeNull()
  })
})

describe('putBackSave', () => {
  it('adds the save as a new slot, one above the highest, and changes nothing else', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    const savesBefore = await snapshot(join(w.folder, 'saves'))
    const trayBefore = await snapshot(join(w.folder, 'Tray'))
    const answer = await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')
    expect(answer).toEqual({ kind: 'done', newSlot: 'Slot_0000000a.save' })
    const savesAfter = await snapshot(join(w.folder, 'saves'))
    expect([...savesAfter.keys()].sort()).toEqual([...savesBefore.keys(), 'Slot_0000000a.save'].sort())
    for (const [name, hash] of savesBefore) expect(savesAfter.get(name), name).toBe(hash)
    expect(savesAfter.get('Slot_0000000a.save')).toBe(sha('the farm, as it was'))
    expect(await snapshot(join(w.folder, 'Tray'))).toEqual(trayBefore)
    // one gate request: a single copy op from the copy into saves/, as a save put back
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0]!.reason).toBe('save-put-back')
    expect(w.requests[0]!.ops).toEqual([
      {
        op: 'copy',
        from: join(w.deps.paths.saveCopiesDir, copy.id, 'saves', 'Slot_00000005.save'),
        to: join(w.folder, 'saves', 'Slot_0000000a.save')
      }
    ])
    // a second put back takes the next number
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({
      kind: 'done',
      newSlot: 'Slot_0000000b.save'
    })
  })

  it('copies and puts back a save whose name is in capitals, as Windows may spell it', async () => {
    const w = await makeWorld()
    await writeFile(join(w.folder, 'saves', 'SLOT_00000003.SAVE'), 'the capital save')
    const copy = await madeCopy(w)
    expect(copy.saves.map((s) => s.name)).toContain('SLOT_00000003.SAVE')
    expect(await putBackSave(w.deps, w.folder, copy.id, 'SLOT_00000003.SAVE')).toEqual({
      kind: 'done',
      newSlot: 'Slot_0000000a.save'
    })
    expect(await readFile(join(w.folder, 'saves', 'Slot_0000000a.save'), 'utf8')).toBe('the capital save')
  })

  it('puts a save back into an emptied saves/ as Slot_00000002.save', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    for (const name of await readdir(join(w.folder, 'saves'))) await rm(join(w.folder, 'saves', name), { recursive: true })
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({
      kind: 'done',
      newSlot: 'Slot_00000002.save'
    })
  })

  it('refuses a broken copy, or one whose file no longer matches its hash', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    const copyJson = join(w.deps.paths.saveCopiesDir, copy.id, 'copy.json')
    await rm(copyJson)
    await writeFile(copyJson, JSON.stringify({ ...copy, status: 'broken' }))
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({
      kind: 'refused',
      why: 'copy-broken'
    })
    await rm(copyJson)
    await writeFile(copyJson, JSON.stringify(copy))
    const file = join(w.deps.paths.saveCopiesDir, copy.id, 'saves', 'Slot_00000005.save')
    await rm(file)
    await writeFile(file, 'damaged on disk')
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({
      kind: 'refused',
      why: 'copy-broken'
    })
    expect(w.requests).toEqual([])
  })

  it('answers not-found for an unknown copy or save, and for a name that is not a save in it', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    expect(await putBackSave(w.deps, w.folder, 'nope', 'Slot_00000005.save')).toEqual({
      kind: 'refused',
      why: 'not-found'
    })
    expect(await putBackSave(w.deps, w.folder, '../escape', 'Slot_00000005.save')).toEqual({
      kind: 'refused',
      why: 'not-found'
    })
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000007.save')).toEqual({
      kind: 'refused',
      why: 'not-found'
    })
    expect(await putBackSave(w.deps, w.folder, copy.id, '../copy.json')).toEqual({ kind: 'refused', why: 'not-found' })
    expect(w.requests).toEqual([])
  })

  it.each([
    ['running', 'game-running'],
    ['unknown', 'game-state-unknown']
  ] as const)('refuses while the game is %s, and adds nothing', async (state, why) => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    const before = await snapshot(join(w.folder, 'saves'))
    w.game.state = state
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({ kind: 'refused', why })
    expect(await snapshot(join(w.folder, 'saves'))).toEqual(before)
  })

  it('answers no-free-slot when the highest slot is Slot_0fffffff.save', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    await writeFile(join(w.folder, 'saves', 'Slot_0fffffff.save'), 'the last one')
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({
      kind: 'refused',
      why: 'no-free-slot'
    })
    expect(w.requests).toEqual([])
  })

  it('answers error when the gate fails (a disk without hard links) or refuses, and without a folder', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    w.deps.gate = { run: async () => ({ status: 'failed', opsDone: 0, detail: 'no hard links here' }) }
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({ kind: 'refused', why: 'error' })
    w.deps.gate = { run: async () => ({ status: 'refused', refusal: { reason: 'link-escape', path: 'x' } }) }
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({ kind: 'refused', why: 'error' })
    w.deps.gate = { run: async () => ({ status: 'refused', refusal: { reason: 'game-running' } }) }
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({
      kind: 'refused',
      why: 'game-running'
    })
    expect(await putBackSave(w.deps, null, copy.id, 'Slot_00000005.save')).toEqual({ kind: 'refused', why: 'error' })
  })

  it('reads the new save back: a hash mismatch answers error and leaves the file', async () => {
    const w = await makeWorld()
    const copy = await madeCopy(w)
    const run = w.deps.gate.run
    w.deps.gate = {
      run: async (request) => {
        const result = await run(request)
        await rm(join(w.folder, 'saves', 'Slot_0000000a.save'))
        await writeFile(join(w.folder, 'saves', 'Slot_0000000a.save'), 'not what was copied')
        return result
      }
    }
    expect(await putBackSave(w.deps, w.folder, copy.id, 'Slot_00000005.save')).toEqual({ kind: 'refused', why: 'error' })
    expect(await readFile(join(w.folder, 'saves', 'Slot_0000000a.save'), 'utf8')).toBe('not what was copied')
  })
})
