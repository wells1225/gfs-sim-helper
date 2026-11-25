import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type ShareChannel =
  | 'share:get'
  | 'share:set-role'
  | 'share:find-folder'
  | 'share:check'
  | 'share:settings'
  | 'share:local-saves'
  | 'share:send'
  | 'share:receive'
  | 'share:keep'
  | 'share:old-saves'
  | 'share:restore'
  | 'share:stop'
  | 'share:mod-link'
  | 'share:open-link'
  | 'share:find-preview'
  | 'share:find-send'

/** PR 14 (unit F). Unit H's findHandlers gives the two share:find-* channels and is spread in here. */
export function shareHandlers(_ctx: AppContext): Handlers<ShareChannel> {
  return {
    async 'share:get'() {
      throw new Error('not implemented: share:get')
    },
    async 'share:set-role'() {
      throw new Error('not implemented: share:set-role')
    },
    async 'share:find-folder'() {
      throw new Error('not implemented: share:find-folder')
    },
    async 'share:check'() {
      throw new Error('not implemented: share:check')
    },
    async 'share:settings'() {
      throw new Error('not implemented: share:settings')
    },
    async 'share:local-saves'() {
      throw new Error('not implemented: share:local-saves')
    },
    async 'share:send'() {
      throw new Error('not implemented: share:send')
    },
    async 'share:receive'() {
      throw new Error('not implemented: share:receive')
    },
    async 'share:keep'() {
      throw new Error('not implemented: share:keep')
    },
    async 'share:old-saves'() {
      throw new Error('not implemented: share:old-saves')
    },
    async 'share:restore'() {
      throw new Error('not implemented: share:restore')
    },
    async 'share:stop'() {
      throw new Error('not implemented: share:stop')
    },
    async 'share:mod-link'() {
      throw new Error('not implemented: share:mod-link')
    },
    async 'share:open-link'() {
      throw new Error('not implemented: share:open-link')
    },
    async 'share:find-preview'() {
      throw new Error('not implemented: share:find-preview')
    },
    async 'share:find-send'() {
      throw new Error('not implemented: share:find-send')
    }
  }
}
