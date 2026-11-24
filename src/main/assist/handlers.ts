import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type AssistChannel =
  | 'assist:status'
  | 'assist:preview'
  | 'assist:send'
  | 'assist:set-key'
  | 'assist:clear-key'

export function assistHandlers(_ctx: AppContext): Handlers<AssistChannel> {
  return {
    async 'assist:status'() {
      throw new Error('not implemented: assist:status')
    },
    async 'assist:preview'() {
      throw new Error('not implemented: assist:preview')
    },
    async 'assist:send'() {
      throw new Error('not implemented: assist:send')
    },
    async 'assist:set-key'() {
      throw new Error('not implemented: assist:set-key')
    },
    async 'assist:clear-key'() {
      throw new Error('not implemented: assist:clear-key')
    }
  }
}
