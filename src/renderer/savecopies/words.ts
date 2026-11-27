import type { SaveCopyMade, SaveCopyReason, SavePutBack } from '../../shared/model.ts'

export interface Words {
  title: string
  detail: string
  tone: 'warn' | 'destructive' | 'info'
}

export const REASON_LABEL: Record<SaveCopyReason, string> = {
  'by-hand': 'Made by you',
  'game-updated': 'Game updated',
  'before-change': 'Before a mod change'
}

export const BROKEN_COPY = "This copy didn't check out, so it can't be put back."

export const PUT_BACK_DONE = "It's in the game's Load menu as a new save. Your other saves are just as they were."

const GAME_OPEN: Words = {
  title: 'Close The Sims 4 first',
  detail:
    'The game is open. A save copied while the game is writing it can come out broken. Close the game, then try again.',
  tone: 'warn'
}

const GAME_UNKNOWN: Words = {
  title: "We couldn't tell if The Sims 4 is open",
  detail: 'To be safe, nothing was done. Make sure the game is closed, then try again.',
  tone: 'warn'
}

export function makeRefusalWords(why: Extract<SaveCopyMade, { kind: 'refused' }>['why']): Words {
  switch (why) {
    case 'game-running':
      return GAME_OPEN
    case 'game-state-unknown':
      return GAME_UNKNOWN
    case 'no-folder':
      return {
        title: "We couldn't find your Sims 4 folder",
        detail: 'Run a check-up first so Sims Helper knows where your game folder is.',
        tone: 'info'
      }
    case 'disk-full':
      return {
        title: 'Not enough free space for a copy',
        detail:
          'Your computer needs at least twice the size of your saves free. Free up some space, then try again. Nothing was changed.',
        tone: 'warn'
      }
    case 'error':
      return {
        title: "The copy didn't finish",
        detail: 'Nothing of yours was changed. Try again in a moment.',
        tone: 'warn'
      }
  }
}

export function putBackRefusalWords(why: Extract<SavePutBack, { kind: 'refused' }>['why']): Words {
  switch (why) {
    case 'game-running':
      return {
        ...GAME_OPEN,
        detail: 'The game is open, and it could write over the save while it goes back. Close the game, then try again.'
      }
    case 'game-state-unknown':
      return GAME_UNKNOWN
    case 'copy-broken':
      return { title: BROKEN_COPY, detail: 'Pick another copy. Your saves were not touched.', tone: 'destructive' }
    case 'not-found':
      return {
        title: 'That save is no longer in this copy',
        detail: 'It may have been tidied away. Pick another copy. Your saves were not touched.',
        tone: 'info'
      }
    case 'no-free-slot':
      return {
        title: 'There is no free save slot',
        detail:
          'The game has used up its save numbers. Nothing was changed. Delete your newest save or ask Tyler for help.',
        tone: 'warn'
      }
    case 'error':
      return {
        title: "The save couldn't be put back",
        detail:
          'Nothing of yours was replaced, and your other saves are just as they were. Try again, or send this to Tyler.',
        tone: 'warn'
      }
  }
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count.toLocaleString()} ${many}`
}

export function formatWhen(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
}
