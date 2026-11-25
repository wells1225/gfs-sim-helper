// @vitest-environment node
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
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

/** A temp root reached through a link, as her AppData may be (a junction on Windows). */
const LINKED_TOOLS: WorkspaceTools = {
  ...TOOLS,
  makeTempRoot: async () => {
    const real = await TOOLS.makeTempRoot()
    const link = `${real}-link`
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    roots.push(link)
    return link
  }
}

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

/** Writes a journal entry by hand, as a crash or an odd disk could have left it. */
async function writeEntry(ws: Workspace, id: string, backupId: string, steps: JournalEntry['steps']): Promise<void> {
  await mkdir(ws.paths.journalDir, { recursive: true })
  const entry: JournalEntry = {
    id,
    at: '2026-11-24T12:00:00.000Z',
    action: 'disable-group',
    summary: 'Set aside BuildBuy',
    origin: { by: 'fix' },
    folderPath: ws.simsFolder,
    groupId: 'dir:buildbuy',
    groupLabel: 'BuildBuy',
    hasScript: false,
    backupId,
    steps,
    status: 'needs-attention',
    undo: 'can-undo',
    undoneAt: null
  }
  await writeFile(join(ws.paths.journalDir, `${id}.json`), JSON.stringify(entry))
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

  describe('a failed answer whose move at opsDone ran in part', () => {
    // The gate answers failed with opsDone at lamp_b's move. That move may have done nothing, left the file at both
    // places (a move to another drive cut off after the copy), or finished before the answer went wrong.
    async function stoppedAtLampB(ws: Workspace, layout: 'source-only' | 'both' | 'target-only') {
      ws.gate.hooks.beforeOp = async (op, _i, request) => {
        if (request.reason !== 'fix' || op.op !== 'move' || !op.from.endsWith('lamp_b.package')) return undefined
        if (layout !== 'source-only') await mkdir(dirname(op.to), { recursive: true })
        if (layout === 'both') await copyFile(op.from, op.to)
        if (layout === 'target-only') await rename(op.from, op.to)
        return 'the move stopped'
      }
      const outcome = await runAction(ws.deps, disablePlan(ws))
      ws.gate.hooks.beforeOp = undefined
      if (outcome.status !== 'stopped-part-way') throw new Error(outcome.status)
      return outcome.entry
    }

    it('source only: the step stays pending, and undo leaves her newer file alone', async () => {
      const ws = await backedUp()
      const lampA = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))
      const entry = await stoppedAtLampB(ws, 'source-only')
      expect(entry.steps.map((s) => s.state)).toEqual(['applied', 'pending'])
      await writeFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'updated by CurseForge')

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(lampA)
      expect(await readFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'utf8')).toBe('updated by CurseForge')
    })

    it('target only: the step counts as applied, and undo brings the file back from holding', async () => {
      const ws = await backedUp()
      const before = await snapshotTree(ws.simsFolder)
      const entry = await stoppedAtLampB(ws, 'target-only')
      expect(entry.steps.map((s) => s.state)).toEqual(['applied', 'applied'])
      expect((await listJournal(ws.deps))[0]!.steps.map((s) => s.state)).toEqual(['applied', 'applied'])

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
      expect(await snapshotTree(ws.simsFolder)).toEqual(before)
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(false)
    })

    it('both places: the step counts as applied, and undo removes the identical copy from holding and calls it undone', async () => {
      const ws = await backedUp()
      const before = await snapshotTree(ws.simsFolder)
      const lampB = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))
      const entry = await stoppedAtLampB(ws, 'both')
      expect(entry.steps.map((s) => s.state)).toEqual(['applied', 'applied'])

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
      if (undone.status === 'done') expect(undone.entry.steps.map((s) => s.state)).toEqual(['reverted', 'reverted'])
      expect(await snapshotTree(ws.simsFolder)).toEqual(before)
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(lampB) // the file in Mods is never touched
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(false)
      expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
      // The duplicate goes through the gate as one app-data remove of the holding copy, and nothing else.
      const removes = ws.gate.requests.flatMap((r) => r.ops.filter((op) => op.op === 'remove').map((op) => ({ reason: r.reason, op })))
      expect(removes).toEqual([{ reason: 'undo', op: { op: 'remove', path: held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package') } }])
    })

    it('both places, with the app-data folder reached through a link: the identical copy in holding is still removed', async () => {
      const ws = await makeWorkspace(LINKED_TOOLS)
      const made = await createBackup(ws.deps, ws.simsFolder)
      if (made.status !== 'verified') throw new Error(`backup ${made.status}`)
      const before = await snapshotTree(ws.simsFolder)
      const entry = await stoppedAtLampB(ws, 'both')
      expect(await realpath(ws.paths.holdingDir)).not.toBe(ws.paths.holdingDir)

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
      expect(await snapshotTree(ws.simsFolder)).toEqual(before)
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(false)
      expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
    })

    it('both places with different bytes in holding: both are kept, and the entry needs attention', async () => {
      const ws = await backedUp()
      const entry = await stoppedAtLampB(ws, 'both')
      const copy = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
      const bytes = await readFile(copy)
      bytes[0] = bytes[0]! ^ 0xff
      await writeFile(copy, bytes)
      const lampB = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))
      const copyHash = await sha256File(copy)

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') expect(undone.detail).toContain('lamp_b.package')
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(lampB)
      expect(await sha256File(copy)).toBe(copyHash)
      expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    })

    it('both places, removal refused: both are kept, and the entry needs attention with the copy-left words', async () => {
      const ws = await backedUp()
      const lampB = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))
      const entry = await stoppedAtLampB(ws, 'both')
      ws.gate.hooks.beforeRequest = (request) =>
        request.ops.some((op) => op.op === 'remove') ? { status: 'refused', refusal: { reason: 'game-running' } } : undefined

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') {
        expect(undone.detail).toBe('This file is back where it was, and the app kept a spare copy of it to be safe: lamp_b.package')
        expect(undone.detail).not.toContain('holding')
        expect(undone.detail).toContain('lamp_b.package')
        expect(undone.detail).not.toContain(ws.root)
        expect(undone.detail).not.toContain(ws.paths.holdingDir)
      }
      // lamp_a still comes back: a refused clean-up does not stop the rest of the undo.
      expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(true)
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(lampB)
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
      expect((await listJournal(ws.deps))[0]!.status).toBe('needs-attention')
      expect(ws.gate.requests.filter((r) => r.ops.some((op) => op.op === 'remove'))).toHaveLength(1) // it was asked, and said no
    })

    it('both places, removal fails: both are kept, and the entry needs attention', async () => {
      const ws = await backedUp()
      const entry = await stoppedAtLampB(ws, 'both')
      ws.gate.hooks.beforeOp = (op) => (op.op === 'remove' ? 'the disk said no' : undefined)

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(true)
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
      expect(ws.gate.requests.filter((r) => r.ops.some((op) => op.op === 'remove'))).toHaveLength(1) // it was tried, and failed
    })

    it('both places, removal throws: both are kept, lamp_a still comes back, and the entry needs attention', async () => {
      const ws = await backedUp()
      const lampB = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))
      const entry = await stoppedAtLampB(ws, 'both')
      ws.gate.hooks.beforeRequest = (request) => {
        if (request.ops.some((op) => op.op === 'remove')) throw new Error(`EPERM on ${ws.paths.holdingDir}`)
        return undefined
      }

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') {
        expect(undone.detail).toBe('This file is back where it was, and the app kept a spare copy of it to be safe: lamp_b.package')
        expect(undone.detail).not.toContain('holding')
        expect(undone.detail).toContain('lamp_b.package')
        expect(undone.detail).not.toContain('EPERM')
        expect(undone.detail).not.toContain(ws.root)
      }
      expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(true)
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(lampB)
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
    })

    it('both places, holding copy changes during undo before cleanup: re-hash keeps both files and sends no remove', async () => {
      const ws = await backedUp()
      const lampB = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))
      const entry = await stoppedAtLampB(ws, 'both')
      const copy = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
      ws.gate.hooks.afterOp = async (op, _i, request) => {
        if (request.reason === 'undo' && op.op === 'move') await writeFile(copy, 'changed mid-undo')
      }

      const undone = await undo(ws.deps, entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') {
        expect(undone.detail).toContain('lamp_b.package')
        expect(undone.detail).not.toContain(ws.root)
      }
      expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(true)
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(lampB)
      expect(await readFile(copy, 'utf8')).toBe('changed mid-undo')
      expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    })

    it('two copies left in holding: a refused removal on one does not block removing the other', async () => {
      const ws = await backedUp()
      const moved = await runAction(ws.deps, disablePlan(ws))
      if (moved.status !== 'done') throw new Error(moved.status)
      const heldA = held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package')
      const heldB = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
      await copyFile(heldA, join(ws.mods, 'BuildBuy', 'lamp_a.package'))
      await copyFile(heldB, join(ws.mods, 'BuildBuy', 'lamp_b.package'))
      ws.gate.hooks.beforeRequest = (request) =>
        request.ops.some((op) => op.op === 'remove' && op.path === heldB)
          ? { status: 'refused', refusal: { reason: 'saves-or-tray', path: heldB } }
          : undefined

      const undone = await undo(ws.deps, moved.entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') {
        expect(undone.entry.steps.map((s) => s.state)).toEqual(['reverted', 'applied'])
      }
      expect(await pathExists(heldA)).toBe(false)
      expect(await pathExists(heldB)).toBe(true)
      expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(true)
      expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_b.package'))).toBe(true)
    })

    it.each(['dir', 'junction'] as const)('a %s link inside holding pointing to backupsDir is never removed', async (type) => {
      const ws = await backedUp()
      const status = await backupStatus(ws.deps, ws.simsFolder)
      if (status.state !== 'verified') throw new Error('expected verified backup')
      const lampB = join(ws.mods, 'BuildBuy', 'lamp_b.package')
      const backupMods = join(ws.paths.backupsDir, status.backupId, 'files', 'Mods')
      const backupLampB = join(backupMods, 'BuildBuy', 'lamp_b.package')
      const heldMods = join(ws.paths.holdingDir, 'hold-sym', 'Mods')
      const heldLampB = join(heldMods, 'BuildBuy', 'lamp_b.package')
      await mkdir(join(ws.paths.holdingDir, 'hold-sym'), { recursive: true })
      await symlink(backupMods, heldMods, type)
      await mkdir(ws.paths.journalDir, { recursive: true })
      const sha = await sha256File(lampB)
      const bytes = (await readFile(lampB)).length
      await writeFile(
        join(ws.paths.journalDir, 'hold-sym.json'),
        JSON.stringify({
          id: 'hold-sym',
          at: '2026-11-24T12:00:00.000Z',
          action: 'disable-group',
          summary: 'Set aside BuildBuy',
          origin: { by: 'fix' },
          folderPath: ws.simsFolder,
          groupId: 'dir:buildbuy',
          groupLabel: 'BuildBuy',
          hasScript: false,
          backupId: status.backupId,
          steps: [{ kind: 'move', from: lampB, to: heldLampB, bytes, sha256: sha, state: 'applied' }],
          status: 'needs-attention',
          undo: 'can-undo',
          undoneAt: null
        })
      )

      const undone = await undo(ws.deps, 'hold-sym')

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      expect(await pathExists(backupLampB)).toBe(true)
      expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    })

    it.each(['dir', 'junction'] as const)(
      'a %s link between two holding entries is never removed, keeping the other entry intact',
      async (type) => {
        const ws = await backedUp()
        const status = await backupStatus(ws.deps, ws.simsFolder)
        if (status.state !== 'verified') throw new Error('expected verified backup')
        const lampB = join(ws.mods, 'BuildBuy', 'lamp_b.package')
        const sha = await sha256File(lampB)
        const bytes = (await readFile(lampB)).length
        const hold2BuildBuy = held(ws, 'hold-2', 'BuildBuy')
        const hold2LampB = join(hold2BuildBuy, 'lamp_b.package')
        await mkdir(hold2BuildBuy, { recursive: true })
        await copyFile(lampB, hold2LampB)
        const hold1BuildBuy = held(ws, 'hold-1', 'BuildBuy')
        const hold1LampB = join(hold1BuildBuy, 'lamp_b.package')
        await mkdir(dirname(hold1BuildBuy), { recursive: true })
        await symlink(hold2BuildBuy, hold1BuildBuy, type)
        await writeEntry(ws, 'hold-1', status.backupId, [
          { kind: 'move', from: lampB, to: hold1LampB, bytes, sha256: sha, state: 'applied' }
        ])

        const undone = await undo(ws.deps, 'hold-1')

        expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
        expect(await pathExists(hold2LampB)).toBe(true)
        expect(await sha256File(hold2LampB)).toBe(sha)
        expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
        expect((await listJournal(ws.deps))[0]!.status).toBe('needs-attention')
      }
    )

    it('a copy left by a move inside Mods is never removed: the entry needs attention with plain Mods wording', async () => {
      const ws = await backedUp()
      const from = join(ws.mods, 'BuildBuy', 'lamp_b.package')
      const to = join(ws.mods, 'lamp_b.package')
      const plan: ActionPlan = { ...disablePlan(ws), action: 'move-script-up', steps: [{ kind: 'move', from, to }] }
      ws.gate.hooks.beforeOp = async (op, _i, request) => {
        if (request.reason !== 'fix' || op.op !== 'move') return undefined
        await copyFile(op.from, op.to)
        return 'the move stopped'
      }
      const stopped = await runAction(ws.deps, plan)
      ws.gate.hooks.beforeOp = undefined
      if (stopped.status !== 'stopped-part-way') throw new Error(stopped.status)

      const undone = await undo(ws.deps, stopped.entry.id)

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') {
        expect(undone.detail).not.toContain('holding folder')
        expect(undone.detail).toContain('Mods folder')
        expect(undone.detail).toContain('lamp_b.package')
        expect(undone.detail).not.toContain(ws.root)
        expect(undone.detail).not.toContain(ws.mods)
      }
      expect(await pathExists(from)).toBe(true)
      expect(await pathExists(to)).toBe(true)
      expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    })

    it('a copy whose path inside holding leads back to the file itself is never removed', async () => {
      const ws = await backedUp()
      const status = await backupStatus(ws.deps, ws.simsFolder)
      if (status.state !== 'verified') throw new Error('expected verified backup')
      const realDir = join(ws.paths.holdingDir, 'real')
      const from = join(realDir, 'lamp_b.package')
      const alias = join(ws.paths.holdingDir, 'hold-same', 'alias')
      const to = join(alias, 'lamp_b.package')
      await mkdir(realDir, { recursive: true })
      await mkdir(dirname(alias), { recursive: true })
      await copyFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), from)
      await symlink(realDir, alias, 'junction')
      const sha = await sha256File(from)
      await writeEntry(ws, 'hold-same', status.backupId, [
        { kind: 'move', from, to, bytes: (await readFile(from)).length, sha256: sha, state: 'applied' }
      ])

      const undone = await undo(ws.deps, 'hold-same')

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      expect(await sha256File(from)).toBe(sha)
      expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    })

    it('a copy left outside both Mods and holding is kept, and the words claim neither folder', async () => {
      const ws = await backedUp()
      const status = await backupStatus(ws.deps, ws.simsFolder)
      if (status.state !== 'verified') throw new Error('expected verified backup')
      const from = join(ws.mods, 'BuildBuy', 'lamp_b.package')
      const to = join(ws.paths.dataDir, 'elsewhere', 'lamp_b.package')
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      await writeEntry(ws, 'hold-out', status.backupId, [
        { kind: 'move', from, to, bytes: (await readFile(from)).length, sha256: await sha256File(from), state: 'applied' }
      ])

      const undone = await undo(ws.deps, 'hold-out')

      expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (undone.status === 'stopped-part-way') {
        expect(undone.detail).toContain('lamp_b.package')
        expect(undone.detail).not.toContain('Mods folder')
        expect(undone.detail).not.toContain('holding folder')
        expect(undone.detail).not.toContain(ws.root)
      }
      expect(await pathExists(from)).toBe(true)
      expect(await pathExists(to)).toBe(true)
      expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    })
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

  it('does not falsely return done if updating the journal after the fix fails, and leaks no raw error or path', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeRequest = (request) =>
      request.reason === 'journal' && request.ops.some((op) => op.op === 'write' && op.mode === 'replace')
        ? { status: 'failed', opsDone: 0, detail: `write ${join(ws.paths.journalDir, 'hold-1.json')}: the disk said ENOSPC` }
        : undefined

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status === 'stopped-part-way') {
      expect(outcome.detail).toContain('History')
      expect(outcome.detail).not.toContain('ENOSPC')
      expect(outcome.detail).not.toContain(ws.root)
    }
  })

  it('an undo the gate calls done but that moved nothing names only the file, never its full path', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    ws.gate.hooks.beforeRequest = (request) => (request.reason === 'undo' ? { status: 'done' } : undefined)

    const undone = await undo(ws.deps, moved.entry.id)

    expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (undone.status === 'stopped-part-way') {
      expect(undone.detail).toContain('lamp_b.package')
      expect(undone.detail).not.toContain(ws.root)
    }
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
  })

  it('never leaks full file paths or raw disk error text in stopped-part-way details', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'fix' && op.op === 'move' && op.from.endsWith('lamp_b.package')
        ? `move ${op.from} -> ${op.to}: the disk said EBUSY`
        : undefined
    const failedFix = await runAction(ws.deps, disablePlan(ws))
    ws.gate.hooks.beforeOp = undefined
    expect(failedFix.status).toBe('stopped-part-way')
    if (failedFix.status === 'stopped-part-way') {
      expect(failedFix.detail).not.toContain('EBUSY')
      expect(failedFix.detail).not.toContain(ws.root)
    }

    const ws2 = await backedUp()
    const moved = await runAction(ws2.deps, disablePlan(ws2))
    if (moved.status !== 'done') throw new Error(moved.status)
    ws2.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'undo' && op.op === 'move'
        ? `move ${op.from} -> ${op.to}: the disk said EACCES`
        : undefined
    const failedUndo = await undo(ws2.deps, moved.entry.id)
    ws2.gate.hooks.beforeOp = undefined
    expect(failedUndo.status).toBe('stopped-part-way')
    if (failedUndo.status === 'stopped-part-way') {
      expect(failedUndo.detail).not.toContain('EACCES')
      expect(failedUndo.detail).not.toContain(ws2.root)
    }
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

  it('takes back an entry file that a failed create left on disk, so the next start writes no false History line', async () => {
    const ws = await backedUp()
    // The real gate names the file, then fails (the temp name will not go, or the folder flush fails).
    ws.gate.hooks.beforeRequest = async (request) => {
      const write = request.ops.find((op) => op.op === 'write' && op.mode === 'create')
      if (request.reason !== 'journal' || !write || write.op !== 'write') return undefined
      await mkdir(dirname(write.path), { recursive: true })
      await writeFile(write.path, write.data)
      return { status: 'failed', opsDone: request.ops.length - 1, detail: 'flush failed' }
    }

    const outcome = await runAction(ws.deps, disablePlan(ws))

    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    ws.gate.hooks.beforeRequest = undefined
    expect(await journalFiles(ws)).toEqual([])
    expect(await recover(ws.deps)).toEqual([])
    expect(await listJournal(ws.deps)).toEqual([])
  })

  it('a fix the gate refuses whose entry cannot be taken back never ran: the next start says nothing and marks nothing undone', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    ws.gate.hooks.beforeRequest = (request) => {
      if (request.reason === 'fix') return { status: 'refused', refusal: { reason: 'game-running' } }
      if (request.reason === 'journal' && request.ops.some((op) => op.op === 'remove')) {
        return { status: 'failed', opsDone: 0, detail: 'the disk said no' }
      }
      return undefined
    }

    expect(await runAction(ws.deps, disablePlan(ws))).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'game-running' } }
    })
    expect(await journalFiles(ws)).toEqual(['hold-1.json']) // the take-back failed
    ws.gate.hooks.beforeRequest = undefined

    expect(await recover(ws.deps)).toEqual([])
    expect(await listJournal(ws.deps)).toEqual([])
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('a failed create whose take-back also fails never ran: the next start says nothing and marks nothing undone', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeRequest = async (request) => {
      if (request.reason !== 'journal') return undefined
      if (request.ops.some((op) => op.op === 'remove')) return { status: 'failed', opsDone: 0, detail: 'the disk said no' }
      const write = request.ops.find((op) => op.op === 'write' && op.mode === 'create')
      if (!write || write.op !== 'write') return undefined
      await mkdir(dirname(write.path), { recursive: true })
      await writeFile(write.path, write.data)
      return { status: 'failed', opsDone: request.ops.length - 1, detail: 'flush failed' }
    }

    expect(await runAction(ws.deps, disablePlan(ws))).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(await journalFiles(ws)).toEqual(['hold-1.json'])
    ws.gate.hooks.beforeRequest = undefined

    expect(await recover(ws.deps)).toEqual([])
    expect(await listJournal(ws.deps)).toEqual([])
  })

  it('an entry that never ran and still cannot be taken back at the next start is left alone, never marked undone', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeRequest = (request) => {
      if (request.reason === 'fix') return { status: 'refused', refusal: { reason: 'game-running' } }
      if (request.reason === 'journal' && request.ops.some((op) => op.op === 'remove')) {
        return { status: 'failed', opsDone: 0, detail: 'the disk said no' }
      }
      return undefined
    }
    await runAction(ws.deps, disablePlan(ws))
    const backups = ws.gate.count('backup')

    expect(await recover(ws.deps)).toEqual([])
    expect((await listJournal(ws.deps)).map((e) => e.status)).toEqual(['in-progress'])
    expect(ws.gate.count('backup')).toBe(backups) // nothing to put back, so no backup was made for it
  })

  it('never takes back an older entry that already has the id when the create fails', async () => {
    const ws = await backedUp()
    const first = await runAction(ws.deps, disablePlan(ws))
    if (first.status !== 'done') throw new Error(first.status)

    const second = await runAction(ws.deps, await editPlan(ws, '[options]\nmodsdisabled = 0\n', first.entry.id))

    expect(second).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(await listJournal(ws.deps)).toEqual([first.entry])
  })

  it('compares exact bytes when taking back a failed journal create, not lossy UTF-8 text', async () => {
    const ws = await backedUp()
    const plan: ActionPlan = { ...disablePlan(ws, 'raw-bytes-1'), summary: 'Set aside \uFFFD' }
    let rawWritten: Buffer | null = null
    ws.gate.hooks.beforeRequest = async (request) => {
      const write = request.ops.find((op) => op.op === 'write' && op.mode === 'create')
      if (request.reason !== 'journal' || !write || write.op !== 'write' || typeof write.data !== 'string') return undefined
      await mkdir(dirname(write.path), { recursive: true })
      const utf8 = Buffer.from(write.data, 'utf8')
      const fffd = Buffer.from('\uFFFD', 'utf8')
      const idx = utf8.indexOf(fffd)
      rawWritten = Buffer.concat([utf8.subarray(0, idx), Buffer.from([0xff]), utf8.subarray(idx + fffd.length)])
      await writeFile(write.path, rawWritten)
      return { status: 'failed', opsDone: request.ops.length - 1, detail: 'target already exists' }
    }

    const outcome = await runAction(ws.deps, plan)

    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(rawWritten).not.toBeNull()
    expect(await readFile(join(ws.paths.journalDir, 'raw-bytes-1.json'))).toEqual(rawWritten)
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

describe('a cache clear that stops part way', () => {
  const CACHE_STOPPED = 'Some temporary cache files were cleared before it stopped. That is safe: the game makes them again.'

  function cachePlan(ws: Workspace): ActionPlan {
    return {
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
    }
  }

  it('says so in plain words, and the entry settles as done so it never stays stuck', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'fix' && op.op === 'remove' && op.path.endsWith('cachestr') ? 'file in use' : undefined

    const outcome = await runAction(ws.deps, cachePlan(ws))

    expect(outcome).toMatchObject({ status: 'stopped-part-way', detail: CACHE_STOPPED, entry: { status: 'done' } })
    if (outcome.status === 'stopped-part-way') expect(outcome.entry.steps.map((s) => s.state)).toEqual(['applied', 'pending'])
    ws.gate.hooks.beforeOp = undefined
    expect((await listJournal(ws.deps)).map((e) => e.status)).toEqual(['done'])
    expect(await recover(ws.deps)).toEqual([])
  })

  it('a gate that throws inside a cache folder: a cleared file counts, the folder stays pending, and it settles as CACHE_STOPPED', async () => {
    const ws = await backedUp()
    const cacheDir = join(ws.simsFolder, 'cachestr')
    const cleared = join(cacheDir, 'cleared.bin')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cleared, 'first cache file')
    await writeFile(join(cacheDir, 'locked.bin'), 'locked cache file')
    ws.gate.hooks.beforeOp = async (op, _i, request) => {
      if (request.reason !== 'fix' || op.op !== 'remove' || op.path !== cacheDir) return undefined
      await rm(cleared)
      throw new Error(`EPERM on ${cacheDir}`)
    }

    const outcome = await runAction(ws.deps, cachePlan(ws))
    ws.gate.hooks.beforeOp = undefined

    expect(outcome).toMatchObject({ status: 'stopped-part-way', detail: CACHE_STOPPED, entry: { status: 'done' } })
    if (outcome.status === 'stopped-part-way') expect(outcome.entry.steps.map((s) => s.state)).toEqual(['applied', 'pending'])
    expect((await listJournal(ws.deps)).map((e) => [e.status, e.steps.map((s) => s.state)])).toEqual([
      ['done', ['applied', 'pending']]
    ])
    expect(await recover(ws.deps)).toEqual([])
  })

  it('a gate that throws before a file-only cache clear removed anything never ran, and leaves no History line', async () => {
    const ws = await backedUp()
    const thumbs = join(ws.simsFolder, 'localthumbcache.package')
    ws.gate.hooks.beforeOp = (_op, _i, request) => {
      if (request.reason === 'fix') throw new Error(`EPERM on ${thumbs}`)
      return undefined
    }

    const outcome = await runAction(ws.deps, { ...cachePlan(ws), steps: [{ kind: 'remove-cache', path: thumbs }] })
    ws.gate.hooks.beforeOp = undefined

    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(await listJournal(ws.deps)).toEqual([])
    expect(await pathExists(thumbs)).toBe(true)
  })

  it('that stopped before clearing anything is a change that never ran, and leaves no History line', async () => {
    const ws = await backedUp()
    ws.gate.hooks.beforeOp = (_op, _i, request) => (request.reason === 'fix' ? 'file in use' : undefined)

    const outcome = await runAction(ws.deps, cachePlan(ws))

    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    ws.gate.hooks.beforeOp = undefined
    expect(await listJournal(ws.deps)).toEqual([])
    expect(await pathExists(join(ws.simsFolder, 'localthumbcache.package'))).toBe(true)
  })

  it('cut off by a crash after one cache went: the next start settles it as done, not needing attention', async () => {
    const ws = await backedUp()
    let saved: JournalEntry | null = null
    ws.gate.hooks.beforeRequest = async (request) => {
      if (request.reason !== 'fix') return undefined
      saved = JSON.parse(await readFile(join(ws.paths.journalDir, 'clear-1.json'), 'utf8')) as JournalEntry
      return { status: 'refused', refusal: { reason: 'game-running' } }
    }
    await runAction(ws.deps, cachePlan(ws))
    ws.gate.hooks.beforeRequest = undefined
    if (!saved) throw new Error('no entry was written')
    await writeFile(join(ws.paths.journalDir, 'clear-1.json'), JSON.stringify(saved))
    await rm(join(ws.simsFolder, 'localthumbcache.package'))

    const touched = await recover(ws.deps)

    expect(touched.map((e) => [e.id, e.status])).toEqual([['clear-1', 'done']])
    expect(touched[0]!.steps.map((s) => s.state)).toEqual(['applied', 'pending'])
    expect(await recover(ws.deps)).toEqual([])
  })

  it('first step is a cache folder that fails at opsDone 0 after removing one file inside: settles as CACHE_STOPPED and done', async () => {
    const ws = await backedUp()
    const cacheDir = join(ws.simsFolder, 'cachestr')
    const cleared = join(cacheDir, 'cleared.bin')
    const locked = join(cacheDir, 'locked.bin')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cleared, 'first cache file')
    await writeFile(locked, 'locked cache file')
    ws.gate.hooks.beforeOp = async (op, _i, request) => {
      if (request.reason !== 'fix' || op.op !== 'remove' || op.path !== cacheDir) return undefined
      await rm(cleared)
      return 'file in use'
    }

    const outcome = await runAction(ws.deps, {
      ...cachePlan(ws),
      entryId: 'clear-folder-1',
      steps: [
        { kind: 'remove-cache', path: cacheDir },
        { kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package') }
      ]
    })
    ws.gate.hooks.beforeOp = undefined

    expect(outcome).toMatchObject({ status: 'stopped-part-way', detail: CACHE_STOPPED, entry: { status: 'done' } })
    expect(await pathExists(cleared)).toBe(false)
    expect(await pathExists(locked)).toBe(true)
    expect((await listJournal(ws.deps)).map((e) => [e.id, e.status])).toEqual([['clear-folder-1', 'done']])
    expect(await recover(ws.deps)).toEqual([])
  })

  it('cut off by a crash inside a cache folder that still exists: the next start settles it as done instead of dropping it', async () => {
    const ws = await backedUp()
    const cacheDir = join(ws.simsFolder, 'cachestr')
    const cleared = join(cacheDir, 'cleared.bin')
    const locked = join(cacheDir, 'locked.bin')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cleared, 'first cache file')
    await writeFile(locked, 'locked cache file')
    let saved: JournalEntry | null = null
    ws.gate.hooks.beforeRequest = async (request) => {
      if (request.reason !== 'fix') return undefined
      saved = JSON.parse(await readFile(join(ws.paths.journalDir, 'clear-folder-crash.json'), 'utf8')) as JournalEntry
      return { status: 'refused', refusal: { reason: 'game-running' } }
    }
    await runAction(ws.deps, {
      ...cachePlan(ws),
      entryId: 'clear-folder-crash',
      steps: [
        { kind: 'remove-cache', path: cacheDir },
        { kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package') }
      ]
    })
    ws.gate.hooks.beforeRequest = undefined
    if (!saved) throw new Error('no entry was written')
    await writeFile(join(ws.paths.journalDir, 'clear-folder-crash.json'), JSON.stringify(saved))
    await rm(cleared)

    const touched = await recover(ws.deps)

    expect(touched.map((e) => [e.id, e.status])).toEqual([['clear-folder-crash', 'done']])
    expect((await listJournal(ws.deps)).map((e) => [e.id, e.status])).toEqual([['clear-folder-crash', 'done']])
    expect(await recover(ws.deps)).toEqual([])
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
    expect(outcome.detail).not.toContain(ws.root)
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
    expect(outcome.detail).not.toContain(ws.root)
    expect(outcome.entry.status).toBe('needs-attention')
    expect(await readFile(from, 'utf8')).toBe('a new download')
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
  })

  it('skips a file updated in Mods since, leaves it alone, and puts the rest back', async () => {
    const ws = await backedUp()
    const lampA = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const newerB = join(ws.mods, 'BuildBuy', 'lamp_b.package')
    await writeFile(newerB, 'updated by CurseForge')

    for (const attempt of [1, 2]) {
      const outcome = await undo(ws.deps, moved.entry.id)

      expect(outcome, `attempt ${attempt}`).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
      if (outcome.status !== 'stopped-part-way') return
      expect(outcome.detail).toBe('This file is not as the change left it: lamp_b.package')
      expect(outcome.entry.steps.map((s) => s.state)).toEqual(['reverted', 'applied'])
      expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(lampA)
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(false)
      expect(await readFile(newerB, 'utf8')).toBe('updated by CurseForge')
      expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
      expect((await listJournal(ws.deps))[0]!.status).toBe('needs-attention')
    }
  })

  it('names each file it skipped, and only those', async () => {
    const ws = await backedUp()
    const plan = disablePlan(ws)
    const third = { kind: 'move' as const, from: join(ws.mods, 'tiny.package'), to: held(ws, 'hold-1', 'tiny.package') }
    await writeFile(third.from, 'a tiny mod')
    const moved = await runAction(ws.deps, { ...plan, steps: [...plan.steps, third] })
    if (moved.status !== 'done') throw new Error(moved.status)
    await writeFile(join(ws.mods, 'BuildBuy', 'lamp_a.package'), 'newer a')
    await writeFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'newer b')

    const outcome = await undo(ws.deps, moved.entry.id)

    expect(outcome).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (outcome.status !== 'stopped-part-way') return
    expect(outcome.detail).toBe('These files are not as the change left them: lamp_a.package, lamp_b.package')
    expect(await readFile(third.from, 'utf8')).toBe('a tiny mod')
    expect(outcome.entry.steps.map((s) => s.state)).toEqual(['applied', 'applied', 'reverted'])
  })

  it('skips an edit whose saved copy changed, and still puts a moved file back', async () => {
    const ws = await backedUp()
    const status = await backupStatus(ws.deps, ws.simsFolder)
    if (status.state !== 'verified') throw new Error('expected a verified backup')
    const from = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    const to = held(ws, 'mixed-1', 'BuildBuy', 'lamp_a.package')
    const lampA = await sha256File(from)
    const bytes = (await readFile(from)).length
    const options = join(ws.simsFolder, 'Options.ini')
    const savedCopy = join(ws.paths.holdingDir, 'mixed-1', 'edits', 'Options.ini')
    const beforeSha256 = await sha256File(options)
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
    await mkdir(dirname(savedCopy), { recursive: true })
    await writeFile(savedCopy, 'not what Options.ini said')
    await writeFile(options, '[options]\nmodsdisabled = 0\n')
    const afterSha256 = await sha256File(options)
    await writeEntry(ws, 'mixed-1', status.backupId, [
      { kind: 'move', from, to, bytes, sha256: lampA, state: 'applied' },
      { kind: 'edit', path: options, savedCopy, beforeSha256, afterSha256, state: 'applied' }
    ])

    const outcome = await undo(ws.deps, 'mixed-1')

    expect(outcome).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (outcome.status !== 'stopped-part-way') return
    expect(outcome.detail).toBe('This file is not as the change left it: Options.ini')
    expect(await sha256File(from)).toBe(lampA)
    expect(await sha256File(options)).toBe(afterSha256)
    expect(outcome.entry.steps.map((s) => s.state)).toEqual(['reverted', 'applied'])
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
  it('keeps both copies when the folder in Mods became a link into the backup, so the only bytes left are never the backup\'s', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    // After the set-aside, Mods/BuildBuy is replaced by a folder link into the backup's copy of it.
    const status = await backupStatus(ws.deps, ws.simsFolder)
    if (status.state !== 'verified') throw new Error(`expected a verified backup, got ${status.state}`)
    const inBackup = join(ws.paths.backupsDir, status.backupId, 'files', 'Mods', 'BuildBuy')
    expect(await pathExists(join(inBackup, 'lamp_a.package'))).toBe(true)
    await rm(join(ws.mods, 'BuildBuy'), { recursive: true })
    await symlink(inBackup, join(ws.mods, 'BuildBuy'), 'junction')
    const heldA = held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package')
    const heldB = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
    const [hashA, hashB] = [await sha256File(heldA), await sha256File(heldB)]

    const undone = await undo(ws.deps, moved.entry.id)

    expect(undone.status).not.toBe('refused') // it reached the clean-up
    expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (undone.status === 'stopped-part-way') {
      expect(undone.detail).toMatch(/^This file did not come back as it was: lamp_[ab]\.package$/)
      expect(undone.detail).not.toContain('back where it was')
      expect(undone.detail).not.toContain(ws.root)
      expect(undone.detail).not.toContain('holding')
    }
    expect(await sha256File(heldA)).toBe(hashA)
    expect(await sha256File(heldB)).toBe(hashB)
    expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)
    expect((await listJournal(ws.deps))[0]!.status).toBe('needs-attention')
  })

  it('an undo that put every file back but could not save History says the files are back, with no raw error or path', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    // The first journal mark goes through; the save after the undo request fails.
    ws.gate.hooks.beforeRequest = (request) =>
      request.reason === 'journal' && ws.gate.count('undo') >= 1
        ? { status: 'failed', opsDone: 0, detail: `write ${join(ws.paths.journalDir, 'hold-1.json')}: the disk said ENOSPC` }
        : undefined

    const outcome = await undo(ws.deps, moved.entry.id)

    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status !== 'stopped-part-way') return
    expect(outcome.detail).toBe('Your files are back as they were, but the app could not save this to History.')
    expect(outcome.detail).not.toContain('ENOSPC')
    expect(outcome.detail).not.toContain(ws.root)
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('a move back cut off after its copy says undo stopped, keeps both files, and the next undo settles the copy', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    const copy = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
    // Across drives the move back copies first: cut off there, the file is back in Mods and its copy is still held.
    ws.gate.hooks.beforeOp = async (op, _i, request) => {
      if (request.reason !== 'undo' || op.op !== 'move' || op.from !== copy) return undefined
      await mkdir(dirname(op.to), { recursive: true })
      await copyFile(op.from, op.to)
      return 'the move stopped'
    }

    const undone = await undo(ws.deps, moved.entry.id)
    ws.gate.hooks.beforeOp = undefined

    expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (undone.status === 'stopped-part-way') {
      expect(undone.detail).toBe('Some files could not be put back. You can try Undo again.')
      expect(undone.entry.steps[1]!.state).toBe('applied') // left for the next undo, which looks at the disk afresh
    }
    expect(await pathExists(copy)).toBe(true)
    expect(ws.gate.requests.some((r) => r.ops.some((op) => op.op === 'remove'))).toBe(false)

    const again = await undo(ws.deps, moved.entry.id)

    expect(again).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await pathExists(copy)).toBe(false)
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })

  it('says undo stopped when a move fails, even if another step already had a copy left', async () => {
    const ws = await backedUp()
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    // Step 1 (lamp_b) is already copy-left; step 0 (lamp_a) still needs to move back, and that move fails at opsDone 0.
    await copyFile(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'), join(ws.mods, 'BuildBuy', 'lamp_b.package'))
    ws.gate.hooks.beforeOp = (op, _i, request) =>
      request.reason === 'undo' && op.op === 'move' ? 'file in use' : undefined

    const undone = await undo(ws.deps, moved.entry.id)
    ws.gate.hooks.beforeOp = undefined

    expect(undone).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (undone.status === 'stopped-part-way') {
      expect(undone.detail).toBe('Some files could not be put back. You can try Undo again.')
      expect(undone.detail).not.toContain('This file is back where it was')
    }
    expect(await pathExists(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(false)
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(true)
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)
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

      expect(await snapshotTree(ws.simsFolder), `movesThatRan=${movesThatRan}`).toEqual(before)
      if (movesThatRan === 0) {
        // Nothing had moved: a change that never ran is taken back, and the start tells her nothing.
        expect(touched, 'movesThatRan=0').toEqual([])
        expect(await listJournal(ws.deps)).toEqual([])
      } else {
        expect(touched.map((e) => e.id), `movesThatRan=${movesThatRan}`).toEqual([entry.id])
        expect(touched[0]!.status, `movesThatRan=${movesThatRan}`).toBe('undone')
        expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
      }
      expect(await recover(ws.deps)).toEqual([])
    }
  })

  it('listJournal only reads: an entry left in progress stays as it is until recover() is called', async () => {
    const ws = await backedUp()
    const entry = await interrupted(ws, 1)
    const tree = await snapshotTree(ws.simsFolder)
    const requests = ws.gate.requests.length

    const listed = await listJournal(ws.deps)
    await listJournal(ws.deps)

    expect(listed.find((e) => e.id === entry.id)!.status).toBe('in-progress')
    expect(ws.gate.requests.length).toBe(requests)
    expect(await snapshotTree(ws.simsFolder)).toEqual(tree)
  })

  it('skips a later unclear step during recovery and puts the earlier one back, so a follow-up undo restores everything', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const entry = await interrupted(ws, 2)
    // Something new sits at step 1's original path before restart.
    const conflict = join(ws.mods, 'BuildBuy', 'lamp_b.package')
    await writeFile(conflict, 'new file at lamp_b')

    const touched = await recover(ws.deps)
    expect(touched.map((e) => [e.id, e.status])).toEqual([[entry.id, 'needs-attention']])
    expect(await readFile(conflict, 'utf8')).toBe('new file at lamp_b')
    // The unclear step is skipped, and the rest is put back: lamp_a is home, lamp_b's old copy is kept.
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_a.package'))).toBe(false)
    expect(await snapshotTree(ws.simsFolder).then((t) => t['Mods/BuildBuy/lamp_a.package'])).toBe(before['Mods/BuildBuy/lamp_a.package'])
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

      // Before the write, Options.ini is as it was: the change never ran, and its entry is taken back.
      expect(touched.map((e) => e.status), stage).toEqual(stage === 'after-write' ? ['undone'] : [])
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

  it('puts back an action that crashed half way through a move to another drive, and removes the identical copy from holding', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const entry = await interrupted(ws, 1)
    // Across drives the gate copies, checks, and only then removes the source. The crash fell between the two.
    const stray = held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package')
    await copyFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), stray)

    const touched = await recover(ws.deps)

    expect(touched.map((e) => [e.id, e.status])).toEqual([[entry.id, 'undone']])
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(await pathExists(stray)).toBe(false) // a byte-for-byte duplicate of the file in Mods: nothing is lost
    expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
  })

  it('puts back the rest of an undo that crashed half way through a move back from another drive, and removes the copy in holding', async () => {
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
    expect(await pathExists(lastStep.to)).toBe(false)
  })

  it('an undo whose move back finished on disk before failing at opsDone marks that step reverted so a later update does not trap the entry', async () => {
    const ws = await backedUp()
    const lampA = await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    ws.gate.hooks.beforeOp = async (op, _i, request) => {
      if (request.reason !== 'undo' || op.op !== 'move' || !op.to.endsWith('lamp_b.package')) return undefined
      await rename(op.from, op.to)
      return `move ${op.from} -> ${op.to}: flush failed`
    }

    const first = await undo(ws.deps, moved.entry.id)
    ws.gate.hooks.beforeOp = undefined

    expect(first).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    if (first.status !== 'stopped-part-way') return
    expect(first.entry.steps.map((s) => s.state)).toEqual(['applied', 'reverted'])
    expect(first.detail).not.toContain(ws.root)

    // CurseForge updates the already-restored lamp_b before she clicks Undo again.
    await writeFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'updated by CurseForge')

    const second = await undo(ws.deps, moved.entry.id)

    expect(second).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await sha256File(join(ws.mods, 'BuildBuy', 'lamp_a.package'))).toBe(lampA)
    expect(await readFile(join(ws.mods, 'BuildBuy', 'lamp_b.package'), 'utf8')).toBe('updated by CurseForge')
  })

  it('an undo whose move back stopped with the file at both places settles on the next undo', async () => {
    const ws = await backedUp()
    const before = await snapshotTree(ws.simsFolder)
    const moved = await runAction(ws.deps, disablePlan(ws))
    if (moved.status !== 'done') throw new Error(moved.status)
    ws.gate.hooks.beforeOp = async (op, _i, request) => {
      if (request.reason !== 'undo' || op.op !== 'move' || !op.to.endsWith('lamp_b.package')) return undefined
      await copyFile(op.from, op.to)
      return 'the move back stopped'
    }
    const first = await undo(ws.deps, moved.entry.id)
    ws.gate.hooks.beforeOp = undefined
    expect(first).toMatchObject({ status: 'stopped-part-way', entry: { status: 'needs-attention' } })
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(true)

    const second = await undo(ws.deps, moved.entry.id)

    expect(second).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    expect(await pathExists(held(ws, 'hold-1', 'BuildBuy', 'lamp_b.package'))).toBe(false)
    expect((await listJournal(ws.deps))[0]!.status).toBe('undone')
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
