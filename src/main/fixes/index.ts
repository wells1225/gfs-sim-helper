import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DisabledGroup,
  FixOutcome,
  FixRefusal,
  FixRequest,
  JournalEntry,
  JournalOrigin,
  ModFile,
  ModGroup,
  RelPath,
  Scan
} from '../../shared/model.ts'
import {
  CACHE_NAMES,
  type ActionPlan,
  type FixDeps,
  type GroupsOutcome,
  type OnProgress,
  type PlanFixAt,
  type PlannedStep
} from '../ports.ts'
import { DISABLE, holdingModPath } from './disable.ts'
import { editOptionsIni } from './options-ini.ts'

function normRelPath(relPath: string): string {
  return relPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase()
}

function isSafeRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.startsWith('\\') || relPath.includes(':')) {
    return false
  }
  const parts = relPath.replaceAll('\\', '/').split('/')
  return parts.length > 0 && parts.every((p) => p !== '' && p !== '.' && p !== '..')
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function stripTrailingSlash(name: string): string {
  return name.endsWith('/') ? name.slice(0, -1) : name
}

/**
 * Why a later group was refused, in the player's words. The words follow the titles and advice in
 * renderer/fixes/words.ts, but never say "nothing was changed": the groups before it did change.
 */
function refusalReasonWords(refusal: FixRefusal): string {
  switch (refusal.why) {
    case 'gate':
      switch (refusal.refusal.reason) {
        case 'game-running':
          return 'The Sims 4 is still open. Save and close the game, then try again.'
        case 'game-state-unknown':
          return 'We could not tell whether The Sims 4 is open. Make sure the game is closed, then try again.'
        case 'saves-or-tray':
          return 'Stopped to protect your saves. Your saves and households are never touched.'
        case 'outside-allowed-area':
          return 'Stopped because a file is outside your Mods folder. Fixes only touch your Mods folder, temporary caches, and game settings.'
        case 'link-escape':
          return 'Skipped a linked folder that points outside your Sims 4 folder.'
        case 'not-a-sims-folder':
          return 'That folder no longer looks like a Sims 4 folder.'
        case 'check-failed':
          return 'A safety check did not finish. Try again in a moment.'
        case 'no-verified-backup':
          return 'A safety copy is needed first. Please try again.'
      }
    case 'backup':
      switch (refusal.reason) {
        case 'game-running':
          return 'The Sims 4 is still open. Save and close the game, then try again.'
        case 'game-state-unknown':
          return 'We could not tell whether The Sims 4 is open. Make sure the game is closed, then try again.'
        case 'backup-folder-in-onedrive':
          return 'Your safety copy folder is synced by OneDrive, which can interrupt backups.'
        case 'backup-folder-in-sims-folder':
          return 'The safety copy cannot be kept inside your Sims 4 folder. Tell Tyler so he can fix the setup.'
        case 'not-enough-space':
          return 'There is not enough free disk space to make a safety copy first. Free up a little space, then try again.'
        case 'sims-folder-missing':
          return 'Your Sims 4 folder could not be found right now.'
        case 'backup-already-running':
          return 'A safety copy is already running. Wait a moment for it to finish, then try again.'
        case 'backup-failed':
          return 'The safety copy did not finish cleanly. Please try again.'
      }
    case 'out-of-date':
      switch (refusal.detail) {
        case 'no-scan':
          return 'Run a check-up first, then try again.'
        case 'unknown-finding':
          return 'This check-up is out of date. Run a fresh check-up to see what still needs fixing.'
        case 'unknown-group':
          return 'That mod is no longer in the list. Run a fresh check-up to refresh your mods list.'
        case 'file-changed':
          return 'Your files changed since the last check-up. Run a fresh check-up first.'
        case 'nothing-to-do':
          return 'The next one was already taken care of.'
      }
    case 'fifty-fifty-running':
      return 'A 50/50 test is in progress. Finish or stop it before making other changes to your mods.'
    case 'not-started':
      return "The next one didn't go through. Try again in a moment."
  }
}

/** The groups before the refused one stay as they now are, so say which way they went. */
function refusalDetail(refusal: FixRefusal, direction: 'set-aside' | 'put-back'): string {
  const done =
    direction === 'set-aside'
      ? 'The mods set aside before it stopped stay set aside, and you can put them back from History.'
      : 'The mods put back before it stopped are back in Mods. The rest are still set aside.'
  return `${refusalReasonWords(refusal)} ${done}`
}

/** Set aside one group: the plan for it, with its label and script flag for History and "Your mods". */
function groupPlan(
  group: ModGroup,
  at: { modsDir: string; holdingDir: string; entryId: string },
  origin: JournalOrigin,
  folderPath: string
): ActionPlan {
  return {
    entryId: at.entryId,
    action: 'disable-group',
    summary: `Set aside ${group.label}`,
    origin,
    folderPath,
    groupId: group.id,
    groupLabel: group.label,
    hasScript: group.hasScript,
    steps: DISABLE.plan(group, at)
  }
}

/**
 * A set-aside that stopped part way is undone at once, so no group is left half moved. When the undo works the
 * group is fully back: 'rolled-back'. So is a nothing-to-do answer, but only when no step of the stopped entry ran:
 * a guard: a moved file must never be called not-started (undo answers nothing-to-do only for a missing entry).
 * When it does not work (any other refusal, stopped, or threw), the entry stays needs-attention: the original
 * outcome stands, with the undo's entry and, when it has one, the undo's sentence.
 */
async function rollBackHalfDone(
  deps: FixDeps,
  outcome: Extract<FixOutcome, { status: 'stopped-part-way' }>,
  onProgress?: OnProgress
): Promise<'rolled-back' | Extract<FixOutcome, { status: 'stopped-part-way' }>> {
  let undone: FixOutcome
  try {
    undone = await deps.safety.undo(outcome.entry.id, onProgress)
  } catch {
    return outcome
  }
  if (undone.status === 'done') return 'rolled-back'
  if (
    undone.status === 'refused' &&
    undone.refusal.why === 'out-of-date' &&
    undone.refusal.detail === 'nothing-to-do' &&
    outcome.entry.steps.every((s) => s.state === 'pending')
  ) {
    return 'rolled-back'
  }
  // The undo ran last, so its sentence says what is true now (its files may all be back, say).
  if (undone.status === 'stopped-part-way') return { ...outcome, entry: undone.entry, detail: undone.detail || outcome.detail }
  return outcome
}

const NOT_STARTED: FixRefusal = { why: 'not-started' }

function summarizeSetAsideFiles(files: readonly ModFile[]): string {
  const n = files.length
  if (files.every((f) => f.kind === 'archive')) {
    return n === 1 ? 'Set aside 1 zipped file from Mods' : `Set aside ${n} zipped files from Mods`
  }
  if (
    files.every(
      (f) =>
        (f.kind === 'package' && f.dbpf.status === 'broken') ||
        (f.kind === 'script' && f.script.status === 'broken')
    )
  ) {
    return n === 1 ? 'Set aside 1 broken file from Mods' : `Set aside ${n} broken files from Mods`
  }
  if (files.every((f) => f.kind === 'package' && f.dbpf.status === 'wrong-game')) {
    return n === 1
      ? 'Set aside 1 wrong-game package from Mods'
      : `Set aside ${n} wrong-game packages from Mods`
  }
  return n === 1 ? 'Set aside 1 file from Mods' : `Set aside ${n} files from Mods`
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch {
    return false
  }
}

async function findExistingCaches(folderPath: string): Promise<string[]> {
  const found: string[] = []
  for (const cacheName of CACHE_NAMES) {
    const cleanName = stripTrailingSlash(cacheName)
    if (await pathExists(join(folderPath, cleanName))) {
      found.push(cacheName)
    }
  }
  return found
}

export function planFix(
  scan: Scan,
  request: FixRequest,
  at: PlanFixAt
): { status: 'planned'; plan: ActionPlan } | { status: 'refused'; refusal: FixRefusal } {
  const origin: JournalOrigin = { by: 'fix' }
  const folderPath = scan.folder.path
  const modsDir = scan.inventory.modsDir

  switch (request.fix) {
    case 'turn-mods-on': {
      // The edit is built only from the text read from disk: without it there is nothing safe to write.
      if (at.optionsText === undefined) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
      }
      const newText = editOptionsIni(at.optionsText)
      if (newText === at.optionsText) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      return {
        status: 'planned',
        plan: {
          entryId: at.entryId,
          action: 'turn-mods-on',
          summary: 'Turned mods and script mods back on',
          origin,
          folderPath,
          groupId: null,
          groupLabel: null,
          hasScript: false,
          // The UTF-8 round trip in applyFix makes these the very bytes it read.
          steps: [{ kind: 'edit', path: join(folderPath, 'Options.ini'), newText, beforeSha256: sha256Text(at.optionsText) }]
        }
      }
    }

    case 'move-script-up': {
      if (request.files.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      const fileMap = new Map<string, ModFile>()
      for (const file of scan.inventory.files) {
        fileMap.set(normRelPath(file.relPath), file)
      }
      const extraExisting = new Set((at.existingModPaths ?? []).map(normRelPath))
      const plannedDestinations = new Set<string>()
      const seenSources = new Set<string>()
      const steps: PlannedStep[] = []

      for (const relPath of request.files) {
        if (!isSafeRelPath(relPath)) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }
        const key = normRelPath(relPath)
        if (seenSources.has(key)) continue
        seenSources.add(key)

        const file = fileMap.get(key)
        if (!file) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }

        const parts = file.relPath.split('/')
        if (parts.length <= 2) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
        }

        const destRel = `${parts[0]!}/${parts[parts.length - 1]!}`
        const destKey = normRelPath(destRel)
        if (fileMap.has(destKey) || extraExisting.has(destKey) || plannedDestinations.has(destKey)) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }

        plannedDestinations.add(destKey)
        steps.push({
          kind: 'move',
          from: join(modsDir, ...parts),
          to: join(modsDir, parts[0]!, parts[parts.length - 1]!)
        })
      }

      if (steps.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      return {
        status: 'planned',
        plan: {
          entryId: at.entryId,
          action: 'move-script-up',
          summary:
            steps.length === 1
              ? 'Moved 1 script mod up a folder'
              : `Moved ${steps.length} script mods up a folder`,
          origin,
          folderPath,
          groupId: null,
          groupLabel: null,
          hasScript: false,
          steps
        }
      }
    }

    case 'set-aside-files': {
      if (request.files.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      const fileMap = new Map<string, ModFile>()
      for (const file of scan.inventory.files) {
        fileMap.set(normRelPath(file.relPath), file)
      }

      const seenSources = new Set<string>()
      const matchedFiles: ModFile[] = []
      const steps: PlannedStep[] = []

      for (const relPath of request.files) {
        if (!isSafeRelPath(relPath)) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }
        const key = normRelPath(relPath)
        if (seenSources.has(key)) continue
        seenSources.add(key)

        const file = fileMap.get(key)
        if (!file) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }
        matchedFiles.push(file)
        steps.push({
          kind: 'move',
          from: join(modsDir, ...file.relPath.split('/')),
          to: holdingModPath(at.holdingDir, at.entryId, file.relPath)
        })
      }

      if (steps.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      return {
        status: 'planned',
        plan: {
          entryId: at.entryId,
          action: 'set-aside-files',
          summary: summarizeSetAsideFiles(matchedFiles),
          origin,
          folderPath,
          groupId: null,
          groupLabel: null,
          hasScript: false,
          steps
        }
      }
    }

    case 'clear-caches': {
      const existingSet =
        at.existingCaches !== undefined
          ? new Set(at.existingCaches.map((name) => stripTrailingSlash(name).toLowerCase()))
          : null

      const steps: PlannedStep[] = []
      for (const cacheName of CACHE_NAMES) {
        const cleanName = stripTrailingSlash(cacheName)
        if (existingSet !== null && !existingSet.has(cleanName.toLowerCase())) {
          continue
        }
        steps.push({ kind: 'remove-cache', path: join(folderPath, cleanName) })
      }

      if (steps.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      return {
        status: 'planned',
        plan: {
          entryId: at.entryId,
          action: 'clear-caches',
          summary:
            steps.length === 1
              ? 'Cleared 1 temporary cache item'
              : `Cleared ${steps.length} temporary cache items`,
          origin,
          folderPath,
          groupId: null,
          groupLabel: null,
          hasScript: false,
          steps
        }
      }
    }

    case 'disable-group': {
      const group = scan.inventory.groups.find((g) => g.id === request.groupId)
      if (!group) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-group' } }
      }
      if (group.files.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }

      const fileSet = new Set(scan.inventory.files.map((f) => normRelPath(f.relPath)))
      for (const relPath of group.files) {
        if (!isSafeRelPath(relPath) || !fileSet.has(normRelPath(relPath))) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }
      }

      return {
        status: 'planned',
        plan: groupPlan(group, { modsDir, holdingDir: at.holdingDir, entryId: at.entryId }, origin, folderPath)
      }
    }

    case 'enable-group': {
      return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
    }
  }
}

export async function applyFix(
  deps: FixDeps,
  scan: Scan,
  request: FixRequest,
  onProgress?: OnProgress
): Promise<FixOutcome> {
  if (request.fix === 'enable-group') {
    const journal = await deps.safety.listJournal()
    const match = journal.find(
      (entry) =>
        entry.action === 'disable-group' &&
        entry.status === 'done' &&
        entry.groupId === request.groupId &&
        samePath(entry.folderPath, scan.folder.path)
    )
    if (!match) {
      return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-group' } }
    }
    return deps.safety.undo(match.id, onProgress)
  }

  if (request.fix === 'disable-group') {
    const journal = await deps.safety.listJournal()
    const alreadyDisabled = journal.some(
      (entry) =>
        entry.action === 'disable-group' &&
        entry.status === 'done' &&
        entry.groupId === request.groupId &&
        samePath(entry.folderPath, scan.folder.path)
    )
    if (alreadyDisabled) {
      return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
    }
  }

  const at: PlanFixAt = {
    holdingDir: deps.paths.holdingDir,
    entryId: deps.newId()
  }

  if (request.fix === 'turn-mods-on') {
    let bytes: Buffer
    try {
      bytes = await readFile(join(scan.folder.path, 'Options.ini'))
    } catch {
      return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
    }
    const text = bytes.toString('utf8')
    // Bytes that are not UTF-8 would not survive the round trip, so leave the file alone.
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
    }
    at.optionsText = text
  } else if (request.fix === 'clear-caches') {
    at.existingCaches = await findExistingCaches(scan.folder.path)
  } else if (request.fix === 'move-script-up') {
    const existingDestinations: RelPath[] = []
    for (const relPath of request.files) {
      if (!isSafeRelPath(relPath)) continue
      const parts = relPath.split('/')
      if (parts.length <= 2) continue
      const destRel = `${parts[0]!}/${parts[parts.length - 1]!}`
      const destNative = join(scan.inventory.modsDir, parts[0]!, parts[parts.length - 1]!)
      if (await pathExists(destNative)) {
        existingDestinations.push(destRel)
      }
    }
    if (existingDestinations.length > 0) {
      at.existingModPaths = existingDestinations
    }
  }

  const planned = planFix(scan, request, at)
  if (planned.status === 'refused') {
    return planned
  }

  const outcome = await deps.safety.runAction(planned.plan, onProgress)
  if (request.fix === 'disable-group' && outcome.status === 'stopped-part-way') {
    const rolled = await rollBackHalfDone(deps, outcome, onProgress)
    return rolled === 'rolled-back' ? { status: 'refused', refusal: NOT_STARTED } : rolled
  }
  return outcome
}

export async function setAside(
  deps: FixDeps,
  folderPath: string,
  groups: ModGroup[],
  origin: JournalOrigin,
  onProgress?: OnProgress
): Promise<GroupsOutcome> {
  if (groups.length === 0) {
    return { status: 'done', entries: [] }
  }

  const modsDir = join(folderPath, 'Mods')
  const entries: JournalEntry[] = []

  for (const group of groups) {
    if (group.files.length === 0) continue

    const at = { modsDir, holdingDir: deps.paths.holdingDir, entryId: deps.newId() }
    const outcome = await deps.safety.runAction(groupPlan(group, at, origin, folderPath), onProgress)

    if (outcome.status === 'done') {
      entries.push(outcome.entry)
      continue
    }

    if (outcome.status === 'refused') {
      if (entries.length === 0) {
        return { status: 'refused', refusal: outcome.refusal }
      }
      return {
        status: 'stopped-part-way',
        entries,
        detail: refusalDetail(outcome.refusal, 'set-aside')
      }
    }

    const rolled = await rollBackHalfDone(deps, outcome, onProgress)
    if (rolled === 'rolled-back') {
      // The half-moved group is fully back; only whole groups before it stay set aside.
      if (entries.length === 0) return { status: 'refused', refusal: NOT_STARTED }
      return { status: 'stopped-part-way', entries, detail: outcome.detail }
    }
    entries.push(rolled.entry)
    return { status: 'stopped-part-way', entries, detail: rolled.detail }
  }

  return { status: 'done', entries }
}

export async function putBack(
  deps: FixDeps,
  folderPath: string,
  groupIds: string[],
  onProgress?: OnProgress
): Promise<GroupsOutcome> {
  if (groupIds.length === 0) {
    return { status: 'done', entries: [] }
  }

  const journal = await deps.safety.listJournal()
  const entriesByGroup = new Map<string, JournalEntry[]>()
  for (const entry of journal) {
    if (
      entry.action === 'disable-group' &&
      entry.status === 'done' &&
      entry.groupId !== null &&
      samePath(entry.folderPath, folderPath)
    ) {
      const list = entriesByGroup.get(entry.groupId) ?? []
      list.push(entry)
      entriesByGroup.set(entry.groupId, list)
    }
  }

  const seenGroups = new Set<string>()
  const undoneEntries: JournalEntry[] = []

  for (const groupId of groupIds) {
    if (seenGroups.has(groupId)) continue
    seenGroups.add(groupId)

    const matching = entriesByGroup.get(groupId) ?? []
    for (const entry of matching) {
      const outcome = await deps.safety.undo(entry.id, onProgress)
      if (outcome.status === 'done') {
        undoneEntries.push(outcome.entry)
        continue
      }

      if (outcome.status === 'refused') {
        if (undoneEntries.length === 0) {
          return { status: 'refused', refusal: outcome.refusal }
        }
        return {
          status: 'stopped-part-way',
          entries: undoneEntries,
          detail: refusalDetail(outcome.refusal, 'put-back')
        }
      }

      undoneEntries.push(outcome.entry)
      return {
        status: 'stopped-part-way',
        entries: undoneEntries,
        detail: outcome.detail
      }
    }
  }

  return { status: 'done', entries: undoneEntries }
}

export async function clearCaches(deps: FixDeps, folderPath: string): Promise<FixOutcome> {
  const existing = await findExistingCaches(folderPath)
  if (existing.length === 0) {
    return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
  }

  const steps: PlannedStep[] = existing.map((cacheName) => ({
    kind: 'remove-cache',
    path: join(folderPath, stripTrailingSlash(cacheName))
  }))

  return deps.safety.runAction({
    entryId: deps.newId(),
    action: 'clear-caches',
    summary:
      steps.length === 1
        ? 'Cleared 1 temporary cache item'
        : `Cleared ${steps.length} temporary cache items`,
    origin: { by: 'fix' },
    folderPath,
    groupId: null,
    groupLabel: null,
    hasScript: false,
    steps
  })
}

export async function disabledGroups(deps: FixDeps, folderPath: string): Promise<DisabledGroup[]> {
  const journal = await deps.safety.listJournal()
  const seen = new Set<string>()
  const result: DisabledGroup[] = []

  for (const entry of journal) {
    if (
      entry.action !== 'disable-group' ||
      entry.status !== 'done' ||
      entry.groupId === null ||
      !samePath(entry.folderPath, folderPath)
    ) {
      continue
    }
    if (seen.has(entry.groupId)) continue
    seen.add(entry.groupId)

    result.push(disabledGroupOf(entry, entry.groupId))
  }

  return result
}

/** "Your mods" row for a done disable entry. The label is the entry's own, never cut out of its summary. */
export function disabledGroupOf(entry: JournalEntry, groupId: string): DisabledGroup {
  return {
    groupId,
    label: entry.groupLabel ?? 'A mod',
    entryId: entry.id,
    at: entry.at,
    origin: entry.origin.by
  }
}

function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}
