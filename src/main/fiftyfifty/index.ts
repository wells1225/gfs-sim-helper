import type { FiftyAnswer, FiftyFifty, FiftyResult, IsoTime, ModGroup, Scan } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'

export type FiftyDeps = Pick<AppContext, 'fixes' | 'gate' | 'paths' | 'clock' | 'newId' | 'host'>

export function begin(
  _groups: ModGroup[],
  _init: { id: string; startedAt: IsoTime; folderPath: string }
): FiftyFifty {
  throw new Error('not implemented: begin')
}

export function answer(_state: FiftyFifty, _given: FiftyAnswer): FiftyFifty {
  throw new Error('not implemented: answer')
}

export async function loadState(_deps: FiftyDeps): Promise<FiftyFifty | null> {
  throw new Error('not implemented: loadState')
}

export async function start(_deps: FiftyDeps, _scan: Scan): Promise<FiftyResult> {
  throw new Error('not implemented: start')
}

export async function beginRound(_deps: FiftyDeps): Promise<FiftyResult> {
  throw new Error('not implemented: beginRound')
}

export async function giveAnswer(_deps: FiftyDeps, _given: FiftyAnswer): Promise<FiftyResult> {
  throw new Error('not implemented: giveAnswer')
}

export async function stop(_deps: FiftyDeps): Promise<FiftyResult> {
  throw new Error('not implemented: stop')
}

export async function finish(_deps: FiftyDeps, _keep: 'keep-set-aside' | 'put-back'): Promise<FiftyResult> {
  throw new Error('not implemented: finish')
}
