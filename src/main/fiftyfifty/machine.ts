import type { FiftyAnswer, FiftyFifty, IsoTime, ModGroup } from '../../shared/model.ts'

/** Script groups first, then by label; the id breaks ties so the order never depends on input order. */
function suspectOrder(groups: ModGroup[]): string[] {
  return [...groups]
    .sort((a, b) => {
      if (a.hasScript !== b.hasScript) return a.hasScript ? -1 : 1
      const byLabel = a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })
      if (byLabel !== 0) return byLabel
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((g) => g.id)
}

/** The first ceil(n/2) suspects go aside, the rest stay in Mods. One suspect left means it is named. */
function split(state: FiftyFifty, suspects: string[]): FiftyFifty {
  if (suspects.length === 1) {
    return { ...state, suspects, parked: [...suspects], inMods: [], culprit: suspects[0]!, phase: 'found' }
  }
  const half = Math.ceil(suspects.length / 2)
  return { ...state, suspects, parked: suspects.slice(0, half), inMods: suspects.slice(half) }
}

export function begin(
  groups: ModGroup[],
  init: { id: string; startedAt: IsoTime; folderPath: string }
): FiftyFifty {
  const fresh: FiftyFifty = {
    ...init,
    phase: 'close-curseforge',
    round: 1,
    roundsAtMost: Math.ceil(Math.log2(Math.max(groups.length, 1))),
    groups: [...groups],
    suspects: [],
    parked: [],
    inMods: [],
    cleared: [],
    culprit: null,
    history: []
  }
  return split(fresh, suspectOrder(groups))
}

export function answer(state: FiftyFifty, given: FiftyAnswer): FiftyFifty {
  if (state.phase !== 'awaiting-answer') return state

  const history = [...state.history, { round: state.round, parked: [...state.parked], answer: given }]
  if (given === 'not-sure') return { ...state, history }

  const [suspects, ruledOut] = given === 'crashed' ? [state.inMods, state.parked] : [state.parked, state.inMods]
  const next = split({ ...state, history, cleared: [...state.cleared, ...ruledOut] }, suspects)
  if (next.phase === 'found') return next
  return { ...next, round: state.round + 1, phase: 'ready-to-test' }
}
