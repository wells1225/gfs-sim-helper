import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { FixOutcome, FixRefusal, JournalEntry, JournalStep, Sha256 } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { ActionPlan, GateResult, OnProgress, SafetyDeps, WriteOp } from '../ports.ts'
import { backupStatus, makeBackup, tracked } from './backup.ts'
import { readEntry, removeEntry, saveEntry } from './journal.ts'
import { exists, isSafeId, missingDirs, pathKey } from './where.ts'

type BackupFirst = { status: 'ok'; backupId: string } | { status: 'refused'; refusal: FixRefusal }

/** A backup comes first, in one place: runAction and undo both start here. */
export async function backupFirst(deps: SafetyDeps, folderPath: string, onProgress: OnProgress | undefined): Promise<BackupFirst> {
  const status = await backupStatus(deps, folderPath)
  if (status.state === 'verified') return { status: 'ok', backupId: status.backupId }
  const made = await tracked(deps, () => makeBackup(deps, folderPath, onProgress))
  if (made.status === 'verified') return { status: 'ok', backupId: made.record.id }
  return { status: 'refused', refusal: { why: 'backup', reason: made.status === 'refused' ? made.reason : 'backup-failed' } }
}

function sha256Of(data: Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex')
}

async function fileHash(path: string): Promise<Sha256 | null> {
  try {
    const info = await lstat(path)
    return info.isFile() ? await sha256File(path) : null
  } catch {
    return null
  }
}

const OUT_OF_DATE: FixOutcome = { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
/** The journal entry could not be written, so no change was started. */
const NOT_STARTED: FixOutcome = { status: 'refused', refusal: { why: 'not-started' } }

/** Each planned step as a pending journal step, or null when the disk no longer matches the plan. */
async function journalSteps(
  deps: SafetyDeps,
  plan: ActionPlan,
  entryId: string
): Promise<{ steps: JournalStep[]; editData: Map<number, Uint8Array> } | null> {
  if (!isSafeId(entryId)) return null
  const steps: JournalStep[] = []
  const editData = new Map<number, Uint8Array>()
  const savedNames = new Set<string>()
  const seenFrom = new Set<string>()
  const seenTo = new Set<string>()
  const seenEdit = new Set<string>()
  for (const planned of plan.steps) {
    if (planned.kind === 'move') {
      const fromKey = pathKey(planned.from)
      const toKey = pathKey(planned.to)
      if (seenFrom.has(fromKey) || seenTo.has(toKey) || seenTo.has(fromKey) || seenFrom.has(toKey)) return null
      seenFrom.add(fromKey)
      seenTo.add(toKey)
      const info = await lstat(planned.from).catch(() => null)
      if (!info?.isFile() || (await exists(planned.to))) return null
      steps.push({ kind: 'move', from: planned.from, to: planned.to, bytes: info.size, sha256: await sha256File(planned.from), state: 'pending' })
    } else if (planned.kind === 'edit') {
      const editKey = pathKey(planned.path)
      if (seenEdit.has(editKey)) return null
      seenEdit.add(editKey)
      const before = await fileHash(planned.path)
      // The planner built newText from the file as it read it. Changed since then: the edit would undo that change.
      if (before === null || before !== planned.beforeSha256) return null
      const data = new TextEncoder().encode(planned.newText)
      let name = basename(planned.path)
      for (let n = 2; savedNames.has(name.toLowerCase()); n += 1) {
        const ext = extname(planned.path)
        name = `${basename(planned.path, ext)}-${n}${ext}`
      }
      savedNames.add(name.toLowerCase())
      const savedCopy = join(deps.paths.holdingDir, entryId, 'edits', name)
      if (await exists(savedCopy)) return null
      editData.set(steps.length, data)
      steps.push({ kind: 'edit', path: planned.path, savedCopy, beforeSha256: before, afterSha256: sha256Of(data), state: 'pending' })
    } else {
      steps.push({ kind: 'remove-cache', path: planned.path, state: 'pending' })
    }
  }
  return { steps, editData }
}

/** What the disk says about one step: still to undo, already back (or never ran), or neither. */
type StepOnDisk = { where: 'done' } | { where: 'not-done' } | { where: 'unclear'; file: string }

async function inspect(step: JournalStep): Promise<StepOnDisk> {
  if (step.kind === 'move') {
    const [atTo, toTaken, atFrom, fromTaken] = await Promise.all([
      fileHash(step.to),
      exists(step.to),
      fileHash(step.from),
      exists(step.from)
    ])
    if (atTo === step.sha256 && !fromTaken) return { where: 'done' }
    // The original is in place. A second, identical file at `to` is what a move to another drive leaves when it is
    // cut off after the copy and before the source is removed: nothing to put back, and the copy is left alone.
    if (atFrom === step.sha256 && (!toTaken || atTo === step.sha256)) return { where: 'not-done' }
    return { where: 'unclear', file: fromTaken && atFrom !== step.sha256 ? step.from : step.to }
  }
  if (step.kind === 'edit') {
    const now = await fileHash(step.path)
    if (now === step.beforeSha256) return { where: 'not-done' }
    if (now === step.afterSha256) return { where: 'done' }
    return { where: 'unclear', file: step.path }
  }
  return (await exists(step.path)) ? { where: 'not-done' } : { where: 'done' }
}

function saveError(result: GateResult): string {
  if (result.status === 'refused') return `Could not update the journal entry: refused (${result.refusal.reason})`
  if (result.status === 'failed') return `Could not update the journal entry: ${result.detail}`
  return ''
}

export async function runActionNow(deps: SafetyDeps, plan: ActionPlan, onProgress?: OnProgress): Promise<FixOutcome> {
  if (plan.steps.length === 0) return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
  const backup = await backupFirst(deps, plan.folderPath, onProgress)
  if (backup.status === 'refused') return backup

  const id = plan.entryId
  const built = await journalSteps(deps, plan, id)
  if (!built) return OUT_OF_DATE
  const entry: JournalEntry = {
    id,
    at: deps.clock.now().toISOString(),
    action: plan.action,
    summary: plan.summary,
    origin: plan.origin,
    folderPath: plan.folderPath,
    groupId: plan.groupId,
    groupLabel: plan.groupLabel,
    hasScript: plan.hasScript,
    backupId: backup.backupId,
    steps: built.steps,
    status: 'in-progress',
    undo: built.steps.every((s) => s.kind === 'remove-cache') ? 'cannot-undo' : 'can-undo',
    undoneAt: null
  }

  const written = await saveEntry(deps, entry, 'create')
  if (written.status === 'refused') return { status: 'refused', refusal: { why: 'gate', refusal: written.refusal } }
  if (written.status === 'failed') return NOT_STARTED

  const ops: WriteOp[] = []
  const lastOp: number[] = []
  const planned = new Set<string>()
  for (const [i, step] of entry.steps.entries()) {
    if (step.kind === 'move') {
      for (const dir of await missingDirs(dirname(step.to), planned)) ops.push({ op: 'mkdir', path: dir })
      ops.push({ op: 'move', from: step.from, to: step.to })
    } else if (step.kind === 'edit') {
      for (const dir of await missingDirs(dirname(step.savedCopy), planned)) ops.push({ op: 'mkdir', path: dir })
      ops.push({ op: 'copy', from: step.path, to: step.savedCopy })
      ops.push({ op: 'write', path: step.path, data: built.editData.get(i)!, mode: 'replace' })
    } else {
      // Always send remove through the gate so game/backup/zone checks run; removing a missing cache is done.
      ops.push({ op: 'remove', path: step.path })
    }
    lastOp.push(ops.length - 1)
  }

  onProgress?.({ task: 'fix', stage: 'moving', done: 0, total: entry.steps.length })
  let result: GateResult
  try {
    result = await deps.gate.run({ reason: 'fix', folderPath: plan.folderPath, ops })
  } catch (err) {
    // We cannot know which ops ran: ask the disk, and treat unclear steps as applied so undo still checks them.
    for (const step of entry.steps) if ((await inspect(step)).where !== 'not-done') step.state = 'applied'
    result = { status: 'failed', opsDone: -1, detail: (err as Error).message }
  }

  if (result.status === 'refused') {
    await removeEntry(deps, entry.id)
    return { status: 'refused', refusal: { why: 'gate', refusal: result.refusal } }
  }
  if (result.status === 'failed') {
    if (result.opsDone >= 0) {
      for (const [i, step] of entry.steps.entries()) if (lastOp[i]! < result.opsDone) step.state = 'applied'
    }
    entry.status = 'needs-attention'
    await saveEntry(deps, entry, 'replace')
    return { status: 'stopped-part-way', entry, detail: result.detail }
  }
  for (const step of entry.steps) step.state = 'applied'
  entry.status = 'done'
  const saved = await saveEntry(deps, entry, 'replace')
  if (saved.status !== 'done') {
    entry.status = 'needs-attention'
    return { status: 'stopped-part-way', entry, detail: saveError(saved) }
  }
  onProgress?.({ task: 'fix', stage: 'moving', done: entry.steps.length, total: entry.steps.length })
  return { status: 'done', entry }
}

/**
 * Puts an entry's changes back, last step first, after asking the disk what each step did. Stops at the first file
 * that is neither where the action put it nor back where it was, and never overwrites anything.
 */
export async function revert(deps: SafetyDeps, entry: JournalEntry, onProgress?: OnProgress): Promise<FixOutcome> {
  const backup = await backupFirst(deps, entry.folderPath, onProgress)
  if (backup.status === 'refused') return backup

  // An entry left in-progress with every step still pending crashed during runAction: probe every step first so
  // no moved or unclear step is left pending if the reverse loop stops early. An in-progress entry that already has
  // applied or reverted steps crashed during undo, so pending steps are already known never to have run.
  const cutOffAction = entry.status === 'in-progress' && entry.steps.every((s) => s.state === 'pending')
  const inspected = new Map<number, StepOnDisk>()
  if (cutOffAction) {
    for (const [i, step] of entry.steps.entries()) {
      const onDisk = await inspect(step)
      inspected.set(i, onDisk)
      if (step.kind === 'remove-cache') {
        if (onDisk.where === 'done') step.state = 'applied'
      } else if (onDisk.where !== 'not-done') {
        step.state = 'applied'
      }
    }
  }

  const ops: WriteOp[] = []
  const toRevert: { index: number; lastOp: number }[] = []
  const planned = new Set<string>()
  let problem: string | null = null
  for (let i = entry.steps.length - 1; i >= 0; i -= 1) {
    const step = entry.steps[i]!
    if (step.kind === 'remove-cache' || step.state !== 'applied') continue
    const onDisk = inspected.get(i) ?? (await inspect(step))
    if (onDisk.where === 'not-done') {
      step.state = 'reverted'
      continue
    }
    if (onDisk.where === 'unclear') {
      problem = onDisk.file
      break
    }
    if (step.kind === 'move') {
      for (const dir of await missingDirs(dirname(step.from), planned)) ops.push({ op: 'mkdir', path: dir })
      ops.push({ op: 'move', from: step.to, to: step.from })
    } else {
      const saved = await readFile(step.savedCopy).catch(() => null)
      if (!saved || sha256Of(saved) !== step.beforeSha256) {
        problem = step.savedCopy
        break
      }
      ops.push({ op: 'write', path: step.path, data: new Uint8Array(saved), mode: 'replace' })
    }
    toRevert.push({ index: i, lastOp: ops.length - 1 })
  }

  const statusBefore = entry.status
  let detail: string | null = problem ? `This file is not as the change left it: ${problem}` : null
  if (ops.length > 0) {
    // Marked in-progress first, so a crash during the undo is finished by recover() on the next start.
    entry.status = 'in-progress'
    const marked = await saveEntry(deps, entry, 'replace')
    if (marked.status !== 'done') {
      entry.status = statusBefore
      if (marked.status === 'refused') return { status: 'refused', refusal: { why: 'gate', refusal: marked.refusal } }
      return NOT_STARTED
    }
    onProgress?.({ task: 'fix', stage: 'moving', done: 0, total: toRevert.length })
    let result: GateResult
    try {
      result = await deps.gate.run({ reason: 'undo', folderPath: entry.folderPath, ops })
    } catch (err) {
      result = { status: 'failed', opsDone: -1, detail: (err as Error).message }
    }
    if (result.status === 'refused') {
      entry.status = statusBefore
      await saveEntry(deps, entry, 'replace')
      return { status: 'refused', refusal: { why: 'gate', refusal: result.refusal } }
    }
    for (const { index, lastOp } of toRevert) {
      const step = entry.steps[index]!
      const ran = result.status === 'done' || (result.opsDone >= 0 ? lastOp < result.opsDone : (await inspect(step)).where === 'not-done')
      if (!ran) continue
      // Undo checks what it put back.
      if ((await inspect(step)).where === 'not-done') step.state = 'reverted'
      else detail ??= `This file did not come back as it was: ${step.kind === 'move' ? step.from : step.kind === 'edit' ? step.path : ''}`
    }
    if (result.status === 'failed') detail ??= result.detail
  }

  const allBack = entry.steps.every((s) => s.kind === 'remove-cache' || s.state !== 'applied')
  if (detail === null && allBack) {
    entry.status = 'undone'
    entry.undoneAt = deps.clock.now().toISOString()
  } else {
    entry.status = 'needs-attention'
    detail ??= 'Some files could not be put back.'
  }
  const saved = await saveEntry(deps, entry, 'replace')
  if (saved.status !== 'done') {
    entry.status = 'needs-attention'
    return { status: 'stopped-part-way', entry, detail: detail ?? saveError(saved) }
  }
  onProgress?.({ task: 'fix', stage: 'moving', done: toRevert.length, total: toRevert.length })
  return detail === null ? { status: 'done', entry } : { status: 'stopped-part-way', entry, detail }
}

const NOTHING_TO_DO: FixOutcome = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }

export async function undoNow(deps: SafetyDeps, entryId: string, onProgress?: OnProgress): Promise<FixOutcome> {
  const entry = await readEntry(deps.paths.journalDir, entryId)
  if (!entry) return NOTHING_TO_DO
  if (entry.status === 'undone') return { status: 'done', entry } // before the backup step: no gate request at all
  if (entry.undo === 'cannot-undo') return NOTHING_TO_DO
  return await revert(deps, entry, onProgress)
}

/** A cache clear cannot be undone: the next start only records how far it got. */
async function settleCacheClear(deps: SafetyDeps, entry: JournalEntry): Promise<JournalEntry | null> {
  for (const step of entry.steps) if ((await inspect(step)).where === 'done') step.state = 'applied'
  entry.status = entry.steps.every((s) => s.state === 'applied') ? 'done' : 'needs-attention'
  const saved = await saveEntry(deps, entry, 'replace')
  return saved.status === 'done' ? entry : null
}

export async function recoverNow(deps: SafetyDeps, entries: JournalEntry[]): Promise<JournalEntry[]> {
  const touched: JournalEntry[] = []
  for (const entry of entries) {
    if (entry.status !== 'in-progress') continue
    if (entry.undo === 'cannot-undo') {
      const settled = await settleCacheClear(deps, entry)
      if (settled) touched.push(settled)
      continue
    }
    let outcome: FixOutcome
    try {
      outcome = await revert(deps, entry)
    } catch {
      continue // settling this one threw (its backup could not start, say): left in progress, the others get their turn
    }
    if (outcome.status === 'refused') continue // left in progress: the next start tries again
    touched.push(outcome.entry)
  }
  return touched
}
