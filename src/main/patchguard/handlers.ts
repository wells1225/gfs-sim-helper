import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'
import { oneAtATime } from '../safety/lock.ts'
import { playGame } from './play.ts'
import { clearHoldingEntry, listWaitingOnMods } from './waiting.ts'
import { markGameVersionSeen, watchGameVersion } from './watch.ts'

export type PatchGuardChannel =
  | 'patchguard:watch'
  | 'patchguard:seen'
  | 'patchguard:play'
  | 'patchguard:waiting'
  | 'patchguard:clear-holding'

/** PR 16 (briefs/pr-16.md): game version watch, Play button guard, Waiting on list, and Clear holding. */
export function patchGuardHandlers(ctx: AppContext): Handlers<PatchGuardChannel> {
  return {
    async 'patchguard:watch'() {
      return await watchGameVersion(ctx)
    },
    // Seen and Play wait their turn behind any save copy, fix or undo, so the game never starts mid-copy.
    'patchguard:seen'() {
      return oneAtATime(ctx, () => markGameVersionSeen(ctx))
    },
    'patchguard:play'(req) {
      return oneAtATime(ctx, () => playGame(ctx, req))
    },
    async 'patchguard:waiting'() {
      return await listWaitingOnMods(ctx)
    },
    'patchguard:clear-holding'(req) {
      return oneAtATime(ctx, async () => {
        const entryId = (req as { entryId?: unknown } | null | undefined)?.entryId
        if (typeof entryId !== 'string') {
          return { kind: 'refused', why: 'not-found' }
        }
        return await clearHoldingEntry(ctx, entryId)
      })
    }
  }
}
