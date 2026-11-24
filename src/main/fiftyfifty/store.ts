import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FiftyAnswer, FiftyFifty, FiftyPhase } from '../../shared/model.ts'
import type { AppContext, WriteOp } from '../ports.ts'
import type { Problem } from './index.ts'

type StoreDeps = Pick<AppContext, 'gate' | 'paths'>

const PHASES: readonly FiftyPhase[] = ['close-curseforge', 'ready-to-test', 'awaiting-answer', 'found', 'stopped']
const ANSWERS: readonly FiftyAnswer[] = ['crashed', 'worked', 'not-sure']

/** PR 10 reads this file's `phase` to refuse fixes while a test runs, so the name and shape are fixed. */
export function stateFile(deps: Pick<AppContext, 'paths'>): string {
  return join(deps.paths.stateDir, 'fiftyfifty.json')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function looksLikeGroup(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const g = value as Record<string, unknown>
  return typeof g['id'] === 'string' && typeof g['label'] === 'string' && isStringArray(g['files'])
}

function looksLikeHistoryEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const h = value as Record<string, unknown>
  return (
    Number.isInteger(h['round']) &&
    (h['round'] as number) >= 0 &&
    isStringArray(h['parked']) &&
    ANSWERS.includes(h['answer'] as FiftyAnswer)
  )
}

function looksLikeState(value: unknown): value is FiftyFifty {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s['id'] === 'string' &&
    typeof s['startedAt'] === 'string' &&
    typeof s['folderPath'] === 'string' &&
    PHASES.includes(s['phase'] as FiftyPhase) &&
    Number.isInteger(s['round']) &&
    (s['round'] as number) >= 0 &&
    Number.isInteger(s['roundsAtMost']) &&
    (s['roundsAtMost'] as number) >= 0 &&
    Array.isArray(s['groups']) &&
    (s['groups'] as unknown[]).every(looksLikeGroup) &&
    isStringArray(s['suspects']) &&
    isStringArray(s['parked']) &&
    isStringArray(s['inMods']) &&
    isStringArray(s['cleared']) &&
    (s['culprit'] === null || typeof s['culprit'] === 'string') &&
    Array.isArray(s['history']) &&
    (s['history'] as unknown[]).every(looksLikeHistoryEntry)
  )
}

/** What is on disk: no file, a session, or a file that is there but cannot be read as one. */
export type Saved =
  | { kind: 'none' }
  | { kind: 'session'; state: FiftyFifty }
  | { kind: 'damaged'; folderPath: string | null } // folderPath: the Sims folder, when the file still says

/**
 * PR 10 refuses her switches while this file is there and does not plainly say the test is over. So a file
 * that cannot be read as a session is 'damaged', never 'none': 'none' would leave her with no way out.
 */
export async function readSaved(deps: Pick<AppContext, 'paths'>): Promise<Saved> {
  let text: string
  try {
    text = await readFile(stateFile(deps), 'utf8')
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    return missing ? { kind: 'none' } : { kind: 'damaged', folderPath: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'damaged', folderPath: null }
  }
  if (looksLikeState(parsed)) return { kind: 'session', state: parsed }
  const folderPath = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['folderPath'] : null
  return { kind: 'damaged', folderPath: typeof folderPath === 'string' && folderPath.length > 0 ? folderPath : null }
}

/** The session, or null when there is none to continue. A damaged file is null here: only `readSaved` tells. */
export async function loadState(deps: Pick<AppContext, 'paths'>): Promise<FiftyFifty | null> {
  const saved = await readSaved(deps)
  return saved.kind === 'session' ? saved.state : null
}

async function runState(deps: StoreDeps, ops: WriteOp[]): Promise<Problem | null> {
  const result = await deps.gate.run({ reason: 'state', folderPath: null, ops })
  if (result.status === 'done') return null
  if (result.status === 'refused') return { status: 'refused', refusal: { why: 'gate', refusal: result.refusal } }
  return { status: 'stopped-part-way', detail: `Could not save the 50/50 progress: ${result.detail}` }
}

export async function saveState(deps: StoreDeps, state: FiftyFifty): Promise<Problem | null> {
  // Gate section 5: mkdir creates parents and succeeds if the folder exists; replace creates a missing file.
  return runState(deps, [
    { op: 'mkdir', path: deps.paths.stateDir },
    { op: 'write', path: stateFile(deps), data: JSON.stringify(state, null, 2), mode: 'replace' }
  ])
}

export async function clearState(deps: StoreDeps): Promise<Problem | null> {
  // Gate section 5: remove of a missing path counts as done.
  return runState(deps, [{ op: 'remove', path: stateFile(deps) }])
}
