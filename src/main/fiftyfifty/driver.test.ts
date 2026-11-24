// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  DisabledGroup,
  FiftyFifty,
  FixOutcome,
  FixRefusal,
  JournalEntry,
  JournalOrigin,
  ModGroup,
  Scan
} from '../../shared/model.ts'
import { sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import type { Host } from '../locate/host.ts'
import type { AppPaths, Fixes, Gate, GateResult, GroupsOutcome, Safety, WriteRequest } from '../ports.ts'
import {
  beginRound,
  finish,
  getState,
  giveAnswer,
  loadState,
  start,
  stop,
  type FiftyDeps
} from './index.ts'
import { readSaved } from './store.ts'
import { makeGroups } from './testing.ts'

const FOLDER = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'
const GAME_RUNNING: FixRefusal = { why: 'gate', refusal: { reason: 'game-running' } }

/** The fake's "disk": which groups sit in the holding folder. */
class FakeFixes implements Fixes {
  aside = new Map<string, DisabledGroup>()
  calls: { method: string; ids: string[]; origin?: JournalOrigin }[] = []
  /** Queued answers for the next setAside / putBack / clearCaches calls. */
  refuseNext: FixRefusal | null = null
  partWayAfter: number | null = null
  /** The next setAside throws once this many groups are set aside, as runAction can on a later group. */
  throwAfter: number | null = null
  cacheOutcome: FixOutcome | null = null
  /** What safety.listJournal answers; null makes it throw. */
  journal: JournalEntry[] | null = []
  private n = 0

  async apply(): Promise<FixOutcome> {
    throw new Error('the 50/50 test never calls apply')
  }

  private takeRefusal(): GroupsOutcome | null {
    const refusal = this.refuseNext
    if (!refusal) return null
    this.refuseNext = null
    return { status: 'refused', refusal }
  }

  async setAside(folderPath: string, groups: ModGroup[], origin: JournalOrigin): Promise<GroupsOutcome> {
    expect(folderPath).toBe(FOLDER)
    this.calls.push({ method: 'setAside', ids: groups.map((g) => g.id), origin })
    const refused = this.takeRefusal()
    if (refused) return refused
    const entries = []
    for (const [i, g] of groups.entries()) {
      if (this.partWayAfter === i) {
        this.partWayAfter = null
        return { status: 'stopped-part-way', entries, detail: 'disk hiccup' }
      }
      if (this.throwAfter === i) {
        this.throwAfter = null
        throw new Error('runAction blew up')
      }
      if (this.aside.has(g.id)) throw new Error(`setAside twice: ${g.id}`)
      const entryId = `e${++this.n}`
      this.aside.set(g.id, { groupId: g.id, label: g.label, entryId, at: '2026-11-24T12:00:00.000Z', origin: origin.by })
      entries.push(sampleJournalEntry({ id: entryId, groupId: g.id, origin }))
    }
    return { status: 'done', entries }
  }

  async putBack(folderPath: string, groupIds: string[]): Promise<GroupsOutcome> {
    expect(folderPath).toBe(FOLDER)
    this.calls.push({ method: 'putBack', ids: [...groupIds] })
    const refused = this.takeRefusal()
    if (refused) return refused
    const entries = []
    for (const [i, id] of groupIds.entries()) {
      if (this.partWayAfter === i) {
        this.partWayAfter = null
        return { status: 'stopped-part-way', entries, detail: 'disk hiccup' }
      }
      if (!this.aside.delete(id)) throw new Error(`putBack of a group not aside: ${id}`)
      entries.push(sampleJournalEntry({ groupId: id }))
    }
    return { status: 'done', entries }
  }

  async clearCaches(folderPath: string): Promise<FixOutcome> {
    expect(folderPath).toBe(FOLDER)
    this.calls.push({ method: 'clearCaches', ids: [] })
    const outcome = this.cacheOutcome
    this.cacheOutcome = null
    return outcome ?? { status: 'done', entry: sampleJournalEntry({ action: 'clear-caches' }) }
  }

  async disabledGroups(folderPath: string): Promise<DisabledGroup[]> {
    expect(folderPath).toBe(FOLDER)
    return [...this.aside.values()]
  }

  asideIds(): string[] {
    return [...this.aside.keys()].sort()
  }

  moves(): number {
    return this.calls.filter((c) => c.method !== 'clearCaches').length
  }
}

/** A gate matching contracts.md section 5 in a temp folder: mkdir creates parents and succeeds if present; remove of a missing path is done. */
class FakeGate implements Gate {
  requests: WriteRequest[] = []
  next: GateResult | null = null

  async run(request: WriteRequest): Promise<GateResult> {
    this.requests.push(request)
    const forced = this.next
    this.next = null
    if (forced) return forced
    for (const op of request.ops) {
      if (op.op === 'mkdir') await mkdir(op.path, { recursive: true })
      else if (op.op === 'write') await writeFile(op.path, op.data)
      else if (op.op === 'remove') await rm(op.path, { force: true })
      else throw new Error(`unexpected op ${op.op}`)
    }
    return { status: 'done' }
  }

  stateWrites(): number {
    return this.requests.filter((r) => r.ops.some((o) => o.op === 'write')).length
  }
}

let tmp: string
let paths: AppPaths
let fixes: FakeFixes
let gate: FakeGate
let processes: string[] | Error

function makeDeps(): FiftyDeps {
  const host: Host = {
    documentsDir: tmp,
    env: {},
    readRegistry: async () => undefined,
    listProcesses: async () => {
      if (processes instanceof Error) throw processes
      return processes
    },
    fileVersion: async () => undefined
  }
  let ids = 0
  const safety = {
    listJournal: async () => {
      if (!fixes.journal) throw new Error('journal unreadable')
      return fixes.journal
    }
  } as unknown as Safety
  return {
    fixes,
    safety,
    gate,
    paths,
    host,
    clock: { now: () => new Date('2026-11-24T12:10:00.000Z') },
    newId: () => `20261124-121000-${String(++ids).padStart(4, '0')}`
  }
}

function scanWith(groups: ModGroup[]): Scan {
  const base = sampleScan()
  return { ...base, folder: { ...base.folder, path: FOLDER }, inventory: { ...base.inventory, groups } }
}

function stateOf(result: { status: string; state?: FiftyFifty | null }): FiftyFifty {
  expect(result.status).toBe('ok')
  if (!result.state) throw new Error('no state')
  return result.state
}

async function stateFileExists(): Promise<boolean> {
  try {
    await stat(join(paths.stateDir, 'fiftyfifty.json'))
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fifty-'))
  const dataDir = join(tmp, 'SimsHelper')
  paths = {
    dataDir,
    backupsDir: join(dataDir, 'backups'),
    holdingDir: join(dataDir, 'holding'),
    journalDir: join(dataDir, 'journal'),
    stateDir: join(dataDir, 'state'),
    keyFile: join(dataDir, 'assist', 'key.bin'),
    desktopDir: join(tmp, 'Desktop'),
    oneDriveRoots: [],
    curseForgeInstanceFile: null
  }
  fixes = new FakeFixes()
  gate = new FakeGate()
  processes = ['explorer.exe', 'Overwolf.exe']
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Plays a whole session: it crashes whenever the bad group is still in Mods. */
async function playToFound(deps: FiftyDeps, badId: string): Promise<FiftyFifty> {
  let state = stateOf(await beginRound(deps))
  for (let guard = 0; state.phase !== 'found'; guard++) {
    if (guard > 20) throw new Error('did not end')
    expect(state.phase).toBe('awaiting-answer')
    expect(fixes.asideIds()).toEqual([...state.parked].sort())
    state = stateOf(await giveAnswer(deps, fixes.aside.has(badId) ? 'worked' : 'crashed'))
  }
  return state
}

describe('start', () => {
  it('refuses without a scan or without a group', async () => {
    const deps = makeDeps()
    expect(await start(deps, null)).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'no-scan' }
    })
    expect(await start(deps, scanWith([]))).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
    expect(gate.requests).toEqual([])
    expect(await loadState(deps)).toBeNull()
  })

  it('saves the scanned groups through the gate and waits for CurseForge to close', async () => {
    const deps = makeDeps()
    const groups = makeGroups(8)
    const state = stateOf(await start(deps, scanWith(groups)))
    expect(state.phase).toBe('close-curseforge')
    expect(state.folderPath).toBe(FOLDER)
    expect(state.groups).toEqual(groups)
    expect(state.startedAt).toBe('2026-11-24T12:10:00.000Z')
    expect(fixes.calls).toEqual([])

    const [req] = gate.requests
    expect(req).toMatchObject({ reason: 'state', folderPath: null })
    const write = req!.ops.find((o) => o.op === 'write')
    expect(write).toMatchObject({ path: join(paths.stateDir, 'fiftyfifty.json'), mode: 'replace' })
    expect(JSON.parse(await readFile(join(paths.stateDir, 'fiftyfifty.json'), 'utf8'))).toEqual(state)
    expect(await loadState(deps)).toEqual(state)
  })

  it('returns the session already running instead of starting another', async () => {
    const deps = makeDeps()
    const first = stateOf(await start(deps, scanWith(makeGroups(8))))
    const again = stateOf(await start(deps, scanWith(makeGroups(3))))
    expect(again).toEqual(first)
  })
})

describe('a full session', () => {
  it('names the bad group of 64 in 7 rounds (control round + 6 splits) and put-back leaves nothing aside', async () => {
    const deps = makeDeps()
    const groups = makeGroups(64, 9)
    await start(deps, scanWith(groups))
    const found = await playToFound(deps, 'dir:g41')
    expect(found.culprit).toBe('dir:g41')
    expect(found.history).toHaveLength(7)
    expect(found.history[0]?.round).toBe(0)
    expect(found.history[0]?.parked).toHaveLength(64)
    expect(fixes.asideIds()).toEqual(['dir:g41'])
    expect(fixes.calls.filter((c) => c.method === 'clearCaches')).toHaveLength(8)
    for (const call of fixes.calls.filter((c) => c.method === 'setAside')) {
      expect(call.origin).toMatchObject({ by: 'fifty-fifty', sessionId: found.id })
    }

    const done = stateOf(await finish(deps, 'put-back'))
    expect(done.phase).toBe('stopped')
    expect(fixes.asideIds()).toEqual([])
    expect(await stateFileExists()).toBe(false)
    expect(await loadState(deps)).toBeNull()
  })

  it('stops and puts every group back when control round 0 still crashes with all mods aside', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(6)))
    const r0 = stateOf(await beginRound(deps))
    expect(r0.round).toBe(0)
    expect(fixes.asideIds()).toHaveLength(6)

    const stopped = stateOf(await giveAnswer(deps, 'crashed'))
    expect(stopped.phase).toBe('stopped')
    expect(stopped.culprit).toBeNull()
    expect(stopped.history).toEqual([{ round: 0, parked: r0.parked, answer: 'crashed' }])
    expect(fixes.asideIds()).toEqual([])
    expect(await stateFileExists()).toBe(false)
    expect(await loadState(deps)).toBeNull()
  })

  it('keeps the session if putting mods back after a crashed control round is refused or stops part-way', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(4)))
    await beginRound(deps)
    fixes.refuseNext = GAME_RUNNING
    expect(await giveAnswer(deps, 'crashed')).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toMatchObject({ round: 0, phase: 'awaiting-answer' })
    expect(fixes.asideIds()).toHaveLength(4)

    fixes.partWayAfter = 2
    expect(await giveAnswer(deps, 'crashed')).toMatchObject({ status: 'stopped-part-way' })
    expect(await loadState(deps)).toMatchObject({ round: 0, phase: 'awaiting-answer' })

    const stopped = stateOf(await giveAnswer(deps, 'crashed'))
    expect(stopped.phase).toBe('stopped')
    expect(fixes.asideIds()).toEqual([])
    expect(await loadState(deps)).toBeNull()
  })

  it('keep-set-aside leaves exactly the culprit aside', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(13, 4)))
    await playToFound(deps, 'dir:g5')
    const done = stateOf(await finish(deps, 'keep-set-aside'))
    expect(fixes.asideIds()).toEqual(['dir:g5'])
    expect(done.parked).toEqual(['dir:g5'])
    expect(await loadState(deps)).toBeNull()
  })

  it('arranges right away when found: puts other groups back and leaves only the culprit aside', async () => {
    for (const keep of ['put-back', 'keep-set-aside'] as const) {
      fixes = new FakeFixes()
      const deps = makeDeps()
      await stop(deps)
      await start(deps, scanWith(makeGroups(2)))
      await beginRound(deps)
      expect(fixes.asideIds()).toEqual(['dir:g0', 'dir:g1'])
      await giveAnswer(deps, 'worked')
      expect(fixes.asideIds()).toEqual(['dir:g0'])
      const found = stateOf(await giveAnswer(deps, 'crashed'))
      expect(found).toMatchObject({ phase: 'found', culprit: 'dir:g1' })
      expect(fixes.asideIds()).toEqual(['dir:g1'])

      const movesBeforeFinish = fixes.moves()
      await finish(deps, keep)
      expect(fixes.asideIds()).toEqual(keep === 'put-back' ? [] : ['dir:g1'])
      if (keep === 'keep-set-aside') expect(fixes.moves()).toBe(movesBeforeFinish)
    }
  })

  it('if arranging the culprit at found is refused or blocked by CurseForge, stays before found until beginRound finishes it', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(2)))
    await beginRound(deps)
    await giveAnswer(deps, 'worked')

    fixes.refuseNext = GAME_RUNNING
    expect(await giveAnswer(deps, 'crashed')).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toMatchObject({ phase: 'ready-to-test', culprit: 'dir:g1', parked: ['dir:g1'] })
    expect(fixes.asideIds()).toEqual(['dir:g0'])

    processes = ['CurseForge.exe']
    expect(stateOf(await beginRound(deps))).toMatchObject({ phase: 'close-curseforge', culprit: 'dir:g1' })
    expect(fixes.asideIds()).toEqual(['dir:g0'])

    processes = ['explorer.exe']
    const found = stateOf(await beginRound(deps))
    expect(found).toMatchObject({ phase: 'found', culprit: 'dir:g1' })
    expect(fixes.asideIds()).toEqual(['dir:g1'])
  })

  it('with one group, control round 0 tests it out: worked names it, crashed puts it back', async () => {
    const deps = makeDeps()
    const started = stateOf(await start(deps, scanWith(makeGroups(1))))
    expect(started).toMatchObject({ phase: 'close-curseforge', round: 0, culprit: null })
    await beginRound(deps)
    expect(fixes.asideIds()).toEqual(['dir:g0'])
    const found = stateOf(await giveAnswer(deps, 'worked'))
    expect(found).toMatchObject({ phase: 'found', culprit: 'dir:g0' })
    await finish(deps, 'keep-set-aside')
    expect(fixes.asideIds()).toEqual(['dir:g0'])

    fixes = new FakeFixes()
    const deps2 = makeDeps()
    await start(deps2, scanWith(makeGroups(1)))
    await beginRound(deps2)
    const stopped = stateOf(await giveAnswer(deps2, 'crashed'))
    expect(stopped).toMatchObject({ phase: 'stopped', culprit: null })
    expect(fixes.asideIds()).toEqual([])
  })

  it('not-sure runs the same round again without moving anything', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    const r0 = stateOf(await beginRound(deps))
    const movesBefore = fixes.moves()
    const again = stateOf(await giveAnswer(deps, 'not-sure'))
    expect(again.round).toBe(0)
    expect(again.phase).toBe('awaiting-answer')
    expect(again.parked).toEqual(r0.parked)
    expect(fixes.moves()).toBe(movesBefore)
    expect(fixes.calls.at(-1)?.method).toBe('clearCaches')
  })

  it('saves the state after every step', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(4)))
    expect(gate.stateWrites()).toBe(1)
    await beginRound(deps) // ready-to-test, then awaiting-answer
    expect(gate.stateWrites()).toBe(3)
    await giveAnswer(deps, 'worked') // the answer, then ready-to-test is kept, then awaiting-answer
    expect(gate.stateWrites()).toBeGreaterThanOrEqual(5)
    for (const r of gate.requests) expect(r).toMatchObject({ reason: 'state', folderPath: null })
  })

  it('leaves groups she set aside before the test alone', async () => {
    fixes.aside.set('dir:old', { groupId: 'dir:old', label: 'Old', entryId: 'e0', at: '2026-11-01T00:00:00.000Z', origin: 'fix' })
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(4)))
    await beginRound(deps)
    await stop(deps)
    expect(fixes.asideIds()).toEqual(['dir:old'])
  })
  it('never puts back a group of the test that she set aside herself', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    await beginRound(deps)
    const r1 = stateOf(await giveAnswer(deps, 'worked', 0))
    const hers = r1.inMods[0]!
    fixes.aside.set(hers, { groupId: hers, label: 'Hers', entryId: 'e-hers', at: '2026-11-24T12:05:00.000Z', origin: 'fix' })
    await stop(deps)
    expect(fixes.asideIds()).toEqual([hers])
  })

  it('leaves out a scanned group that is already set aside, so the test never puts it back', async () => {
    const groups = makeGroups(5)
    fixes.aside.set('dir:g2', { groupId: 'dir:g2', label: 'Group 002', entryId: 'e0', at: '2026-11-01T00:00:00.000Z', origin: 'fix' })
    const deps = makeDeps()
    const state = stateOf(await start(deps, scanWith(groups)))
    expect(state.groups.map((g) => g.id)).not.toContain('dir:g2')
    expect(state.suspects).toHaveLength(4)
    await beginRound(deps)
    expect(fixes.aside.has('dir:g2')).toBe(true)
    await stop(deps)
    expect(fixes.asideIds()).toEqual(['dir:g2'])
  })

  it('refuses when every scanned group is already set aside', async () => {
    fixes.aside.set('dir:g0', { groupId: 'dir:g0', label: 'Group 000', entryId: 'e0', at: '2026-11-01T00:00:00.000Z', origin: 'fix' })
    expect(await start(makeDeps(), scanWith(makeGroups(1)))).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
  })
})

describe('restart and repeat', () => {
  it('a restart resumes at the same round, and beginRound twice moves nothing the second time', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(16)))
    await beginRound(deps)
    await giveAnswer(deps, 'worked')
    const r2 = stateOf(await giveAnswer(deps, 'crashed'))
    expect(r2.round).toBe(2)

    gate = new FakeGate()
    const restarted = makeDeps()
    expect(await loadState(restarted)).toEqual(r2)

    const moves = fixes.moves()
    const again = stateOf(await beginRound(restarted))
    expect(again).toEqual(r2)
    expect(fixes.moves()).toBe(moves)
  })

  it('a corrupt state file loads as no session', async () => {
    const base = stateOf(await start(makeDeps(), scanWith(makeGroups(2))))
    await writeFile(join(paths.stateDir, 'fiftyfifty.json'), '{"phase": "awaiting')
    expect(await loadState(makeDeps())).toBeNull()
    await writeFile(join(paths.stateDir, 'fiftyfifty.json'), '{"phase": "dancing"}')
    expect(await loadState(makeDeps())).toBeNull()
    await writeFile(join(paths.stateDir, 'fiftyfifty.json'), JSON.stringify({ ...base, round: -1 }))
    expect(await loadState(makeDeps())).toBeNull()
    await writeFile(join(paths.stateDir, 'fiftyfifty.json'), JSON.stringify({ ...base, history: [null] }))
    expect(await loadState(makeDeps())).toBeNull()
  })

  it('start replaces a leftover stopped state file instead of returning it as active', async () => {
    const deps = makeDeps()
    const base = stateOf(await start(deps, scanWith(makeGroups(4))))
    await writeFile(join(paths.stateDir, 'fiftyfifty.json'), JSON.stringify({ ...base, phase: 'stopped' }))
    const fresh = stateOf(await start(deps, scanWith(makeGroups(6))))
    expect(fresh.phase).toBe('close-curseforge')
    expect(fresh.groups).toHaveLength(6)
  })

  it('giveAnswer ignores an answer whose expected round does not match the current round', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    await beginRound(deps)
    const r1 = stateOf(await giveAnswer(deps, 'worked', 0))
    expect(r1.round).toBe(1)
    const writes = gate.stateWrites()
    const moves = fixes.moves()
    const stale = stateOf(await giveAnswer(deps, 'crashed', 0))
    expect(stale).toEqual(r1)
    expect(gate.stateWrites()).toBe(writes)
    expect(fixes.moves()).toBe(moves)
  })

  it('an answer does not count when the files are not arranged the way the round says', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    await beginRound(deps)
    // A stop that put every mod back but was cut off before the state file was removed leaves this behind.
    fixes.aside.clear()
    const again = stateOf(await giveAnswer(deps, 'worked'))
    expect(again).toMatchObject({ round: 0, phase: 'ready-to-test', history: [] })
    expect(await loadState(deps)).toEqual(again)
    expect(fixes.moves()).toBe(1)
    const ready = stateOf(await beginRound(deps))
    expect(ready).toMatchObject({ round: 0, phase: 'awaiting-answer' })
    expect(fixes.asideIds()).toEqual([...ready.parked].sort())
  })
})

describe('CurseForge', () => {
  it('a running CurseForge keeps the phase and moves nothing, in any letter case', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    for (const name of ['CurseForge.exe', 'curseforge.exe', 'CURSEFORGE Helper.exe']) {
      processes = ['explorer.exe', name]
      const state = stateOf(await beginRound(deps))
      expect(state.phase).toBe('close-curseforge')
      expect(fixes.calls).toEqual([])
    }
    processes = ['explorer.exe']
    expect(stateOf(await beginRound(deps)).phase).toBe('awaiting-answer')
  })

  it('sends a later round back to close-curseforge when it is open again', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    await beginRound(deps)
    const moves = fixes.moves()
    processes = ['CurseForge.exe']
    const state = stateOf(await giveAnswer(deps, 'worked'))
    expect(state).toMatchObject({ phase: 'close-curseforge', round: 1 })
    expect(fixes.moves()).toBe(moves)
    expect(await loadState(deps)).toEqual(state)
  })

  it('a process list that cannot be read does not block', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    processes = new Error('tasklist returned no processes')
    expect(stateOf(await beginRound(deps)).phase).toBe('awaiting-answer')
  })
})

describe('refusals', () => {
  it('a refusal from fixes comes back as refused and the round does not advance', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    fixes.refuseNext = GAME_RUNNING
    expect(await beginRound(deps)).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    const saved = await loadState(deps)
    expect(saved).toMatchObject({ round: 0, phase: 'ready-to-test' })
    expect(fixes.asideIds()).toEqual([])
    expect(stateOf(await beginRound(deps)).phase).toBe('awaiting-answer')
  })

  it('the answer is saved first, so a refused next round keeps it', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    await beginRound(deps)
    fixes.refuseNext = GAME_RUNNING
    expect(await giveAnswer(deps, 'worked')).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toMatchObject({ round: 1, phase: 'ready-to-test', history: [{ answer: 'worked' }] })
    expect(stateOf(await beginRound(deps))).toMatchObject({ round: 1, phase: 'awaiting-answer' })
  })

  it('a refused cache clear does not advance; "nothing to clear" is fine', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    fixes.cacheOutcome = { status: 'refused', refusal: GAME_RUNNING }
    expect(await beginRound(deps)).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toMatchObject({ phase: 'ready-to-test' })
    fixes.cacheOutcome = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
    expect(stateOf(await beginRound(deps)).phase).toBe('awaiting-answer')
  })

  it('a half-done move comes back as stopped-part-way and beginRound finishes it', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    fixes.partWayAfter = 2
    const result = await beginRound(deps)
    expect(result).toMatchObject({ status: 'stopped-part-way', state: { phase: 'ready-to-test' } })
    expect(fixes.asideIds()).toHaveLength(2)
    const state = stateOf(await beginRound(deps))
    expect(fixes.asideIds()).toEqual([...state.parked].sort())
  })

  it('a setAside that throws after some groups counts as stopped part way, and the next round finishes it', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    fixes.throwAfter = 3
    const result = await beginRound(deps)
    expect(result).toMatchObject({ status: 'stopped-part-way', state: { phase: 'ready-to-test', round: 0 } })
    expect(fixes.asideIds()).toHaveLength(3)
    const done = stateOf(await beginRound(deps))
    expect(done.phase).toBe('awaiting-answer')
    expect(fixes.asideIds()).toEqual([...done.parked].sort())
  })

  it('after a setAside that threw, stop puts back the groups that did get set aside', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    fixes.throwAfter = 3
    await beginRound(deps)
    expect(stateOf(await stop(deps)).phase).toBe('stopped')
    expect(fixes.asideIds()).toEqual([])
    expect(await stateFileExists()).toBe(false)
  })

  it('giveAnswer changes nothing unless the phase is awaiting-answer', async () => {
    const deps = makeDeps()
    const s0 = stateOf(await start(deps, scanWith(makeGroups(8))))
    const writes = gate.stateWrites()
    expect(await giveAnswer(deps, 'crashed')).toEqual({ status: 'ok', state: s0 })
    expect(gate.stateWrites()).toBe(writes)
    expect(fixes.calls).toEqual([])
  })

  it('a state save the gate refuses moves nothing', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    gate.next = { status: 'refused', refusal: { reason: 'outside-allowed-area', path: paths.stateDir } }
    const result = await beginRound(deps)
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'outside-allowed-area', path: paths.stateDir } }
    })
    expect(fixes.calls).toEqual([])
  })

  it('without a session, beginRound, giveAnswer and finish refuse and stop is fine', async () => {
    const deps = makeDeps()
    const none = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
    expect(await beginRound(deps)).toEqual(none)
    expect(await giveAnswer(deps, 'crashed')).toEqual(none)
    expect(await finish(deps, 'put-back')).toEqual(none)
    expect(await stop(deps)).toEqual({ status: 'ok', state: null })
  })
})

describe('stop puts every file back', () => {
  async function reachPhase(deps: FiftyDeps, phase: string): Promise<void> {
    await start(deps, scanWith(makeGroups(8, 3)))
    if (phase === 'close-curseforge') return
    if (phase === 'ready-to-test') {
      await beginRound(deps)
      fixes.refuseNext = GAME_RUNNING
      await giveAnswer(deps, 'worked')
      return
    }
    if (phase === 'part-way') {
      await beginRound(deps)
      fixes.partWayAfter = 1
      await giveAnswer(deps, 'crashed')
      return
    }
    await beginRound(deps)
    if (phase === 'awaiting-answer') return
    await playToFound(deps, 'dir:g6')
  }

  for (const phase of ['close-curseforge', 'ready-to-test', 'part-way', 'awaiting-answer', 'found']) {
    it(`at ${phase}`, async () => {
      const deps = makeDeps()
      await reachPhase(deps, phase)
      const result = await stop(deps)
      expect(stateOf(result).phase).toBe('stopped')
      expect(fixes.asideIds()).toEqual([])
      expect(await stateFileExists()).toBe(false)
      expect(await loadState(deps)).toBeNull()
    })
  }

  it('a refused put-back keeps the session so stop can be tried again', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    const before = stateOf(await beginRound(deps))
    fixes.refuseNext = GAME_RUNNING
    expect(await stop(deps)).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toEqual(before)
    expect(fixes.asideIds()).toHaveLength(8)
    await stop(deps)
    expect(fixes.asideIds()).toEqual([])
  })

  it('a half-done put-back keeps the session; stop again finishes it', async () => {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    await beginRound(deps)
    fixes.partWayAfter = 1
    expect(await stop(deps)).toMatchObject({ status: 'stopped-part-way' })
    expect(await loadState(deps)).not.toBeNull()
    await stop(deps)
    expect(fixes.asideIds()).toEqual([])
    expect(await loadState(deps)).toBeNull()
  })
})

describe('keeping the culprit set aside makes it her own choice', () => {
  const BAD = 'dir:g5'
  const file = () => join(paths.stateDir, 'fiftyfifty.json')

  async function found(): Promise<FiftyDeps> {
    const deps = makeDeps()
    await start(deps, scanWith(makeGroups(8)))
    const state = await playToFound(deps, BAD)
    expect(state.culprit).toBe(BAD)
    expect(fixes.aside.get(BAD)?.origin).toBe('fifty-fifty')
    fixes.calls = []
    return deps
  }

  /** The next setAside is refused, as the gate does when the game was opened between the two steps. */
  function refuseNextSetAside(): void {
    const real = fixes.setAside.bind(fixes)
    fixes.setAside = async (...args) => {
      fixes.setAside = real
      return { status: 'refused', refusal: GAME_RUNNING }
    }
  }

  it('puts it back and sets it aside again as her own (origin fix) before the test ends', async () => {
    const deps = await found()
    const done = stateOf(await finish(deps, 'keep-set-aside'))
    expect(done).toMatchObject({ phase: 'stopped', parked: [BAD], inMods: [] })
    expect(fixes.asideIds()).toEqual([BAD])
    expect(fixes.aside.get(BAD)?.origin).toBe('fix')
    expect(fixes.calls).toEqual([
      { method: 'putBack', ids: [BAD] },
      { method: 'setAside', ids: [BAD], origin: { by: 'fix' } }
    ])
    expect(await stateFileExists()).toBe(false)
  })

  it('a damaged-file stop after a finished test never touches the kept culprit', async () => {
    const deps = await found()
    stateOf(await finish(deps, 'keep-set-aside'))
    // The folder is known to the stop both ways: History has a move of the test there, and the file still says.
    fixes.journal = [
      sampleJournalEntry({ action: 'disable-group', groupId: BAD, folderPath: FOLDER, origin: { by: 'fifty-fifty', sessionId: 's1', round: 3 }, status: 'undone' })
    ]
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(file(), JSON.stringify({ phase: 'awaiting-answer', folderPath: FOLDER }))
    fixes.calls = []

    expect(await stop(deps)).toEqual({ status: 'ok', state: null })
    expect(fixes.asideIds()).toEqual([BAD])
    expect(fixes.calls.map((c) => c.method)).toEqual(['clearCaches'])
    expect(await stateFileExists()).toBe(false)
  })

  it('a refused put-back keeps the session and moves nothing', async () => {
    const deps = await found()
    fixes.refuseNext = GAME_RUNNING
    expect(await finish(deps, 'keep-set-aside')).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toMatchObject({ phase: 'found', culprit: BAD })
    expect(fixes.aside.get(BAD)?.origin).toBe('fifty-fifty')

    stateOf(await finish(deps, 'keep-set-aside'))
    expect(fixes.aside.get(BAD)?.origin).toBe('fix')
  })

  it('a refused set-aside keeps the session, and trying again only sets it aside', async () => {
    const deps = await found()
    refuseNextSetAside()
    expect(await finish(deps, 'keep-set-aside')).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await loadState(deps)).toMatchObject({ phase: 'found', culprit: BAD })
    expect(fixes.asideIds()).toEqual([])

    fixes.calls = []
    stateOf(await finish(deps, 'keep-set-aside'))
    expect(fixes.calls).toEqual([{ method: 'setAside', ids: [BAD], origin: { by: 'fix' } }])
    expect(fixes.aside.get(BAD)?.origin).toBe('fix')
    expect(await stateFileExists()).toBe(false)
  })

  it('a progress file that cannot be removed keeps the session, and trying again moves nothing', async () => {
    const deps = await found()
    gate.next = { status: 'refused', refusal: { reason: 'game-running' } }
    expect((await finish(deps, 'keep-set-aside')).status).toBe('refused')
    expect(await loadState(deps)).toMatchObject({ phase: 'found' })
    expect(fixes.aside.get(BAD)?.origin).toBe('fix')

    fixes.calls = []
    stateOf(await finish(deps, 'keep-set-aside'))
    expect(fixes.calls).toEqual([])
    expect(await stateFileExists()).toBe(false)
  })

  it('a culprit she turned back on from Your mods is set aside as her own', async () => {
    const deps = await found()
    fixes.aside.delete(BAD)
    stateOf(await finish(deps, 'keep-set-aside'))
    expect(fixes.calls).toEqual([{ method: 'setAside', ids: [BAD], origin: { by: 'fix' } }])
    expect(fixes.aside.get(BAD)?.origin).toBe('fix')
  })

  it('put-back still leaves nothing aside', async () => {
    const deps = await found()
    stateOf(await finish(deps, 'put-back'))
    expect(fixes.asideIds()).toEqual([])
  })
})

describe('a damaged progress file', () => {
  const file = () => join(paths.stateDir, 'fiftyfifty.json')
  const testEntry = (groupId: string) =>
    sampleJournalEntry({
      id: `j-${groupId}`,
      action: 'disable-group',
      groupId,
      folderPath: FOLDER,
      origin: { by: 'fifty-fifty', sessionId: 's1', round: 1 }
    })

  /** Two groups the test set aside and one she set aside herself, with the journal that goes with them. */
  function seedAside(): void {
    for (const [id, origin] of [['dir:g0', 'fifty-fifty'], ['dir:g1', 'fifty-fifty'], ['dir:hers', 'fix']] as const) {
      fixes.aside.set(id, { groupId: id, label: id, entryId: `j-${id}`, at: '2026-11-24T12:00:00.000Z', origin })
    }
    fixes.journal = [testEntry('dir:g0'), testEntry('dir:g1'), sampleJournalEntry({ id: 'j-dir:hers', groupId: 'dir:hers' })]
  }

  async function damage(text = '{"phase": "awaiting'): Promise<void> {
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(file(), text)
  }

  // PR 10 refuses her switches for every one of these, so each must count as damaged here: otherwise she is stuck.
  it.each([
    ['cut-off JSON', '{"phase": "awaiting'],
    ['an empty file', ''],
    ['null', 'null'],
    ['a list', '[]'],
    ['an empty object', '{}'],
    ['a phase nobody knows', '{"phase": "dancing"}'],
    ['a running phase without the rest', '{"phase": "awaiting-answer"}']
  ])('%s counts as damaged, not as no session', async (_name, text) => {
    await damage(text)
    expect((await readSaved(makeDeps())).kind).toBe('damaged')
    expect(await loadState(makeDeps())).toBeNull()
  })

  it('a file that is there but cannot be read counts as damaged; no file is no session', async () => {
    expect(await readSaved(makeDeps())).toEqual({ kind: 'none' })
    await mkdir(file(), { recursive: true }) // reading a folder fails with something other than "not found"
    expect((await readSaved(makeDeps())).kind).toBe('damaged')
  })

  it('getState answers the damaged shape, and still answers null with no file', async () => {
    expect(await getState(makeDeps())).toBeNull()
    await damage()
    expect(await getState(makeDeps())).toEqual({ status: 'damaged' })
  })

  it('start refuses and leaves the file alone, so the groups the test set aside are not orphaned', async () => {
    await damage()
    const result = await start(makeDeps(), scanWith(makeGroups(4)))
    expect(result).toEqual({ status: 'refused', refusal: { why: 'fifty-fifty-running' } })
    expect(await readFile(file(), 'utf8')).toBe('{"phase": "awaiting')
    expect(gate.requests).toEqual([])
  })

  it('stop puts back every group the test set aside, never hers, clears caches and removes the file', async () => {
    seedAside()
    await damage()
    expect(await stop(makeDeps())).toEqual({ status: 'ok', state: null })
    expect(fixes.asideIds()).toEqual(['dir:hers'])
    expect(fixes.calls.map((c) => c.method)).toEqual(['putBack', 'clearCaches'])
    expect(await stateFileExists()).toBe(false)
    expect(gate.requests.at(-1)).toMatchObject({ reason: 'state', ops: [{ op: 'remove', path: file() }] })
    expect((await start(makeDeps(), scanWith(makeGroups(4)))).status).toBe('ok')
  })

  it('stop finds the folder in the file when it still says, and removes the file when nothing is aside', async () => {
    await damage(JSON.stringify({ phase: 'awaiting-answer', folderPath: FOLDER }))
    fixes.cacheOutcome = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
    expect(await stop(makeDeps())).toEqual({ status: 'ok', state: null })
    expect(fixes.calls.map((c) => c.method)).toEqual(['clearCaches'])
    expect(await stateFileExists()).toBe(false)

    await damage()
    expect(await stop(makeDeps())).toEqual({ status: 'ok', state: null })
    expect(await stateFileExists()).toBe(false)
  })

  it('a refused put-back (the game is open) keeps the file, so her switches stay refused until it works', async () => {
    seedAside()
    await damage()
    fixes.refuseNext = GAME_RUNNING
    expect(await stop(makeDeps())).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await stateFileExists()).toBe(true)
    expect(fixes.asideIds()).toEqual(['dir:g0', 'dir:g1', 'dir:hers'])

    fixes.cacheOutcome = { status: 'refused', refusal: GAME_RUNNING }
    expect(await stop(makeDeps())).toEqual({ status: 'refused', refusal: GAME_RUNNING })
    expect(await stateFileExists()).toBe(true)

    expect(await stop(makeDeps())).toEqual({ status: 'ok', state: null })
    expect(await stateFileExists()).toBe(false)
  })

  it('a put-back that stops part way, or a journal that cannot be read, keeps the file', async () => {
    seedAside()
    await damage()
    fixes.partWayAfter = 1
    // dir:g0 did get back, and dir:hers is hers: only the test's group still out of Mods is named.
    expect(await stop(makeDeps())).toEqual({
      status: 'stopped-part-way',
      state: null,
      notBack: ['dir:g1'],
      detail: 'disk hiccup'
    })
    expect(await stateFileExists()).toBe(true)
    expect(fixes.asideIds()).toEqual(['dir:g1', 'dir:hers'])

    fixes.journal = null
    expect(await stop(makeDeps())).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(await stateFileExists()).toBe(true)
  })

  it('a put-back that throws ends part way too, naming every group of the test still out of Mods', async () => {
    seedAside()
    await damage()
    fixes.putBack = async () => {
      throw new Error('undo blew up')
    }
    expect(await stop(makeDeps())).toEqual({
      status: 'stopped-part-way',
      state: null,
      notBack: ['dir:g0', 'dir:g1'],
      detail: 'undo blew up'
    })
    expect(await stateFileExists()).toBe(true)
  })
})
