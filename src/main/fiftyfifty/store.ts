import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FiftyFifty, FiftyPhase } from '../../shared/model.ts'
import type { AppContext, WriteOp } from '../ports.ts'
import type { Problem } from './index.ts'

type StoreDeps = Pick<AppContext, 'gate' | 'paths'>

const PHASES: readonly FiftyPhase[] = ['close-curseforge', 'ready-to-test', 'awaiting-answer', 'found', 'stopped']

/** PR 10 reads this file's `phase` to refuse fixes while a test runs, so the name and shape are fixed. */
export function stateFile(deps: Pick<AppContext, 'paths'>): string {
  return join(deps.paths.stateDir, 'fiftyfifty.json')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
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
    Number.isInteger(s['roundsAtMost']) &&
    Array.isArray(s['groups']) &&
    (s['groups'] as unknown[]).every((g) => typeof g === 'object' && g !== null && typeof (g as { id?: unknown }).id === 'string') &&
    isStringArray(s['suspects']) &&
    isStringArray(s['parked']) &&
    isStringArray(s['inMods']) &&
    isStringArray(s['cleared']) &&
    (s['culprit'] === null || typeof s['culprit'] === 'string') &&
    Array.isArray(s['history'])
  )
}

/** No file, or one that cannot be read as a session, is no session. History still lists every move. */
export async function loadState(deps: Pick<AppContext, 'paths'>): Promise<FiftyFifty | null> {
  let text: string
  try {
    text = await readFile(stateFile(deps), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return looksLikeState(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function runState(deps: StoreDeps, ops: WriteOp[]): Promise<Problem | null> {
  const result = await deps.gate.run({ reason: 'state', folderPath: null, ops })
  if (result.status === 'done') return null
  if (result.status === 'refused') return { status: 'refused', refusal: { why: 'gate', refusal: result.refusal } }
  return { status: 'stopped-part-way', detail: `Could not save the 50/50 progress: ${result.detail}` }
}

export async function saveState(deps: StoreDeps, state: FiftyFifty): Promise<Problem | null> {
  // Only the folders that are missing, so the gate never sees a mkdir of a folder that exists.
  const ops: WriteOp[] = []
  for (const dir of [deps.paths.dataDir, deps.paths.stateDir]) {
    if (!(await exists(dir))) ops.push({ op: 'mkdir', path: dir })
  }
  ops.push({ op: 'write', path: stateFile(deps), data: JSON.stringify(state, null, 2), mode: 'replace' })
  return runState(deps, ops)
}

export async function clearState(deps: StoreDeps): Promise<Problem | null> {
  if (!(await exists(stateFile(deps)))) return null
  return runState(deps, [{ op: 'remove', path: stateFile(deps) }])
}
