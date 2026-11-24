import type { FiftyAnswer, FiftyFifty, FiftyResult, FixOutcome, FixRefusal, Scan } from '../../shared/model.ts'
import type { AppContext, GroupsOutcome } from '../ports.ts'
import { answer, begin } from './machine.ts'
import { clearState, loadState, readSaved, saveState } from './store.ts'

export { answer, begin } from './machine.ts'
export { loadState } from './store.ts'

export type FiftyDeps = Pick<AppContext, 'fixes' | 'safety' | 'gate' | 'paths' | 'clock' | 'newId' | 'host'>

/** A step that did not finish: the caller adds the state it was working on. */
export type Problem =
  | { status: 'refused'; refusal: FixRefusal }
  | { status: 'stopped-part-way'; detail: string }

/**
 * `fifty:get` fails with this in its message when the progress file is there but cannot be read. The contract's
 * answer (`FiftyFifty | null`) has no room for it, so the screens look for the same words in the failure.
 */
export const PROGRESS_DAMAGED = 'fifty-progress-damaged'

const NO_SESSION: FiftyResult = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }

function withState(problem: Problem, state: FiftyFifty): FiftyResult {
  return problem.status === 'refused' ? problem : { ...problem, state }
}

function groupsProblem(outcome: GroupsOutcome | FixOutcome): Problem | null {
  if (outcome.status === 'done') return null
  if (outcome.status === 'refused') return { status: 'refused', refusal: outcome.refusal }
  return { status: 'stopped-part-way', detail: outcome.detail }
}

/** G1 settles CurseForge's real process name. A list that cannot be read does not block. */
async function curseForgeOpen(deps: FiftyDeps): Promise<boolean> {
  try {
    const names = await deps.host.listProcesses()
    return names.some((name) => name.toLowerCase().startsWith('curseforge'))
  } catch {
    return false
  }
}

/**
 * Which of this session's groups the test has set aside right now. A group she set aside herself
 * (origin 'fix') is hers even when it is one of the session's groups, and is never counted or put back.
 */
async function sessionAside(deps: FiftyDeps, state: FiftyFifty): Promise<Set<string>> {
  const ours = new Set(state.groups.map((g) => g.id))
  const off = await deps.fixes.disabledGroups(state.folderPath)
  return new Set(off.filter((d) => d.origin === 'fifty-fifty' && ours.has(d.groupId)).map((d) => d.groupId))
}

/** A group with no files is never moved, so it cannot tell us anything. */
async function arrangedAsSaved(deps: FiftyDeps, state: FiftyFifty): Promise<boolean> {
  const aside = await sessionAside(deps, state)
  const parked = new Set(state.parked)
  return state.groups.every((g) => g.files.length === 0 || aside.has(g.id) === parked.has(g.id))
}

/**
 * Makes the disk match the wish: exactly `want` of this session's groups set aside, the rest in Mods.
 * It compares with what fixes reports as set aside, so running it twice moves nothing the second time.
 * Groups set aside before the test started are not in `state.groups` and are never touched.
 */
async function arrange(deps: FiftyDeps, state: FiftyFifty, want: string[]): Promise<Problem | null> {
  const aside = await sessionAside(deps, state)
  const wanted = new Set(want)

  const toPutBack = [...aside].filter((id) => !wanted.has(id))
  if (toPutBack.length > 0) {
    const problem = groupsProblem(await deps.fixes.putBack(state.folderPath, toPutBack))
    if (problem) return problem
  }

  const byId = new Map(state.groups.map((g) => [g.id, g]))
  const toSetAside = want.filter((id) => !aside.has(id)).flatMap((id) => byId.get(id) ?? [])
  if (toSetAside.length > 0) {
    const origin = { by: 'fifty-fifty', sessionId: state.id, round: state.round } as const
    const problem = groupsProblem(await deps.fixes.setAside(state.folderPath, toSetAside, origin))
    if (problem) return problem
  }
  return null
}

/** "Nothing to clear" is fine: the caches were already gone. */
async function clearCachesProblem(deps: FiftyDeps, folderPath: string): Promise<Problem | null> {
  const caches = await deps.fixes.clearCaches(folderPath)
  const nothingToClear =
    caches.status === 'refused' && caches.refusal.why === 'out-of-date' && caches.refusal.detail === 'nothing-to-do'
  return nothingToClear ? null : groupsProblem(caches)
}

/** What `fifty:get` answers: the session or null, and a failure naming PROGRESS_DAMAGED for a damaged file. */
export async function getState(deps: FiftyDeps): Promise<FiftyFifty | null> {
  const saved = await readSaved(deps)
  if (saved.kind === 'damaged') throw new Error(PROGRESS_DAMAGED)
  return saved.kind === 'session' ? saved.state : null
}

/**
 * The way out when the progress file is damaged: put back every group the test set aside, in every folder a
 * test ever ran on, clear the caches, then remove the file. A group she set aside herself (origin 'fix') is
 * never touched. The file goes last, so anything that does not finish leaves it there and stop can be tried again.
 */
async function stopDamaged(deps: FiftyDeps, savedFolder: string | null): Promise<FiftyResult> {
  const folders = new Set<string>(savedFolder ? [savedFolder] : [])
  try {
    for (const entry of await deps.safety.listJournal()) {
      if (entry.origin.by === 'fifty-fifty') folders.add(entry.folderPath)
    }
  } catch {
    return { status: 'refused', refusal: { why: 'not-started' } }
  }

  for (const folderPath of folders) {
    const off = await deps.fixes.disabledGroups(folderPath)
    const ours = off.filter((d) => d.origin === 'fifty-fifty').map((d) => d.groupId)
    const moved = ours.length > 0 ? groupsProblem(await deps.fixes.putBack(folderPath, ours)) : null
    const problem = moved ?? (await clearCachesProblem(deps, folderPath))
    if (problem) return damagedProblem(problem)
  }

  const problem = await clearState(deps)
  return problem ? damagedProblem(problem) : { status: 'ok', state: null }
}

/** `stopped-part-way` needs a session to hand back and a damaged file has none, so a half-done step fails the call. */
function damagedProblem(problem: Problem): FiftyResult {
  if (problem.status === 'refused') return problem
  throw new Error(`The 50/50 put-back stopped part way: ${problem.detail}`)
}

async function saveOrProblem(deps: FiftyDeps, state: FiftyFifty): Promise<FiftyResult> {
  const problem = await saveState(deps, state)
  return problem ? withState(problem, state) : { status: 'ok', state }
}

export async function start(deps: FiftyDeps, scan: Scan | null): Promise<FiftyResult> {
  if (!scan) return { status: 'refused', refusal: { why: 'out-of-date', detail: 'no-scan' } }

  const saved = await readSaved(deps)
  // Starting over a damaged file would forget the groups the last test set aside. Stop puts them back first.
  if (saved.kind === 'damaged') return { status: 'refused', refusal: { why: 'fifty-fifty-running' } }
  if (saved.kind === 'session' && saved.state.phase !== 'stopped') return { status: 'ok', state: saved.state }

  // The scan can be older than a switch in "Your mods": a group already set aside is hers, not the test's.
  const off = new Set((await deps.fixes.disabledGroups(scan.folder.path)).map((d) => d.groupId))
  const groups = scan.inventory.groups.filter((g) => !off.has(g.id))
  if (groups.length === 0) return NO_SESSION

  const state = begin(groups, {
    id: deps.newId(),
    startedAt: deps.clock.now().toISOString(),
    folderPath: scan.folder.path
  })
  return saveOrProblem(deps, state)
}

export async function beginRound(deps: FiftyDeps): Promise<FiftyResult> {
  const saved = await loadState(deps)
  if (!saved) return NO_SESSION
  if (saved.phase === 'found' || saved.phase === 'stopped') return { status: 'ok', state: saved }

  if (await curseForgeOpen(deps)) {
    if (saved.phase === 'close-curseforge') return { status: 'ok', state: saved }
    return saveOrProblem(deps, { ...saved, phase: 'close-curseforge' })
  }

  // 'ready-to-test' is saved before any file moves, so a restart part way lands back here.
  let state = saved
  if (state.phase === 'close-curseforge') {
    state = { ...state, phase: 'ready-to-test' }
    const problem = await saveState(deps, state)
    if (problem) return withState(problem, state)
  }

  const moved = await arrange(deps, state, state.parked)
  if (moved) return withState(moved, state)

  const cleared = await clearCachesProblem(deps, state.folderPath)
  if (cleared) return withState(cleared, state)

  const nextPhase = state.culprit !== null ? 'found' : 'awaiting-answer'
  return saveOrProblem(deps, { ...state, phase: nextPhase })
}

export async function giveAnswer(
  deps: FiftyDeps,
  given: FiftyAnswer,
  expectedRound?: number
): Promise<FiftyResult> {
  const state = await loadState(deps)
  if (!state) return NO_SESSION
  if (state.phase !== 'awaiting-answer') return { status: 'ok', state }
  if (expectedRound !== undefined && state.round !== expectedRound) return { status: 'ok', state }

  const next = answer(state, given)
  // An answer only means something for the files as the round set them up. A stop cut off after it put the
  // mods back, or an undo from History, leaves them otherwise: set the round up again instead of counting it.
  // The answer that ends the test is left out: it only puts mods back, and a half-done put-back is retried here.
  if (next.phase !== 'stopped' && !(await arrangedAsSaved(deps, state))) {
    return saveOrProblem(deps, { ...state, phase: 'ready-to-test' })
  }
  if (next.phase === 'stopped') {
    const moved = await arrange(deps, state, [])
    if (moved) return withState(moved, state)
    const problem = await clearState(deps)
    return problem ? withState(problem, state) : { status: 'ok', state: next }
  }
  // When the culprit is named, save ready-to-test first so beginRound arranges [culprit] before marking found.
  const toSave = next.phase === 'found' ? { ...next, phase: 'ready-to-test' as const } : next
  const problem = await saveState(deps, toSave)
  if (problem) return withState(problem, toSave)
  return beginRound(deps)
}

async function endWith(deps: FiftyDeps, state: FiftyFifty, keep: string[]): Promise<FiftyResult> {
  const moved = await arrange(deps, state, keep)
  if (moved) return withState(moved, state)
  const ended: FiftyFifty = { ...state, phase: 'stopped', parked: keep, inMods: [] }
  const problem = await clearState(deps)
  return problem ? withState(problem, state) : { status: 'ok', state: ended }
}

export async function stop(deps: FiftyDeps): Promise<FiftyResult> {
  const saved = await readSaved(deps)
  if (saved.kind === 'damaged') return stopDamaged(deps, saved.folderPath)
  if (saved.kind === 'none') return { status: 'ok', state: null }
  return endWith(deps, saved.state, [])
}

export async function finish(deps: FiftyDeps, keep: 'keep-set-aside' | 'put-back'): Promise<FiftyResult> {
  const state = await loadState(deps)
  if (!state || state.phase !== 'found' || !state.culprit) return NO_SESSION
  return endWith(deps, state, keep === 'keep-set-aside' ? [state.culprit] : [])
}
