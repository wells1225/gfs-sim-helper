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
  fs: { mkdir, copyFile, rename, writeFile, rm, utimes },
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
    entryId: holdId,
    action: 'disable-group',
    summary: 'Set aside BuildBuy',
    origin: { by: 'fix' },
    folderPath: ws.simsFolder,
    groupId: 'dir:buildbuy',
    groupLabel: 'BuildBuy',
    hasScript: false,
    steps: [
      { kind: 'move', from: join(ws.mods, 'BuildBuy', 'lamp_a.package'), to: held(ws, holdId, 'BuildBuy', 'lamp_a.package') },
      { kind: 'move', from: join(ws.mods, 'BuildBuy', 'lamp_b.package'), to: held(ws, holdId, 'BuildBuy', 'lamp_b.package') }
    ]
  }
}

async function editPlan(ws: Workspace, newText: string, entryId = 'edit-1'): Promise<ActionPlan> {
  const path = join(ws.simsFolder, 'Options.ini')
  return {
    entryId,
    action: 'turn-mods-on',
    summary: 'Turned mods on',
    origin: { by: 'fix' },
    folderPath: ws.simsFolder,
    groupId: null,
    groupLabel: null,
    hasScript: false,
    steps: [{ kind: 'edit', path, newText, beforeSha256: await sha256File(path) }]
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

  it('counts a cache that is already gone as cleared, and still goes through the gate so the game check runs', async () => {
    const ws = await backedUp()
    const plan: ActionPlan = {
      entryId: 'clear-missing-1',
      action: 'clear-caches',
      summary: 'Cleared caches',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      groupLabel: null,
      hasScript: false,
      steps: [{ kind: 'remove-cache', path: join(ws.simsFolder, 'clientDB.package') }]
    }
    ws.game.state = 'running'
    expect(await runAction(ws.deps, plan)).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'game-running' } }
    })
    expect(await journalFiles(ws)).toEqual([])

    ws.game.state = 'not-running'
    const outcome = await runAction(ws.deps, {
      ...plan,
      entryId: 'clear-missing-2',
      steps: [
        { kind: 'remove-cache', path: join(ws.simsFolder, 'clientDB.package') },
        { kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package') }
      ]
    })
    expect(outcome).toMatchObject({ status: 'done', entry: { id: 'clear-missing-2', status: 'done', undo: 'cannot-undo' } })
    if (outcome.status === 'done') expect(outcome.entry.steps.every((s) => s.state === 'applied')).toBe(true)
    expect(await pathExists(join(ws.simsFolder, 'localthumbcache.package'))).toBe(false)
  })

  it('uses plan.entryId for the journal entry and edit holding copy instead of calling newId', async () => {
    const ws = await backedUp()
    let newIdCalls = 0
    ws.deps.newId = () => {
      newIdCalls += 1
      return `unexpected-${newIdCalls}`
    }

    const moved = await runAction(ws.deps, disablePlan(ws, 'planned-move-id'))
    expect(moved.status).toBe('done')
    if (moved.status !== 'done') return
    expect(moved.entry.id).toBe('planned-move-id')
    expect(await journalFiles(ws)).toContain('planned-move-id.json')

    const edited = await runAction(ws.deps, await editPlan(ws, '[options]\nmodsdisabled = 0\n', 'planned-edit-id'))
    expect(edited.status).toBe('done')
    if (edited.status !== 'done') return
    expect(edited.entry.id).toBe('planned-edit-id')
    expect(edited.entry.steps[0]).toMatchObject({
      kind: 'edit',
      savedCopy: join(ws.paths.holdingDir, 'planned-edit-id', 'edits', 'Options.ini')
    })
    expect(newIdCalls).toBe(0)
  })

  it('refuses a plan with colliding move destinations before writing the journal or moving any file', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const sameTo = held(ws, 'collide-1', 'same.package')
    const outcome = await runAction(ws.deps, {
      entryId: 'collide-1',
      action: 'set-aside-files',
      summary: 'Duplicate target',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      groupLabel: null,
      hasScript: false,
      steps: [
        { kind: 'move', from: join(ws.mods, 'BuildBuy', 'lamp_a.package'), to: sameTo },
        { kind: 'move', from: join(ws.mods, 'BuildBuy', 'lamp_b.package'), to: sameTo }
      ]
    })
    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(await journalFiles(ws)).toEqual([])
  })

  it('refuses cleanly when a file appears in Mods between backupFirst and the fix gate request', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    let planted = false
    ws.gate.hooks.afterOp = async (op, _i, request) => {
      if (request.reason === 'journal' && op.op === 'write' && !planted) {
        planted = true
        await writeFile(join(ws.mods, 'sneaked-in.package'), 'unbacked up')
      }
    }

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'no-verified-backup', backup: 'stale' } }
    })
    expect(await journalFiles(ws)).toEqual([])
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(false)
    await rm(join(ws.mods, 'sneaked-in.package'))
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('does not falsely return done if updating the journal after the fix fails', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeRequest = (request) =>
      request.reason === 'journal' && request.ops.some((op) => op.op === 'write' && op.mode === 'replace')
        ? { status: 'failed', opsDone: 0, detail: 'disk full' }
        : undefined

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status === 'stopped-part-way') expect(outcome.detail).toContain('disk full')
  })

  it('refuses an edit when the file changed since the planner read it, with nothing changed', async () => {
    const ws = await backedUp()
    const plan = await editPlan(ws, '[options]\nmodsdisabled = 0\n')
    // The game (or she) rewrote Options.ini after the plan was made.
    const options = join(ws.simsFolder, 'Options.ini')
    await writeFile(options, '[options]\nmodsdisabled = 1\nresolutionwidth = 2560\n')
    const before = await snapshotTree(ws.simsFolder)
    const requests = ws.gate.requests.length

    const outcome = await runAction(ws.deps, plan)

    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(await journalFiles(ws)).toEqual([])
    expect(ws.gate.requests.length).toBe(requests)
  })

  it('copies the group label and script flag from the plan into the journal entry', async () => {
    const ws = await backedUp()
    const outcome = await runAction(ws.deps, { ...disablePlan(ws), hasScript: true })
    if (outcome.status !== 'done') throw new Error(outcome.status)
    expect(outcome.entry).toMatchObject({ groupLabel: 'BuildBuy', hasScript: true })
    expect((await listJournal(ws.deps))[0]).toMatchObject({ groupLabel: 'BuildBuy', hasScript: true })
  })

  it('answers not-started, with nothing changed, when the journal entry cannot be written', async () => {
    for (const how of ['fails', 'throws'] as const) {
      const ws = await backedUp()
      const before = await snapshotTree(ws.simsFolder)
      ws.gate.hooks.beforeRequest = (request) => {
        if (request.reason !== 'journal') return undefined
        if (how === 'throws') throw new Error('gate broke')
        return { status: 'failed', opsDone: 0, detail: 'the disk said ENOSPC' }
      }

      const outcome = await runAction(ws.deps, disablePlan(ws))

      expect(outcome, how).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
      expect(await snapshotTree(ws.simsFolder), how).toEqual(before)
      expect(ws.gate.count('fix'), how).toBe(0)
    }
  })

  it('never throws once files have moved: a journal save that throws afterwards is a part-way stop that undo can finish', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    ws.gate.hooks.beforeRequest = (request) => {
      if (request.reason === 'journal' && request.ops.some((op) => op.op === 'write' && op.mode === 'replace')) {
        throw new Error('gate broke')
      }
      return undefined
    }

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome.status).toBe('stopped-part-way')
    ws.gate.hooks.beforeRequest = undefined
    const undone = await undo(ws.deps, 'hold-1')
    expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('undo answers not-started, with nothing changed, when it cannot mark the journal entry first', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const afterAction = await snapshotTree(ws.root)
    ws.gate.hooks.beforeRequest = (request) =>
      request.reason === 'journal' ? { status: 'failed', opsDone: 0, detail: 'the disk said ENOSPC' } : undefined

    const outcome = await undo(ws.deps, moved.entry.id)

    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(ws.gate.count('undo')).toBe(0)
    expect(await snapshotTree(ws.root)).toEqual(afterAction)
  })

  it('records a cache clear as one that cannot be undone', async () => {
    const ws = await backedUp()
    const outcome = await runAction(ws.deps, {
      entryId: 'clear-1',
      action: 'clear-caches',
      summary: 'Cleared caches',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      groupLabel: null,
      hasScript: false,
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
    const edited = await runAction(ws.deps, await editPlan(ws, '[options]\nmodsdisabled = 0\nscriptmodsenabled = 1\n'))
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
    const edited = await runAction(ws.deps, await editPlan(ws, '[options]\nmodsdisabled = 0\n'))
    if (edited.status !== 'done') throw new Error(edited.status)
    await writeFile(join(ws.simsFolder, 'Options.ini'), 'the game rewrote this')

    const outcome = await undo(ws.deps, edited.entry.id)

    expect(outcome.status).toBe('stopped-part-way')
    expect(await readFile(join(ws.simsFolder, 'Options.ini'), 'utf8')).toBe('the game rewrote this')
  })

  it('never overwrites a folder or link that appeared at from, and lets a follow-up undo finish once cleared', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)

    // Step 0's original path is now occupied by a folder; step 1 is clean.
    const lampAFrom = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    await mkdir(lampAFrom)

    const partial = await undo(ws.deps, moved.entry.id)
    expect(partial.status).toBe('stopped-part-way')
    if (partial.status !== 'stopped-part-way') return
    expect(partial.detail).toContain('lamp_a.package')
    expect(partial.entry.status).toBe('needs-attention')
    // Step 1 (lamp_b) was put back, step 0 (lamp_a) stayed safe in holding and the folder was not overwritten.
    expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(true)
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(true)

    await rm(lampAFrom, { recursive: true })
    const finished = await undo(ws.deps, moved.entry.id)
    expect(finished).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('has nothing to do for a cache clear or an unknown entry', async () => {
    const ws = await backedUp()
    const cleared = await runAction(ws.deps, {
      entryId: 'clear-only-1',
      action: 'clear-caches',
      summary: 'Cleared caches',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      groupLabel: null,
      hasScript: false,
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

  it('puts back an entry left in progress across every crash point (0, 1, or all moves ran)', async () => {
    for (const movesThatRan of [0, 1, 2]) {
      const ws = await backedUp()
      const before = await snapshotTree(ws.simsFolder)
      const entry = await interrupted(ws, movesThatRan)

      const touched = await recover(ws.deps)

      expect(touched.map((e) => e.id), `movesThatRan=${movesThatRan}`).toEqual([entry.id])
      expect(touched[0]!.status, `movesThatRan=${movesThatRan}`).toBe('undone')
      expect(await snapshotTree(ws.simsFolder), `movesThatRan=${movesThatRan}`).toEqual(before)
      expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
      expect(await recover(ws.deps)).toEqual([])
    }
  })

  it('preserves earlier moved steps as applied when recover stops on a later unclear step, so a follow-up undo restores everything', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const entry = await interrupted(ws, 2)
    // Something new sits at step 1's original path before restart.
    const conflict = join(ws.mods, 'BuildBuy', 'lamp_b.package')
    await writeFile(conflict, 'new file at lamp_b')

    const touched = await recover(ws.deps)
    expect(touched.map((e) => [e.id, e.status])).toEqual([[entry.id, 'needs-attention']])
    expect(await readFile(conflict, 'utf8')).toBe('new file at lamp_b')
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(true)
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)

    // Once the conflicting file is cleared, undo must restore BOTH lamp_a and lamp_b — never silently mark undone.
    await rm(conflict)
    const undone = await undo(ws.deps, entry.id)
    expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('recovers an edit action that crashed before savedCopy, after savedCopy, or after replacing Options.ini', async () => {
    for (const stage of ['before-copy', 'after-copy', 'after-write'] as const) {
      const ws = await backedUp()
      const before = await snapshotTree(ws.simsFolder)
      const optionsPath = join(ws.simsFolder, 'Options.ini')
      const newText = '[options]\nmodsdisabled = 0\nscriptmodsenabled = 1\n'
      let saved: JournalEntry | null = null
      ws.gate.hooks.beforeRequest = async (request) => {
        if (request.reason !== 'fix') return undefined
        const files = await journalFiles(ws)
        saved = JSON.parse(await readFile(join(ws.paths.journalDir, files[0]!), 'utf8')) as JournalEntry
        return { status: 'refused', refusal: { reason: 'game-running' } }
      }
      await runAction(ws.deps, await editPlan(ws, newText, `edit-crash-${stage}`))
      ws.gate.hooks.beforeRequest = undefined
      if (!saved) throw new Error('no entry written')
      const entry: JournalEntry = saved
      const step = entry.steps[0]!
      if (step.kind !== 'edit') throw new Error('expected edit')
      await writeFile(join(ws.paths.journalDir, `${entry.id}.json`), JSON.stringify(entry))
      if (stage === 'after-copy' || stage === 'after-write') {
        await mkdir(dirname(step.savedCopy), { recursive: true })
        await copyFile(optionsPath, step.savedCopy)
      }
      if (stage === 'after-write') {
        await writeFile(optionsPath, newText)
      }

      const touched = await recover(ws.deps)

      expect(touched.map((e) => e.status), stage).toEqual(['undone'])
      expect(await snapshotTree(ws.simsFolder), stage).toEqual(before)
    }
  })

  it('finishes an undo of a needs-attention entry that crashed mid-undo without tripping on steps that never ran', async () => {
    const ws = await backedUp()
    const lampAHash = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))
    ws.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'fix' && op.op === 'move' && op.from.endsWith('lamp_b.package') ? 'file in use' : undefined
    const stopped = await runAction(ws.deps, disablePlan(ws))
    if (stopped.status !== 'stopped-part-way') throw new Error(stopped.status)
    ws.gate.hooks.beforeOp = undefined

    // Step 1 (lamp_b) never ran and was updated externally.
    await writeFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'updated by CurseForge')
    // Simulate a crash right after undo wrote status: 'in-progress' before moving lamp_a back.
    await writeFile(
      join(ws.paths.journalDir, `${stopped.entry.id}.json`),
      JSON.stringify({ ...stopped.entry, status: 'in-progress' })
    )

    const touched = await recover(ws.deps)

    expect(touched.map((e) => e.status)).toEqual(['undone'])
    expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(lampAHash)
    expect(await readFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'utf8')).toBe('updated by CurseForge')
  })

  it('puts back an action that crashed half way through a move to another drive (the copy is made, the original not yet removed)', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const entry = await interrupted(ws, 1)
    // Across drives the gate copies, checks, and only then removes the source. The crash fell between the two.
    const stray = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
    await copyFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), stray)

    const touched = await recover(ws.deps)

    expect(touched.map((e) => [e.id, e.status])).toEqual([[entry.id, 'undone']])
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(await pathExists(stray)).toBe(true) // recover deletes nothing
    expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
  })

  it('finishes an undo that crashed half way through a move back from another drive', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const lastStep = moved.entry.steps[1]!
    if (lastStep.kind !== 'move') throw new Error('expected a move')
    await copyFile(lastStep.to, lastStep.from)
    await writeFile(join(ws.paths.journalDir, `${moved.entry.id}.json`), JSON.stringify({ ...moved.entry, status: 'in-progress' }))

    const touched = await recover(ws.deps)

    expect(touched.map((e) => e.status)).toEqual(['undone'])
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(await pathExists(lastStep.to)).toBe(true)
  })

  it('still stops when the original is back but something else sits where the action put it', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const lastStep = moved.entry.steps[1]!
    if (lastStep.kind !== 'move') throw new Error('expected a move')
    await copyFile(lastStep.to, lastStep.from)
    await writeFile(lastStep.to, 'not the file the action moved')

    const undone = await undo(ws.deps, moved.entry.id)

    expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    expect(await readFile(lastStep.to, 'utf8')).toBe('not the file the action moved')
  })

  it('goes on to the next entry when one entry cannot be saved, and leaves that one in progress', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    const newText = '[options]\nmodsdisabled = 0\n'
    const edited = await runAction(ws.deps, await editPlan(ws, newText))
    if (moved.status !== 'done' || edited.status !== 'done') throw new Error('actions failed')
    for (const entry of [moved.entry, edited.entry]) {
      await writeFile(join(ws.paths.journalDir, `${entry.id}.json`), JSON.stringify({ ...entry, status: 'in-progress' }))
    }
    // The newer entry (the edit) comes first, and its journal file cannot be written.
    ws.gate.hooks.beforeRequest = (request) =>
      request.reason === 'journal' && request.ops.some((op) => op.op === 'write' && op.path.endsWith('edit-1.json'))
        ? { status: 'failed', opsDone: 0, detail: 'the disk said ENOSPC' }
        : undefined

    const touched = await recover(ws.deps)

    expect(touched.map((e) => [e.id, e.status])).toEqual([[moved.entry.id, 'undone']])
    const after = await snapshotTree(ws.simsFolder)
    expect(after['Mods/BuildBuy/lamp_a.package']).toBe(before['Mods/BuildBuy/lamp_a.package'])
    expect(after['Mods/BuildBuy/lamp_b.package']).toBe(before['Mods/BuildBuy/lamp_b.package'])
    expect(await readFile(join(ws.simsFolder, 'Options.ini'), 'utf8')).toBe(newText)
    const left = (await listJournal(ws.deps)).find((e) => e.id === edited.entry.id)
    expect(left?.status).toBe('in-progress')
  })

  it('goes on to the next entry when settling one entry throws', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    const edited = await runAction(ws.deps, await editPlan(ws, '[options]\nmodsdisabled = 0\n'))
    if (moved.status !== 'done' || edited.status !== 'done') throw new Error('actions failed')
    for (const entry of [moved.entry, edited.entry]) {
      await writeFile(join(ws.paths.journalDir, `${entry.id}.json`), JSON.stringify({ ...entry, status: 'in-progress' }))
    }
    // A new file in Mods makes the backup stale, so each entry needs a backup first. The first one throws.
    await writeFile(join(ws.mods, 'new_hair.package'), 'new')
    let thrown = false
    ws.gate.hooks.beforeRequest = (request) => {
      if (request.reason !== 'backup' || thrown) return undefined
      thrown = true
      throw new Error('gate broke')
    }

    const touched = await recover(ws.deps)

    expect(thrown).toBe(true)
    expect(touched.map((e) => [e.id, e.status])).toEqual([[moved.entry.id, 'undone']])
    const left = (await listJournal(ws.deps)).find((e) => e.id === edited.entry.id)
    expect(left?.status).toBe('in-progress')
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

  it('finishes an undo that was interrupted before the first revert move, mid-moves, or during an edit undo', async () => {
    for (const revertedBeforeCrash of [0, 1]) {
      const ws = await backedUp()
      const before = await snapshotTree(ws.simsFolder)
      const moved = await runAction(ws.deps, disablePlan(ws))
      if (moved.status !== 'done') throw new Error(moved.status)
      if (revertedBeforeCrash === 1) {
        const lastStep = moved.entry.steps[1]!
        if (lastStep.kind !== 'move') throw new Error('expected a move')
        await rename(lastStep.to, lastStep.from)
      }
      await writeFile(
        join(ws.paths.journalDir, `${moved.entry.id}.json`),
        JSON.stringify({ ...moved.entry, status: 'in-progress' })
      )

      const touched = await recover(ws.deps)

      expect(touched.map((e) => e.status), `reverted=${revertedBeforeCrash}`).toEqual(['undone'])
      expect(await snapshotTree(ws.simsFolder), `reverted=${revertedBeforeCrash}`).toEqual(before)
    }

    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const edited = await runAction(ws.deps, await editPlan(ws, '[options]\nmodsdisabled = 0\n'))
    if (edited.status !== 'done') throw new Error(edited.status)
    await writeFile(
      join(ws.paths.journalDir, `${edited.entry.id}.json`),
      JSON.stringify({ ...edited.entry, status: 'in-progress' })
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
    const second = await runAction(ws.deps, await editPlan(ws, '[options]\n'))
    if (first.status !== 'done' || second.status !== 'done') throw new Error('actions failed')
    expect((await listJournal(ws.deps)).map((e) => e.id)).toEqual([second.entry.id, first.entry.id])
  })
})
