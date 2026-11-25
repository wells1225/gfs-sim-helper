import type { ShareReceiveResult } from '../../shared/model.ts'
import type { ShareDeps } from './index.ts'

/** PR 14 (unit C, Fable): the only code that plans a write into the saves folder. Stubs until then. */
export async function receiveSave(
  _deps: ShareDeps,
  _what: { shareId: string; seq: number; olderGame: 'stop' | 'go' }
): Promise<ShareReceiveResult> {
  throw new Error('not implemented: receiveSave')
}

/** The same swap as receiveSave: the current file to Old saves, the chosen old copy to the slot. */
export async function restoreOldSave(_deps: ShareDeps, _oldId: string): Promise<ShareReceiveResult> {
  throw new Error('not implemented: restoreOldSave')
}
