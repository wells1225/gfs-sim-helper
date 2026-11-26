// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { FiftyAnswer, FiftyFifty, ModGroup } from '../../shared/model.ts'
import { answer, begin } from './machine.ts'
import { makeGroups } from './testing.ts'

const INIT = { id: 's1', startedAt: '2026-11-24T12:00:00.000Z', folderPath: 'C:\\Sims 4' }

/** Answers like the game would: it crashes while the bad group is in Mods. */
function runToEnd(groups: ModGroup[], badId: string, from: FiftyFifty = begin(groups, INIT)): FiftyFifty {
  let state = from
  for (let guard = 0; state.phase !== 'found'; guard++) {
    if (guard > 20) throw new Error('the test did not end')
    // begin leaves the round waiting on CurseForge; the driver makes it awaiting-answer.
    state = { ...state, phase: 'awaiting-answer' }
    const given: FiftyAnswer = state.inMods.includes(badId) ? 'crashed' : 'worked'
    state = answer(state, given)
  }
  return state
}

function noOverlap(state: FiftyFifty): void {
  const all = [...state.parked, ...state.inMods, ...state.cleared]
  expect(new Set(all).size).toBe(all.length)
}

describe('begin', () => {
  it('starts with control round 0: sorts script groups first, then by label, and parks all groups', () => {
    const groups: ModGroup[] = [
      { ...makeGroups(1)[0]!, id: 'dir:b', label: 'Bravo' },
      { ...makeGroups(1)[0]!, id: 'dir:a', label: 'Alpha' },
      { ...makeGroups(1)[0]!, id: 'cf:1', label: 'Zed Script', hasScript: true },
      { ...makeGroups(1)[0]!, id: 'dir:c', label: 'charlie' },
      { ...makeGroups(1)[0]!, id: 'cf:2', label: 'Another Script', hasScript: true }
    ]
    const state = begin(groups, INIT)
    expect(state.suspects).toEqual(['cf:2', 'cf:1', 'dir:a', 'dir:b', 'dir:c'])
    expect(state.parked).toEqual(['cf:2', 'cf:1', 'dir:a', 'dir:b', 'dir:c'])
    expect(state.inMods).toEqual([])
    expect(state.phase).toBe('close-curseforge')
    expect(state.round).toBe(0)
    expect(state.roundsAtMost).toBe(4)
    expect(state.cleared).toEqual([])
    expect(state.culprit).toBeNull()
    expect(state.history).toEqual([])
    expect(state.groups).toEqual(groups)
    expect(state).toMatchObject(INIT)
  })

  it('with one group still runs control round 0 first', () => {
    const state = begin(makeGroups(1), INIT)
    expect(state.phase).toBe('close-curseforge')
    expect(state.round).toBe(0)
    expect(state.culprit).toBeNull()
    expect(state.parked).toEqual(['dir:g0'])
    expect(state.inMods).toEqual([])
    expect(state.roundsAtMost).toBe(1)
  })
})

/** Moves past control round 0 (which worked) into round 1 awaiting-answer. */
function atSplitRound1(groups: ModGroup[]): FiftyFifty {
  const afterControl = answer({ ...begin(groups, INIT), phase: 'awaiting-answer' }, 'worked')
  return { ...afterControl, phase: 'awaiting-answer' }
}

describe('answer', () => {
  it('stops when control round 0 still crashes with all mods set aside', () => {
    const s0 = { ...begin(makeGroups(5), INIT), phase: 'awaiting-answer' as const }
    const stopped = answer(s0, 'crashed')
    expect(stopped.phase).toBe('stopped')
    expect(stopped.culprit).toBeNull()
    expect(stopped.suspects).toEqual([])
    expect(stopped.parked).toEqual([])
    expect(stopped.inMods).toEqual([])
    expect(stopped.cleared).toEqual(s0.suspects)
    expect(stopped.history).toEqual([{ round: 0, parked: s0.parked, answer: 'crashed' }])
    noOverlap(stopped)
  })

  it('starts halving on round 1 when control round 0 worked', () => {
    const s0 = { ...begin(makeGroups(5, 2), INIT), phase: 'awaiting-answer' as const }
    const s1 = answer(s0, 'worked')
    expect(s1.round).toBe(1)
    expect(s1.phase).toBe('ready-to-test')
    expect(s1.suspects).toEqual(s0.suspects)
    expect(s1.parked).toEqual(s0.suspects.slice(0, 3))
    expect(s1.inMods).toEqual(s0.suspects.slice(3))
    expect(s1.cleared).toEqual([])
    expect(s1.history).toEqual([{ round: 0, parked: s0.parked, answer: 'worked' }])
    noOverlap(s1)
  })

  it('names the single group when control round 0 worked with 1 group', () => {
    const s0 = { ...begin(makeGroups(1), INIT), phase: 'awaiting-answer' as const }
    const found = answer(s0, 'worked')
    expect(found.phase).toBe('found')
    expect(found.culprit).toBe('dir:g0')
    expect(found.parked).toEqual(['dir:g0'])
    expect(found.inMods).toEqual([])
    expect(found.history).toEqual([{ round: 0, parked: ['dir:g0'], answer: 'worked' }])
  })

  it('names the bad group within ceil(log2 N) + 1 rounds for every N up to 200 and every position', () => {
    const misses: string[] = []
    for (let n = 1; n <= 200; n++) {
      const groups = makeGroups(n, 7)
      const start = begin(groups, INIT)
      const bound = Math.ceil(Math.log2(n)) + 1
      if (start.roundsAtMost !== bound) misses.push(`n=${n}: roundsAtMost ${start.roundsAtMost}`)
      for (const bad of groups) {
        const end = runToEnd(groups, bad.id, start)
        if (end.culprit !== bad.id || end.history.length > bound) {
          misses.push(`n=${n} bad=${bad.id}: named ${end.culprit} in ${end.history.length}`)
        }
      }
    }
    expect(misses).toEqual([])
  })

  it('takes exactly 7 rounds for 64 groups (control round + 6 splits)', () => {
    const groups = makeGroups(64, 5)
    for (const bad of [groups[0]!, groups[17]!, groups[63]!]) {
      const end = runToEnd(groups, bad.id)
      expect(end.history).toHaveLength(7)
      expect(end.round).toBe(6)
      expect(end.culprit).toBe(bad.id)
    }
  })

  it('crashed keeps the half in Mods as suspects and clears the parked half', () => {
    const s1 = atSplitRound1(makeGroups(8))
    const s2 = answer(s1, 'crashed')
    expect(s2.suspects).toEqual(s1.inMods)
    expect(s2.cleared).toEqual(s1.parked)
    expect(s2.round).toBe(2)
    expect(s2.phase).toBe('ready-to-test')
    expect(s2.parked).toEqual(s1.inMods.slice(0, 2))
    expect(s2.inMods).toEqual(s1.inMods.slice(2))
    expect(s2.history.at(-1)).toEqual({ round: 1, parked: s1.parked, answer: 'crashed' })
    noOverlap(s2)
  })

  it('worked keeps the parked half as suspects and clears the half in Mods', () => {
    const s1 = atSplitRound1(makeGroups(8))
    const s2 = answer(s1, 'worked')
    expect(s2.suspects).toEqual(s1.parked)
    expect(s2.cleared).toEqual(s1.inMods)
    noOverlap(s2)
  })

  it('not-sure repeats the same round and only adds to history', () => {
    const s0 = { ...begin(makeGroups(8), INIT), phase: 'awaiting-answer' as const }
    const s0Again = answer(s0, 'not-sure')
    expect({ ...s0Again, history: [] }).toEqual(s0)
    expect(s0Again.history).toEqual([{ round: 0, parked: s0.parked, answer: 'not-sure' }])

    const s1 = atSplitRound1(makeGroups(8))
    const s1Again = answer(s1, 'not-sure')
    expect({ ...s1Again, history: s1.history }).toEqual(s1)
    expect(s1Again.history.at(-1)).toEqual({ round: 1, parked: s1.parked, answer: 'not-sure' })
  })

  it('keeps script groups in the parked half first after narrowing', () => {
    const groups = makeGroups(16, 4) // g0, g4, g8, g12 are scripts
    const s1 = atSplitRound1(groups)
    expect(s1.parked.slice(0, 4)).toEqual(['dir:g0', 'dir:g4', 'dir:g8', 'dir:g12'])
    const s2 = answer(s1, 'worked')
    expect(s2.parked).toEqual(['dir:g0', 'dir:g4', 'dir:g8', 'dir:g12'])
  })

  it('never lets parked, inMods and cleared overlap, and every group is in one of them', () => {
    const groups = makeGroups(37, 3)
    const bad = groups[22]!.id
    let state = begin(groups, INIT)
    while (state.phase !== 'found') {
      state = { ...state, phase: 'awaiting-answer' }
      state = answer(state, state.inMods.includes(bad) ? 'crashed' : 'worked')
      noOverlap(state)
      if (state.phase !== 'found') {
        expect(new Set([...state.parked, ...state.inMods, ...state.cleared]).size).toBe(37)
      }
    }
    expect(state.parked).toEqual([bad])
    expect(state.inMods).toEqual([])
    expect(state.cleared).toHaveLength(36)
  })

  it('changes nothing unless the phase is awaiting-answer', () => {
    const base = begin(makeGroups(8), INIT)
    for (const phase of ['close-curseforge', 'ready-to-test', 'found', 'stopped'] as const) {
      const s = { ...base, phase }
      expect(answer(s, 'crashed')).toEqual(s)
    }
  })

  it('does not change the state it was given', () => {
    const s0 = { ...begin(makeGroups(8), INIT), phase: 'awaiting-answer' as const }
    const copy = structuredClone(s0)
    answer(s0, 'crashed')
    answer(s0, 'worked')
    answer(s0, 'not-sure')
    expect(s0).toEqual(copy)
  })
})
