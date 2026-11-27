import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type PatchGuardChannel =
  | 'patchguard:watch'
  | 'patchguard:seen'
  | 'patchguard:play'
  | 'patchguard:waiting'
  | 'patchguard:clear-holding'

/** PR 16 (briefs/pr-16.md). Round 7 stubs: each throws until PR 16 lands. Play opens the game with ctx.openGame. */
export function patchGuardHandlers(_ctx: AppContext): Handlers<PatchGuardChannel> {
  return {
    async 'patchguard:watch'() {
      throw new Error('not implemented: patchguard:watch')
    },
    async 'patchguard:seen'() {
      throw new Error('not implemented: patchguard:seen')
    },
    async 'patchguard:play'() {
      throw new Error('not implemented: patchguard:play')
    },
    async 'patchguard:waiting'() {
      throw new Error('not implemented: patchguard:waiting')
    },
    async 'patchguard:clear-holding'() {
      throw new Error('not implemented: patchguard:clear-holding')
    }
  }
}
