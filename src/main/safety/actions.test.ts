// @vitest-environment node
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { JournalEntry, Progress } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { ActionPlan } from '../ports.ts'
import { backupStatus, createBackup, listJournal, recover, runAction, undo } from './index.ts'
import { makeWorkspace, pathExists, snapshotTree } from './testing/harness.ts'
import type { Workspace, WorkspaceTools } from './testing/harness.ts'

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const roots: string[] = []
const TOOLS: WorkspaceTools = {
  fs: { mkdir: (p) => mkdir(p), copyFile, rename, writeFile, rm, utimes },
  makeTempRoot: async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-actions-')))
    roots.push(root)
    return root
  },
  generate: async (spec, out) => {
    await generateFixture(await loadSpec(join(SPECS, `${spec}.json`)), out)
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function backedUp(): Promise<Workspace> {
  const ws = await makeWorkspace(TOOLS)
  const result = await createBackup(ws.deps, ws.simsFolder)
  if (result.status !== 'verified') throw new Error(`backup ${result.status}`)
  return ws
}

function held(ws: Workspace, holdId: string, ...rel: string[]): string {
  return join(ws.paths.holdingDir, holdId, 'Mods', ...rel)
}

function disablePlan(ws: Workspace, holdId = 'hold-1'): ActionPlan {
  return {
    action: 'disable-group',
    summary: 'Set aside BuildBuy',
    origin: { by: 'fix' },
    folderPath: ws.simsFolder,
    groupId: 'dir:buildbuy',
    steps: [
      { kind: 'move', from: join(ws.mods, 'BuildBuy', 'lamp_a.package'), to: held(ws, holdId, 'BuildBuy', 'lamp_a.package') },
      { kind: 'move', from: join(ws.mods, 'BuildBuy', 'lamp_b.package'), to: held(ws, holdId, 'BuildBuy', 'lamp_b.package') }
    ]
  }
}

function editPlan(ws: Workspace, newText: string): ActionPlan {
  return {
    action: 'turn-mods-on',
    summary: 'Turned mods on',
    origin: { by: 'fix' },
    folderPath: ws.simsFolder,
    groupId: null,
    steps: [{ kind: 'edit', path: join(ws.simsFolder, 'Options.ini'), newText }]
  }
}

async function journalFiles(ws: Workspace): Promise<string[]> {
  return (await pathExists(ws.paths.journalDir)) ? await readdir(ws.paths.journalDir) : []
}

describe('runAction', () => {
  it('writes the journal entry before the first op, then marks every step applied', async () => {
    const ws = await backedUp()
    let journalSeen: JournalEntry | null = null
    ws.gate.hooks.beforeRequest = async (request) => {
      if (request.reason !== 'fix') return undefined
      const files = await journalFiles(ws)
      if (files.length !== 1) return { status: 'failed', opsDone: 0, detail: 'no journal entry on disk' }
      journalSeen = JSON.parse(await readFile(join(ws.paths.journalDir, files[0]!), 'utf8')) as JournalEntry
      return undefined
    }
    const lampA = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') return
    expect(journalSeen).not.toBeNull()
    expect(journalSeen!.status).toBe('in-progress')
    expect(journalSeen!.steps.every((s) => s.state === 'pending')).toBe(true)
    expect(outcome.entry.status).toBe('done')
    expect(outcome.entry.undo).toBe('can-undo')
    expect(outcome.entry.steps.every((s) => s.state === 'applied')).toBe(true)
    expect(outcome.entry.steps[0]).toMatchObject({ kind: 'move', sha256: lampA })
    const status = await backupStatus(ws.deps, ws.simsFolder)
    expect(status.state).toBe('verified')
    if (status.state === 'verified') expect(outcome.entry.backupId).toBe(status.backupId)
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(true)
    expect(await listJournal(ws.deps)).toEqual([outcome.entry])
    expect(ws.gate.count('fix')).toBe(1)
  })

  it('makes a backup first when the last one is stale, and passes its progress on', async () => {
    const ws = await backedUp()
    await writeFile(join(ws.mods, 'new_hair.package'), 'new since the backup')
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('stale')
    const before = ws.gate.count('backup')
    const progress: Progress[] = []

    const outcome = await runAction(ws.deps, disablePlan(ws), (p) => progress.push(p))

    expect(outcome.status).toBe('done')
    expect(ws.gate.count('backup')).toBeGreaterThan(before)
    expect(progress.some((p) => p.task === 'backup')).toBe(true)
    const status = await backupStatus(ws.deps, ws.simsFolder)
    expect(status.state).toBe('verified')
    if (outcome.status === 'done' && status.state === 'verified') expect(outcome.entry.backupId).toBe(status.backupId)
  })

  it('stops with nothing changed when the backup it needs is refused or fails', async () => {
    const ws = await makeWorkspace(TOOLS)
    const before = await snapshotTree(ws.simsFolder)
    ws.game.state = 'running'
    expect(await runAction(ws.deps, disablePlan(ws))).toEqual({
      status: 'refused',
      refusal: { why: 'backup', reason: 'game-running' }
    })

    ws.game.state = 'not-running'
    ws.gate.hooks.afterOp = async (op) => {
      if (op.op === 'copy') await writeFile(op.to, 'bad copy')
    }
    expect(await runAction(ws.deps, disablePlan(ws))).toEqual({
      status: 'refused',
      refusal: { why: 'backup', reason: 'backup-failed' }
    })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(ws.gate.count('fix')).toBe(0)
    expect(await journalFiles(ws)).toEqual([])
  })

  it('refuses with nothing changed when a planned file is gone or its target is taken', async () => {
    const ws = await backedUp()
    const plan = disablePlan(ws)
    await rm(join(ws.mods, 'BuildBuy', 'lamp_b.package'))
    expect(await runAction(ws.deps, plan)).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'file-changed' }
    })

    const ws2 = await backedUp()
    const plan2 = disablePlan(ws2)
    await mkdir(dirname(held(ws2, 'hold-1', 'BuildBuy', 'x')), { recursive: true })
    await writeFile(held(ws2, 'hold-1', 'BuildBuy', 'lamp_a.package'), 'already here')
    expect(await runAction(ws2.deps, plan2)).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'file-changed' }
    })
    expect(ws.gate.count('fix') + ws2.gate.count('fix')).toBe(0)
    expect(await journalFiles(ws)).toEqual([])
    expect(await journalFiles(ws2)).toEqual([])
  })

  it('removes the journal entry and returns the refusal when the gate refuses', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeRequest = (request) =>
      request.reason === 'fix' ? { status: 'refused', refusal: { reason: 'game-running' } } : undefined

    expect(await runAction(ws.deps, disablePlan(ws))).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'game-running' } }
    })
    expect(await journalFiles(ws)).toEqual([])
    expect(await listJournal(ws.deps)).toEqual([])
  })

  it('marks the steps that ran when the gate stops part way, and undo puts them back', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    ws.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'fix' && op.op === 'move' && op.from.endsWith('lamp_b.package') ? 'file in use' : undefined

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status !== 'stopped-part-way') return
    expect(outcome.entry.status).toBe('needs-attention')
    expect(outcome.entry.steps.map((s) => s.state)).toEqual(['applied', 'pending'])
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(true)
    expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(true)
    expect((await listJournal(ws.deps))[0]).toEqual(outcome.entry)

    ws.gate.hooks.beforeOp = undefined
    const undone = await undo(ws.deps, outcome.entry.id)
    expect(undone.status).toBe('done')
    if (undone.status === 'done') expect(undone.entry.status).toBe('undone')
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('undo after a part-way stop ignores the step that never ran, even when its file changed since', async () => {
    const ws = await backedUp()
    const lampA = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))
    ws.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'fix' && op.op === 'move' && op.from.endsWith('lamp_b.package') ? 'file in use' : undefined
    const outcome = await runAction(ws.deps, disablePlan(ws))
    if (outcome.status !== 'stopped-part-way') throw new Error(outcome.status)
    ws.gate.hooks.beforeOp = undefined
    await writeFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'updated by CurseForge')

    const undone = await undo(ws.deps, outcome.entry.id)

    expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(lampA)
    expect(await readFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'utf8')).toBe('updated by CurseForge')
  })

  it('counts a cache that is already gone as cleared', async () => {
    const ws = await backedUp()
    const outcome = await runAction(ws.deps, {
      action: 'clear-caches',
      summary: 'Cleared caches',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      steps: [
        { kind: 'remove-cache', path: join(ws.simsFolder, 'clientDB.package') },
        { kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package') }
      ]
    })
    expect(outcome).toMatchObject({ status: 'done', entry: { status: 'done', undo: 'cannot-undo' } })
    if (outcome.status === 'done') expect(outcome.entry.steps.every((s) => s.state === 'applied')).toBe(true)
    expect(await pathExists(join(ws.simsFolder, 'localthumbcache.package'))).toBe(false)
  })

  it('records a cache clear as one that cannot be undone', async () => {
    const ws = await backedUp()
    const outcome = await runAction(ws.deps, {
      action: 'clear-caches',
      summary: 'Cleared caches',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      steps: [
        { kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package') },
        { kind: 'remove-cache', path: join(ws.simsFolder, 'cachestr') }
      ]
    })
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') return
    expect(outcome.entry.undo).toBe('cannot-undo')
    expect(await pathExists(join(ws.simsFolder, 'localthumbcache.package'))).toBe(false)
    expect(await pathExists(join(ws.simsFolder, 'cachestr'))).toBe(false)
  })
})

describe('undo', () => {
  it('round trip: a move and an edit, both undone, leave the folder byte for byte as it was', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)

    const moved = await runAction(ws.deps, disablePlan(ws))
    const edited = await runAction(ws.deps, editPlan(ws, '[options]\nmodsdisabled = 0\nscriptmodsenabled = 1\n'))
    expect(moved.status).toBe('done')
    expect(edited.status).toBe('done')
    if (moved.status !== 'done' || edited.status !== 'done') return
    expect(await readFile(join(ws.simsFolder, 'Options.ini'), 'utf8')).toContain('scriptmodsenabled = 1')
    const step = edited.entry.steps[0]!
    expect(step.kind === 'edit' && step.savedCopy).toBe(join(ws.paths.holdingDir, edited.entry.id, 'edits', 'Options.ini'))
    expect(await snapshotTree(ws.simsFolder)).not.toEqual(before)

    const a = await undo(ws.deps, moved.entry.id)
    const b = await undo(ws.deps, edited.entry.id)
    expect(a.status).toBe('done')
    expect(b.status).toBe('done')
    if (a.status !== 'done' || b.status !== 'done') return
    expect(a.entry.status).toBe('undone')
    expect(a.entry.undoneAt).not.toBeNull()
    expect(a.entry.steps.every((s) => s.state === 'reverted')).toBe(true)
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)

    const requests = ws.gate.requests.length
    const again = await undo(ws.deps, moved.entry.id)
    expect(again).toEqual({ status: 'done', entry: a.entry })
    expect(ws.gate.requests.length).toBe(requests)
    const journal = await listJournal(ws.deps)
    expect(journal.map((e) => e.id)).toEqual([edited.entry.id, moved.entry.id])
    expect(journal.every((e) => e.status === 'undone')).toBe(true)
  })

  it('makes a backup first when the last one is stale, and stops with nothing changed when that is refused', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    await writeFile(join(ws.mods, 'new_hair.package'), 'new since the backup')
    const after = await snapshotTree(ws.simsFolder)

    ws.game.state = 'unknown'
    expect(await undo(ws.deps, moved.entry.id)).toEqual({
      status: 'refused',
      refusal: { why: 'backup', reason: 'game-state-unknown' }
    })
    expect(await snapshotTree(ws.simsFolder)).toEqual(after)
    expect((await listJournal(ws.deps))[0]!.status).toBe('done')

    ws.game.state = 'not-running'
    const backups = ws.gate.count('backup')
    const outcome = await undo(ws.deps, moved.entry.id)
    expect(outcome.status).toBe('done')
    expect(ws.gate.count('backup')).toBeGreaterThan(backups)
  })

  it('stops and names the file when the moved file changed', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const changed = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
    await writeFile(changed, 'edited while set aside')

    const outcome = await undo(ws.deps, moved.entry.id)

    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status !== 'stopped-part-way') return
    expect(outcome.detail).toContain('lamp_b.package')
    expect(outcome.entry.status).toBe('needs-attention')
    expect(await readFile(changed, 'utf8')).toBe('edited while set aside')
    expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(false)
  })

  it('never overwrites something new that sits where the file came from', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const from = join(ws.mods, 'BuildBuy', 'lamp_b.package')
    await writeFile(from, 'a new download')

    const outcome = await undo(ws.deps, moved.entry.id)

    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status !== 'stopped-part-way') return
    expect(outcome.detail).toContain('lamp_b.package')
    expect(outcome.entry.status).toBe('needs-attention')
    expect(await readFile(from, 'utf8')).toBe('a new download')
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
  })

  it('will not put an edit back when the file changed since', async () => {
    const ws = await backedUp()
    const edited = await runAction(ws.deps, editPlan(ws, '[options]\nmodsdisabled = 0\n'))
    if (edited.status !== 'done') throw new Error(edited.status)
    await writeFile(join(ws.simsFolder, 'Options.ini'), 'the game rewrote this')

    const outcome = await undo(ws.deps, edited.entry.id)

    expect(outcome.status).toBe('stopped-part-way')
    expect(await readFile(join(ws.simsFolder, 'Options.ini'), 'utf8')).toBe('the game rewrote this')
  })

  it('has nothing to do for a cache clear or an unknown entry', async () => {
    const ws = await backedUp()
    const cleared = await runAction(ws.deps, {
      action: 'clear-caches',
      summary: 'Cleared caches',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      steps: [{ kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package') }]
    })
    if (cleared.status !== 'done') throw new Error(cleared.status)
    const requests = ws.gate.requests.length
    expect(await undo(ws.deps, cleared.entry.id)).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
    expect(await undo(ws.deps, 'no-such-entry')).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
    expect(ws.gate.requests.length).toBe(requests)
  })
})

describe('recover', () => {
  async function interrupted(ws: Workspace, movesThatRan: number): Promise<JournalEntry> {
    // What a crash after `movesThatRan` moves leaves: the in-progress entry and some files moved.
    const plan = disablePlan(ws)
    let entry: JournalEntry | null = null
    ws.gate.hooks.beforeRequest = async (request) => {
      if (request.reason !== 'fix') return undefined
      const files = await journalFiles(ws)
      entry = JSON.parse(await readFile(join(ws.paths.journalDir, files[0]!), 'utf8')) as JournalEntry
      return { status: 'refused', refusal: { reason: 'game-running' } }
    }
    await runAction(ws.deps, plan)
    ws.gate.hooks.beforeRequest = undefined
    if (!entry) throw new Error('no entry was written')
    const saved: JournalEntry = entry
    await writeFile(join(ws.paths.journalDir, `${saved.id}.json`), JSON.stringify(saved))
    for (const step of plan.steps.slice(0, movesThatRan)) {
      if (step.kind !== 'move') continue
      await mkdir(dirname(step.to), { recursive: true })
      await rename(step.from, step.to)
    }
    return saved
  }

  it('puts back an entry left in progress after only some moves ran', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const entry = await interrupted(ws, 1)
    expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(false)

    const touched = await recover(ws.deps)

    expect(touched.map((e) => e.id)).toEqual([entry.id])
    expect(touched[0]!.status).toBe('undone')
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
    expect(await recover(ws.deps)).toEqual([])
  })

  it('marks an entry it cannot settle as needing attention, and deletes nothing', async () => {
    const ws = await backedUp()
    const entry = await interrupted(ws, 2)
    const lampB = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
    await writeFile(lampB, 'changed after the crash')
    const holding = await snapshotTree(ws.paths.holdingDir)

    const touched = await recover(ws.deps)

    expect(touched.map((e) => [e.id, e.status])).toEqual([[entry.id, 'needs-attention']])
    expect(await readFile(lampB, 'utf8')).toBe('changed after the crash')
    const after = await snapshotTree(ws.paths.holdingDir)
    for (const path of Object.keys(holding)) {
      if (!path.includes('lamp_a')) expect(after[path], path).toBeDefined()
    }
  })

  it('finishes an undo that was interrupted part way', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    // A crash during undo: the entry was marked in-progress, the last step was moved back, then the app died.
    const lastStep = moved.entry.steps[1]!
    if (lastStep.kind !== 'move') throw new Error('expected a move')
    await rename(lastStep.to, lastStep.from)
    await writeFile(
      join(ws.paths.journalDir, `${moved.entry.id}.json`),
      JSON.stringify({ ...moved.entry, status: 'in-progress' })
    )

    const touched = await recover(ws.deps)

    expect(touched.map((e) => e.status)).toEqual(['undone'])
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })
})

describe('listJournal', () => {
  it('is empty with no journal folder, and lists newest first', async () => {
    const ws = await backedUp()
    expect(await listJournal(ws.deps)).toEqual([])
    const first = await runAction(ws.deps, disablePlan(ws))
    const second = await runAction(ws.deps, editPlan(ws, '[options]\n'))
    if (first.status !== 'done' || second.status !== 'done') throw new Error('actions failed')
    expect((await listJournal(ws.deps)).map((e) => e.id)).toEqual([second.entry.id, first.entry.id])
  })
})
