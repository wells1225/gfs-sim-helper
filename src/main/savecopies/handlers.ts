import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type SaveCopiesChannel = 'savecopies:list' | 'savecopies:make' | 'savecopies:put-back'

/** PR 15 (briefs/pr-15.md). Round 7 stubs: each throws until PR 15 lands. */
export function saveCopiesHandlers(_ctx: AppContext): Handlers<SaveCopiesChannel> {
  return {
    async 'savecopies:list'() {
      throw new Error('not implemented: savecopies:list')
    },
    async 'savecopies:make'() {
      throw new Error('not implemented: savecopies:make')
    },
    async 'savecopies:put-back'() {
      throw new Error('not implemented: savecopies:put-back')
    }
  }
}
