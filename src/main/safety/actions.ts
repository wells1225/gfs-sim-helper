import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { FixOutcome, FixRefusal, JournalEntry, JournalStep, Sha256 } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { ActionPlan, GateResult, OnProgress, SafetyDeps, WriteOp } from '../ports.ts'
import { backupStatus, makeBackup, tracked } from './backup.ts'
import { readEntry, removeEntry, removeEntryIfSame, saveEntry } from './journal.ts'
import { exists, isInside, isSafeId, missingDirs, pathKey, samePath } from './where.ts'

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

const ACTION_STOPPED = 'This change stopped part way through. You can undo what already moved from History.'
const UNDO_STOPPED = 'Some files could not be put back. You can try Undo again.'
// Caches are safe to lose: the game makes them again. So a cache clear that stops part way is settled, not undone.
const CACHE_STOPPED = 'Some temporary cache files were cleared before it stopped. That is safe: the game makes them again.'
const ACTION_HISTORY_NOT_SAVED = 'The files changed, but the app could not save your History record.'
// Only used when every file is back (any file not back sets its own detail first), so it says so.
const UNDO_HISTORY_NOT_SAVED = 'Your files are back as they were, but the app could not save this to History.'

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

/**
 * What the disk says about one step: still to undo, already back (or never ran), back with a copy of it left where
 * the action put it, or none of these.
 */
type StepOnDisk =
  | { where: 'done' }
  | { where: 'not-done' }
  | { where: 'copy-left'; file: string }
  | { where: 'unclear'; file: string }

async function inspect(step: JournalStep): Promise<StepOnDisk> {
  if (step.kind === 'move') {
    const [atTo, toTaken, atFrom, fromTaken] = await Promise.all([
      fileHash(step.to),
      exists(step.to),
      fileHash(step.from),
      exists(step.from)
    ])
    if (atTo === step.sha256 && !fromTaken) return { where: 'done' }
    if (atFrom === step.sha256 && !toTaken) return { where: 'not-done' }
    // The original is in place, and a second, identical file sits at `to`: what a move to another drive leaves when
    // it is cut off after the copy and before the source is removed. Nothing to move, but the step is not finished
    // until that copy is gone: see removeCopiesLeft.
    if (atFrom === step.sha256 && atTo === step.sha256) return { where: 'copy-left', file: step.to }
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

/** Every step still pending, and the disk shows none of them ran: a change that never started. Reads only. */
async function neverRan(entry: JournalEntry): Promise<boolean> {
  if (!entry.steps.every((s) => s.state === 'pending')) return false
  for (const step of entry.steps) if ((await inspect(step)).where !== 'not-done') return false
  return true
}

// Letter case as the gate may ignore it: A to Z and nothing else.
const fold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/**
 * True only when `from` leads to its own name inside the real Mods folder: the same names below the place the
 * Sims folder really is, with no link on the way. A folder in Mods swapped for a link (into a backup, say) leads
 * somewhere else, and the file there is not hers to rely on. Only the part below the Sims folder is compared,
 * since the Sims folder itself may be reached through a link or a short 8.3 name.
 */
async function fromLeadsToItsOwnName(folderPath: string, from: string): Promise<boolean> {
  const sims = folderPath.length > 1 && folderPath.endsWith(sep) ? folderPath.slice(0, -1) : folderPath
  if (fold(from.slice(0, sims.length)) !== fold(sims)) return false
  const below = from.slice(sims.length)
  const parts = below.split(sep)
  // below is '<sep>Mods<sep>...<sep>name': an empty first part, Mods, then at least one name.
  if (parts[0] !== '' || parts.length < 3 || fold(parts[1]!) !== 'mods' || parts.some((p, i) => i > 0 && p === '')) {
    return false
  }
  try {
    const [realSims, realFrom] = await Promise.all([realpath(sims), realpath(from)])
    return fold(realFrom) === fold(realSims + below)
  } catch {
    return false
  }
}

/**
 * True only when `file` leads to its own name strictly inside the real `holdingDir` (no link on the way), does not
 * resolve to the same real path as `step.from`, and `step.from` leads to its own name in the real Mods folder. Hard
 * links (same-drive interrupted moves) have two distinct real paths and still pass; a symlink escaping to backupsDir,
 * crossing into another holding entry, or leading back to Mods never passes, and neither does a file in Mods reached
 * through a link.
 */
async function isHoldingCopy(
  deps: SafetyDeps,
  entry: JournalEntry,
  step: Extract<JournalStep, { kind: 'move' }>,
  file: string
): Promise<boolean> {
  if (!isInside(file, deps.paths.holdingDir) || samePath(file, deps.paths.holdingDir)) return false
  const holding =
    deps.paths.holdingDir.length > 1 && deps.paths.holdingDir.endsWith(sep)
      ? deps.paths.holdingDir.slice(0, -1)
      : deps.paths.holdingDir
  if (fold(file.slice(0, holding.length)) !== fold(holding)) return false
  const below = file.slice(holding.length)
  const parts = below.split(sep)
  if (parts[0] !== '' || parts.length < 2 || parts.some((p, i) => i > 0 && (p === '' || p === '.' || p === '..'))) {
    return false
  }
  try {
    const [realFile, realHolding, realFrom] = await Promise.all([
      realpath(file),
      realpath(holding),
      realpath(step.from)
    ])
    if (fold(realFile) !== fold(realHolding + below) || samePath(realFile, realFrom)) return false
  } catch {
    return false
  }
  return await fromLeadsToItsOwnName(entry.folderPath, step.from)
}

/**
 * Removes each copy that copy-left steps left in the app's holding folder, through the gate, as its own app-data
 * request so a refusal or failure on one never blocks the others. Each copy is hashed again just before: only a
 * file byte for byte the same as the one back in Mods is removed, so nothing is lost, and the file in Mods is
 * never touched. A copy anywhere else (a move inside Mods), one through a link escaping holding, one that
 * differs, or one whose removal is refused, fails or throws is kept. Returns the detail for the first step that
 * is not back, or null when every one is.
 */
async function removeCopiesLeft(deps: SafetyDeps, entry: JournalEntry, indexes: number[]): Promise<string | null> {
  let detail: string | null = null
  for (const index of indexes) {
    const step = entry.steps[index]!
    const now = await inspect(step)
    if (now.where === 'not-done') {
      step.state = 'reverted'
      continue
    }
    if (step.kind !== 'move' || now.where !== 'copy-left') {
      detail ??= notBack(deps, entry, step, now)
      continue
    }
    if (!(await isHoldingCopy(deps, entry, step, now.file))) {
      // A file in Mods reached through a link is not back as it was, whatever its bytes: say so, not "back".
      detail ??= (await fromLeadsToItsOwnName(entry.folderPath, step.from))
        ? notBack(deps, entry, step, now)
        : notBack(deps, entry, step, { where: 'done' })
      continue
    }
    try {
      await deps.gate.run({ reason: 'undo', folderPath: entry.folderPath, ops: [{ op: 'remove', path: now.file }] })
    } catch {
      // What ran is read from the disk below.
    }
    const after = await inspect(step)
    if (after.where === 'not-done') step.state = 'reverted'
    else detail ??= notBack(deps, entry, step, after)
  }
  return detail
}

/** Says where the copy is only when the path proves it: kept by the app, or in her Mods folder. Never a path. */
function copyLeftDetail(deps: SafetyDeps, entry: JournalEntry, file: string): string {
  const name = basename(file)
  if (isInside(file, deps.paths.holdingDir) && !samePath(file, deps.paths.holdingDir)) {
    return `This file is back where it was, and the app kept a spare copy of it to be safe: ${name}`
  }
  const mods = join(entry.folderPath, 'Mods')
  if (isInside(file, mods) && !samePath(file, mods)) {
    return `This file is back where it was, and an extra copy is still in your Mods folder (${name}). The app left it there to be safe.`
  }
  return `This file is back where it was, and an extra copy of it was left where the change put it (${name}). The app left it there to be safe.`
}

/** What History says about a step whose file is not back. Never includes full paths or raw error text. */
function notBack(deps: SafetyDeps, entry: JournalEntry, step: JournalStep, onDisk: StepOnDisk): string {
  if (onDisk.where === 'copy-left') return copyLeftDetail(deps, entry, onDisk.file)
  if (onDisk.where === 'unclear') return `This file is not as the change left it: ${basename(onDisk.file)}`
  return `This file did not come back as it was: ${basename(step.kind === 'move' ? step.from : step.path)}`
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
  if (written.status === 'failed') {
    // A create can fail after the file got its name. Left there, the next start would put back a change that never
    // ran and History would say "undone". Only this very entry is taken back, never an older one with the same id.
    // If the take-back fails too, the entry is in progress with every step pending: the next start sees it never ran.
    await removeEntryIfSame(deps, entry)
    return NOT_STARTED
  }

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
    // If this fails, the entry stays in progress with every step pending: the next start sees it never ran.
    await removeEntry(deps, entry.id)
    return { status: 'refused', refusal: { why: 'gate', refusal: result.refusal } }
  }
  if (result.status === 'failed' && entry.undo === 'cannot-undo') return await stoppedCacheClear(deps, entry)
  if (result.status === 'failed') {
    if (result.opsDone >= 0) {
      for (const [i, step] of entry.steps.entries()) if (lastOp[i]! < result.opsDone) step.state = 'applied'
      // The step holding op opsDone may have run in part (a move: its file at the source, at both, or at the target).
      // Ask the disk, and count it applied unless it surely did not run, as the gate-throws path does.
      const cutOff = entry.steps.findIndex((_, i) => lastOp[i]! >= result.opsDone)
      const step = entry.steps[cutOff]
      if (step && (await inspect(step)).where !== 'not-done') step.state = 'applied'
    }
    entry.status = 'needs-attention'
    await saveEntry(deps, entry, 'replace')
    return { status: 'stopped-part-way', entry, detail: ACTION_STOPPED }
  }
  for (const step of entry.steps) step.state = 'applied'
  entry.status = 'done'
  const saved = await saveEntry(deps, entry, 'replace')
  if (saved.status !== 'done') {
    entry.status = 'needs-attention'
    return { status: 'stopped-part-way', entry, detail: ACTION_HISTORY_NOT_SAVED }
  }
  onProgress?.({ task: 'fix', stage: 'moving', done: entry.steps.length, total: entry.steps.length })
  return { status: 'done', entry }
}

/** What History says about the steps undo skipped: each file by its name alone, and nothing else. */
function skippedDetail(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `This file is not as the change left it: ${names[0]}`
  return `These files are not as the change left them: ${names.join(', ')}`
}

/**
 * Puts an entry's changes back, last step first, after asking the disk what each step did. A file that is neither
 * where the action put it nor back where it was (a newer download in Mods, say) is skipped and left alone, and the
 * rest is put back. Never overwrites anything. The entry then needs attention, and names only the skipped files.
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
  const skipped: { index: number; name: string }[] = []
  const copiesLeft: number[] = []
  for (let i = entry.steps.length - 1; i >= 0; i -= 1) {
    const step = entry.steps[i]!
    if (step.kind === 'remove-cache' || step.state !== 'applied') continue
    const onDisk = inspected.get(i) ?? (await inspect(step))
    if (onDisk.where === 'not-done') {
      step.state = 'reverted'
      continue
    }
    if (onDisk.where === 'copy-left') {
      copiesLeft.push(i) // the original is back: the rest of the undo goes on, and the copy is seen to after it
      continue
    }
    if (onDisk.where === 'unclear') {
      skipped.push({ index: i, name: basename(onDisk.file) }) // left alone: the rest of the undo goes on
      continue
    }
    if (step.kind === 'move') {
      for (const dir of await missingDirs(dirname(step.from), planned)) ops.push({ op: 'mkdir', path: dir })
      ops.push({ op: 'move', from: step.to, to: step.from })
    } else {
      const saved = await readFile(step.savedCopy).catch(() => null)
      if (!saved || sha256Of(saved) !== step.beforeSha256) {
        skipped.push({ index: i, name: basename(step.path) })
        continue
      }
      ops.push({ op: 'write', path: step.path, data: new Uint8Array(saved), mode: 'replace' })
    }
    toRevert.push({ index: i, lastOp: ops.length - 1 })
  }

  const statusBefore = entry.status
  let detail = skippedDetail(skipped.sort((a, b) => a.index - b.index).map((s) => s.name))
  let undoFailed = false
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
    const cutOffIndex =
      result.status === 'failed' && result.opsDone >= 0
        ? toRevert.find((r) => r.lastOp >= result.opsDone)?.index
        : undefined
    for (const { index, lastOp } of toRevert) {
      const step = entry.steps[index]!
      const completed = result.status === 'done' || (result.opsDone >= 0 && lastOp < result.opsDone)
      const uncertain = result.status === 'failed' && (result.opsDone < 0 || index === cutOffIndex)
      if (!completed && !uncertain) continue
      // Undo checks what it put back, including the step at opsDone which may have finished or left a copy.
      const after = await inspect(step)
      if (after.where === 'not-done') step.state = 'reverted'
      else if (after.where === 'copy-left' && result.status === 'done') copiesLeft.push(index)
      else if (after.where === 'copy-left') detail ??= copyLeftDetail(deps, entry, after.file)
      else if (completed || after.where === 'unclear') detail ??= notBack(deps, entry, step, after)
    }
    if (result.status === 'failed') {
      // After an undo request that failed, the copies are left for the next undo, which looks at the disk afresh.
      undoFailed = true
      const firstCopy = copiesLeft.length > 0 ? entry.steps[copiesLeft[0]!] : undefined
      if (firstCopy?.kind === 'move') detail ??= copyLeftDetail(deps, entry, firstCopy.to)
      detail ??= UNDO_STOPPED
    }
  }

  if (copiesLeft.length > 0 && !undoFailed) {
    const left = await removeCopiesLeft(deps, entry, copiesLeft)
    if (left !== null) detail ??= left
  }

  const allBack = entry.steps.every((s) => s.kind === 'remove-cache' || s.state !== 'applied')
  if (detail === null && allBack) {
    entry.status = 'undone'
    entry.undoneAt = deps.clock.now().toISOString()
  } else {
    entry.status = 'needs-attention'
    detail ??= UNDO_STOPPED
  }
  const saved = await saveEntry(deps, entry, 'replace')
  if (saved.status !== 'done') {
    entry.status = 'needs-attention'
    return { status: 'stopped-part-way', entry, detail: detail ?? UNDO_HISTORY_NOT_SAVED }
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

/**
 * A cache clear cannot be undone, and there is nothing to put back: the game makes its caches again. So one that
 * stopped or was cut off is settled as done, with each step marked by what the disk shows, and never left needing
 * attention. Returns the entry, or null when it could not be saved (it stays in progress for the next start).
 */
async function settleCacheClear(deps: SafetyDeps, entry: JournalEntry): Promise<JournalEntry | null> {
  for (const step of entry.steps) if ((await inspect(step)).where === 'done') step.state = 'applied'
  entry.status = 'done'
  const saved = await saveEntry(deps, entry, 'replace')
  return saved.status === 'done' ? entry : null
}

/** A cache clear whose gate request failed. One that cleared nothing never ran: its entry is taken back. */
async function stoppedCacheClear(deps: SafetyDeps, entry: JournalEntry): Promise<FixOutcome> {
  if (await neverRan(entry)) {
    // If this removal fails, the entry stays in progress with every step pending, and the next start sees the same.
    await removeEntry(deps, entry.id)
    return NOT_STARTED
  }
  const settled = await settleCacheClear(deps, entry)
  // Not saved: the entry on disk is still in progress, and the next start settles it the same way.
  return { status: 'stopped-part-way', entry: settled ?? entry, detail: CACHE_STOPPED }
}

export async function recoverNow(deps: SafetyDeps, entries: JournalEntry[]): Promise<JournalEntry[]> {
  const touched: JournalEntry[] = []
  for (const entry of entries) {
    if (entry.status !== 'in-progress') continue
    // In progress with every step pending and the disk as it was: the change never ran. A refused or failed start
    // whose take-back failed leaves exactly this, and so does a crash before the first op. There is nothing to put
    // back and nothing to tell her: the entry is taken back, or left as it is for the next start if that fails.
    let untouched: boolean
    try {
      untouched = await neverRan(entry)
    } catch {
      continue
    }
    if (untouched) {
      await removeEntry(deps, entry.id)
      continue
    }
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
