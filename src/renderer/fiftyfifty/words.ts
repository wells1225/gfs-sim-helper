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
export const PART_WAY = 'Some mods were moved but not all. Click Try again to finish moving them.'

/** One plain sentence per refusal. Nothing was changed in any of these cases. */
export function refusalWords(refusal: FixRefusal): string {
  switch (refusal.why) {
    case 'gate':
      switch (refusal.refusal.reason) {
        case 'game-running':
          return 'The Sims 4 is still open. Save and close the game, then click Try again.'
        case 'game-state-unknown':
          return "We couldn't tell whether The Sims 4 is open, so nothing was moved. Close the game, then click Try again."
        case 'no-verified-backup':
          return 'We need a fresh safety copy before moving mods. Click Try again to make one.'
        default:
          return "Something about this folder doesn't look safe to change, so nothing was moved. Send a report to Tyler."
      }
    case 'backup':
      switch (refusal.reason) {
        case 'game-running':
          return 'The Sims 4 is still open. Save and close the game, then click Try again.'
        case 'not-enough-space':
          return "There isn't enough free space to make a safety copy first, so nothing was moved."
        case 'backup-already-running':
          return 'A safety copy is already being made. Wait a moment, then click Try again.'
        default:
          return "We couldn't make a safety copy first, so nothing was moved. Send a report to Tyler."
      }
    case 'out-of-date':
      switch (refusal.detail) {
        case 'no-scan':
          return 'Run the check-up first, then start the 50/50 test.'
        case 'file-changed':
          return 'Your mods changed since the check-up, so nothing was moved. Run the check-up again.'
        default:
          return 'There is nothing to do right now. Run the check-up again.'
      }
    case 'fifty-fifty-running':
      return 'A 50/50 test is already running.'
  }
}
