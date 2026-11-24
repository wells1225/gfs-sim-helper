import type { FiftyAnswer, FiftyFifty, IsoTime, ModGroup } from '../../shared/model.ts'

export function begin(
  _groups: ModGroup[],
  _init: { id: string; startedAt: IsoTime; folderPath: string }
): FiftyFifty {
  throw new Error('not implemented: begin')
}

export function answer(_state: FiftyFifty, _given: FiftyAnswer): FiftyFifty {
  throw new Error('not implemented: answer')
}
