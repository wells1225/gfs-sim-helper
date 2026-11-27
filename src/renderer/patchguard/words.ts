import type { ClearHoldingResult, GameVersionWatch, PlayAnswer } from '../../shared/model.ts'
import type { PlayNotice } from './store.ts'

export interface PatchGuardNoticeCopy {
  title: string
  detail: string
  tone: 'info' | 'warn'
}

export const DID_NOT_OPEN_TEXT = "If the game didn't open, open the EA app, then press Play again."

export function updateBannerText(watch: GameVersionWatch): string {
  return `The Sims 4 updated (${watch.lastSeen} \u2192 ${watch.current}). Script mods often break after an update.`
}

export function playNoticeCopy(notice: PlayNotice): PatchGuardNoticeCopy {
  if (notice.kind === 'did-not-open') {
    return {
      title: 'Still waiting for The Sims 4?',
      detail: DID_NOT_OPEN_TEXT,
      tone: 'info'
    }
  }
  return playRefusalCopy(notice.why)
}

export function playRefusalCopy(why: Extract<PlayAnswer, { kind: 'refused' }>['why']): PatchGuardNoticeCopy {
  switch (why) {
    case 'already-running':
      return {
        title: 'The Sims 4 is already open',
        detail: 'Switch to the game window to keep playing. Nothing was changed.',
        tone: 'warn'
      }
    case 'no-install':
      return {
        title: "We couldn't find The Sims 4 on this PC",
        detail: 'Open the EA app to start the game, or run a check-up to look again.',
        tone: 'warn'
      }
    case 'error':
      return {
        title: "The game didn't start",
        detail: 'Open the EA app, then press Play again.',
        tone: 'warn'
      }
  }
}

export function clearHoldingRefusalCopy(
  why: Extract<ClearHoldingResult, { kind: 'refused' }>['why']
): PatchGuardNoticeCopy {
  switch (why) {
    case 'not-found':
      return {
        title: 'That old copy is already gone',
        detail: 'Nothing in your Mods folder was changed.',
        tone: 'info'
      }
    case 'not-back-in-mods':
      return {
        title: "We kept this copy to be safe",
        detail: 'A newer copy was not found in your Mods folder, so the set-aside copy was left untouched.',
        tone: 'warn'
      }
    case 'error':
      return {
        title: "Couldn't clear the old copy",
        detail: 'Nothing in your Mods folder was changed. Try again in a moment.',
        tone: 'warn'
      }
  }
}
