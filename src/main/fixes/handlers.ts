import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type FixChannel = 'backup:status' | 'fix:apply' | 'journal:list' | 'journal:undo' | 'groups:disabled'

export function fixHandlers(_ctx: AppContext): Handlers<FixChannel> {
  return {
    async 'backup:status'() {
      throw new Error('not implemented: backup:status')
    },
    async 'fix:apply'() {
      throw new Error('not implemented: fix:apply')
    },
    async 'journal:list'() {
      throw new Error('not implemented: journal:list')
    },
    async 'journal:undo'() {
      throw new Error('not implemented: journal:undo')
    },
    async 'groups:disabled'() {
      throw new Error('not implemented: groups:disabled')
    }
  }
}
