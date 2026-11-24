import type { FiftyAnswer, FiftyFifty, FiftyResult, FixOutcome, FixRefusal, Scan } from '../../shared/model.ts'
import type { AppContext, GroupsOutcome } from '../ports.ts'
import { answer, begin } from './machine.ts'
import { clearState, loadState, saveState } from './store.ts'

export { answer, begin } from './machine.ts'
export { loadState } from './store.ts'

export type FiftyDeps = Pick<AppContext, 'fixes' | 'gate' | 'paths' | 'clock' | 'newId' | 'host'>

/** A step that did not finish: the caller adds the state it was working on. */
export type Problem =
  | { status: 'refused'; refusal: FixRefusal }
  | { status: 'stopped-part-way'; detail: string }

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
 * Makes the disk match the wish: exactly `want` of this session's groups set aside, the rest in Mods.
 * It compares with what fixes reports as set aside, so running it twice moves nothing the second time.
 * Groups set aside before the test started are not in `state.groups` and are never touched.
 */
async function arrange(deps: FiftyDeps, state: FiftyFifty, want: string[]): Promise<Problem | null> {
  const ours = new Set(state.groups.map((g) => g.id))
  const aside = new Set(
    (await deps.fixes.disabledGroups(state.folderPath)).map((d) => d.groupId).filter((id) => ours.has(id))
  )
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

async function saveOrProblem(deps: FiftyDeps, state: FiftyFifty): Promise<FiftyResult> {
  const problem = await saveState(deps, state)
  return problem ? withState(problem, state) : { status: 'ok', state }
}

export async function start(deps: FiftyDeps, scan: Scan | null): Promise<FiftyResult> {
  if (!scan) return { status: 'refused', refusal: { why: 'out-of-date', detail: 'no-scan' } }
  if (scan.inventory.groups.length === 0) return NO_SESSION

  const running = await loadState(deps)
  if (running) return { status: 'ok', state: running }

  const state = begin(scan.inventory.groups, {
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

  const caches = await deps.fixes.clearCaches(state.folderPath)
  const nothingToClear =
    caches.status === 'refused' && caches.refusal.why === 'out-of-date' && caches.refusal.detail === 'nothing-to-do'
  const cleared = nothingToClear ? null : groupsProblem(caches)
  if (cleared) return withState(cleared, state)

  return saveOrProblem(deps, { ...state, phase: 'awaiting-answer' })
}

export async function giveAnswer(deps: FiftyDeps, given: FiftyAnswer): Promise<FiftyResult> {
  const state = await loadState(deps)
  if (!state) return NO_SESSION
  if (state.phase !== 'awaiting-answer') return { status: 'ok', state }

  const next = answer(state, given)
  const problem = await saveState(deps, next)
  if (problem) return withState(problem, next)
  if (next.phase === 'found') return { status: 'ok', state: next }
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
  const state = await loadState(deps)
  if (!state) return { status: 'ok', state: null }
  return endWith(deps, state, [])
}

export async function finish(deps: FiftyDeps, keep: 'keep-set-aside' | 'put-back'): Promise<FiftyResult> {
  const state = await loadState(deps)
  if (!state || state.phase !== 'found' || !state.culprit) return NO_SESSION
  return endWith(deps, state, keep === 'keep-set-aside' ? [state.culprit] : [])
}
