import type {
  DisabledGroup,
  FixOutcome,
  FixRefusal,
  FixRequest,
  JournalOrigin,
  ModGroup,
  Scan
} from '../../shared/model.ts'
import type { ActionPlan, FixDeps, GroupsOutcome, OnProgress } from '../ports.ts'

export function planFix(
  _scan: Scan,
  _request: FixRequest,
  _at: { holdingDir: string; entryId: string }
): { status: 'planned'; plan: ActionPlan } | { status: 'refused'; refusal: FixRefusal } {
  throw new Error('not implemented: planFix')
}

export async function applyFix(
  _deps: FixDeps,
  _scan: Scan,
  _request: FixRequest,
  _onProgress?: OnProgress
): Promise<FixOutcome> {
  throw new Error('not implemented: applyFix')
}

export async function setAside(
  _deps: FixDeps,
  _folderPath: string,
  _groups: ModGroup[],
  _origin: JournalOrigin,
  _onProgress?: OnProgress
): Promise<GroupsOutcome> {
  throw new Error('not implemented: setAside')
}

export async function putBack(
  _deps: FixDeps,
  _folderPath: string,
  _groupIds: string[],
  _onProgress?: OnProgress
): Promise<GroupsOutcome> {
  throw new Error('not implemented: putBack')
}

export async function clearCaches(_deps: FixDeps, _folderPath: string): Promise<FixOutcome> {
  throw new Error('not implemented: clearCaches')
}

export async function disabledGroups(_deps: FixDeps, _folderPath: string): Promise<DisabledGroup[]> {
  throw new Error('not implemented: disabledGroups')
}
