import type { FiftyFifty, FixRefusal } from '../../shared/model.ts'

export function groupsWord(n: number): string {
  return n === 1 ? '1 mod group' : `${n} mod groups`
}

export function roundsWord(n: number): string {
  return n === 1 ? '1 round' : `${n} rounds`
}

export function expectedRounds(groups: number): number {
  return Math.ceil(Math.log2(Math.max(groups, 1))) + 1
}

export function displayRound(round: number): number {
  return round + 1
}

export function isControlRound(state: Pick<FiftyFifty, 'round'>): boolean {
  return state.round === 0
}

export function isNotModsResult(state: Pick<FiftyFifty, 'phase' | 'history'>): boolean {
  return state.phase === 'stopped' && state.history.some((h) => h.round === 0 && h.answer === 'crashed')
}

export function isUncertainResult(state: Pick<FiftyFifty, 'phase' | 'history'>): boolean {
  if (state.phase !== 'found') return false
  const splitAnswers = state.history.filter((h) => h.round > 0 && h.answer !== 'not-sure')
  return splitAnswers.length > 0 && splitAnswers.every((h) => h.answer === 'crashed')
}

export function roundOf(state: Pick<FiftyFifty, 'round' | 'roundsAtMost'>): string {
  const current = displayRound(state.round)
  return `Round ${current} of about ${Math.max(state.roundsAtMost, current)}`
}

export function roundHeader(state: FiftyFifty): string {
  if (isControlRound(state)) return `${roundOf(state)} · testing without mods`
  return `${roundOf(state)} · ${groupsWord(state.suspects.length)} left`
}

export function groupLabel(state: FiftyFifty, id: string | null): string {
  return state.groups.find((g) => g.id === id)?.label ?? 'this mod group'
}

export const STOP_QUESTION = 'Stop the 50/50 test and put all your mods back?'
export const STOP_CONFIRM = 'Put everything back and stop'
export const ALL_BACK = 'All your mods are back in place.'
export const CURSEFORGE_OPEN =
  'CurseForge still looks open. Close it, and check the little arrow by the clock in case it is still running there.'
/** `again` names the way to retry where the words are shown: the 50/50 screen has a Try again button, the banner does not. */
export function partWayWords(again = 'click Try again'): string {
  return `Some mods were moved but not all. To finish moving them, ${again}. If that does not finish it, you can put them back from History.`
}
export const PART_WAY = partWayWords()

/** One plain sentence or two per refusal. */
export function refusalWords(refusal: FixRefusal, again = 'click Try again'): string {
  const gameOpen = `The Sims 4 is still open. Save and close the game, then ${again}.`
  const gameUnknown = `We couldn't tell whether The Sims 4 is open, so nothing was moved. Close the game, then ${again}.`
  switch (refusal.why) {
    case 'gate':
      switch (refusal.refusal.reason) {
        case 'game-running':
          return gameOpen
        case 'game-state-unknown':
          return gameUnknown
        case 'no-verified-backup':
          return `We need a fresh safety copy before moving mods, so nothing was moved. Please ${again}.`
        case 'check-failed':
          return `Something got in the way of a safety check, so nothing was moved. Wait a moment, then ${again}.`
        default:
          return "Something about this folder doesn't look safe to change, so nothing was moved. Send a report to Tyler."
      }
    case 'backup':
      switch (refusal.reason) {
        case 'game-running':
          return gameOpen
        case 'game-state-unknown':
          return gameUnknown
        case 'not-enough-space':
          return "There isn't enough free space to make a safety copy first, so nothing was moved."
        case 'backup-already-running':
          return `A safety copy is already being made. Wait a moment, then ${again}.`
        default:
          return "We couldn't make a safety copy first, so nothing was moved. Send a report to Tyler."
      }
    case 'out-of-date':
      switch (refusal.detail) {
        case 'no-scan':
          return 'Run the check-up first, then start the 50/50 test.'
        case 'file-changed':
          // Only a round being set up gets this, and a new check-up does not change the groups the test saved.
          return "Some of your mod files changed since the test started, so we can't set up this round. Stop the test to put your mods back, then run the check-up and start a new test."
        default:
          return 'There is nothing to do right now. Run the check-up again.'
      }
    case 'fifty-fifty-running':
      return 'A 50/50 test is already running.'
  }
}
