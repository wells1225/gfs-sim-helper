import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type UpdateChannel = 'update:get' | 'update:check' | 'update:download' | 'update:install'

export function updateHandlers(_ctx: AppContext): Handlers<UpdateChannel> {
  return {
    async 'update:get'() {
      throw new Error('not implemented: update:get')
    },
    async 'update:check'() {
      throw new Error('not implemented: update:check')
    },
    async 'update:download'() {
      throw new Error('not implemented: update:download')
    },
    async 'update:install'() {
      throw new Error('not implemented: update:install')
    }
  }
}
