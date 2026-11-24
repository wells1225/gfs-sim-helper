import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type FiftyChannel =
  | 'fifty:get'
  | 'fifty:start'
  | 'fifty:begin-round'
  | 'fifty:answer'
  | 'fifty:stop'
  | 'fifty:finish'

export function fiftyHandlers(_ctx: AppContext): Handlers<FiftyChannel> {
  return {
    async 'fifty:get'() {
      throw new Error('not implemented: fifty:get')
    },
    async 'fifty:start'() {
      throw new Error('not implemented: fifty:start')
    },
    async 'fifty:begin-round'() {
      throw new Error('not implemented: fifty:begin-round')
    },
    async 'fifty:answer'() {
      throw new Error('not implemented: fifty:answer')
    },
    async 'fifty:stop'() {
      throw new Error('not implemented: fifty:stop')
    },
    async 'fifty:finish'() {
      throw new Error('not implemented: fifty:finish')
    }
  }
}
