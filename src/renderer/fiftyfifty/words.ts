import type { FiftyDamaged, FiftyFifty, FiftyGet, FixRefusal, JournalEntry } from '../../shared/model.ts'

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
/** For a card with no Try again button: its stop button is the way to try again. */
export const STOP_AGAIN = `click ${STOP_CONFIRM} again`

/** `fifty:get` answered that fiftyfifty.json is there but cannot be read. A session has no `status`. */
export function isProgressDamaged(got: FiftyGet): got is FiftyDamaged {
  return got !== null && 'status' in got
}
export const DAMAGED_TITLE = "The 50/50 test's progress file is damaged"
export const DAMAGED_WHY =
  "We can't tell where the test got to, so other fixes are paused. Putting everything back moves every mod the test set aside into your Mods folder again. After that you can start a new test."
export const DAMAGED_NOT_FINISHED = `We couldn't finish putting your mods back. Wait a moment, then ${STOP_AGAIN}. If that does not finish it, you can put them back from History.`
/**
 * A stop on a damaged file that ended part way. History cannot put mods back while the file is damaged (its undo
 * is refused), so the words point at the stop button and never at History.
 */
export function damagedPartWayWords(notBack: string[]): string {
  const again = `Wait a moment, then ${STOP_AGAIN}.`
  if (notBack.length === 0) return `We couldn't finish stopping the test. ${again}`
  return `Some mods are not back in your Mods folder yet: ${listWords(notBack)}. ${again}`
}

/**
 * Labels of the groups the test moved that are not fully back in Mods, read from History's entries.
 * Only an undone entry is fully back. `sessionId` null means every test's entries (a damaged file names no session).
 * `keep` is the one group she chose to leave set aside.
 */
export function notBackLabels(journal: JournalEntry[], sessionId: string | null, keep: string | null): string[] {
  const labels = new Set<string>()
  for (const entry of journal) {
    if (entry.origin.by !== 'fifty-fifty' || entry.groupId === null) continue
    if (sessionId !== null && entry.origin.sessionId !== sessionId) continue
    if (entry.status === 'undone' || entry.groupId === keep) continue
    labels.add(entry.groupLabel ?? 'a mod group')
  }
  return [...labels]
}

const NAMED_AT_MOST = 5
function listWords(labels: string[]): string {
  const named = labels.slice(0, NAMED_AT_MOST)
  const more = labels.length - named.length
  const last = more > 0 ? `${more} more` : named.pop()
  return named.length > 0 ? `${named.join(', ')} and ${last}` : `${last}`
}
export function notBackWords(labels: string[]): string {
  const them = labels.length === 1 ? 'it' : 'them'
  return `Some mods are not back in your Mods folder yet: ${listWords(labels)}. Open History to put ${them} back.`
}
export const BACK_UNKNOWN =
  "We couldn't check that every mod is back in place. History lists every move, and you can put mods back from there."
export const NOT_COUNTED =
  'Your mods were not set up the way this round needs, so that answer was not counted. Set up the round and test once more.'

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
          return `We need a fresh safety copy before moving mods, so we stopped. Please ${again}.`
        case 'check-failed':
          return `Something got in the way of a safety check, so we stopped. Wait a moment, then ${again}.`
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
    case 'not-started':
      return `Something got in the way before we could move your mods, so we stopped. Wait a moment, then ${again}.`
    case 'fifty-fifty-running':
      return 'A 50/50 test is already running.'
  }
}
