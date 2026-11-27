import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type RequestsChannel =
  | 'requests:folder'
  | 'requests:pick-folder'
  | 'requests:send'
  | 'requests:list'
  | 'requests:install'

/** PR 17 (briefs/pr-17.md). Round 7 stubs: each throws until PR 17 lands. */
export function requestsHandlers(_ctx: AppContext): Handlers<RequestsChannel> {
  return {
    async 'requests:folder'() {
      throw new Error('not implemented: requests:folder')
    },
    async 'requests:pick-folder'() {
      throw new Error('not implemented: requests:pick-folder')
    },
    async 'requests:send'() {
      throw new Error('not implemented: requests:send')
    },
    async 'requests:list'() {
      throw new Error('not implemented: requests:list')
    },
    async 'requests:install'() {
      throw new Error('not implemented: requests:install')
    }
  }
}
