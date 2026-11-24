import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type ScanChannel =
  | 'settings:get'
  | 'settings:update'
  | 'locate:run'
  | 'scan:run'
  | 'game:check'
  | 'report:build'
  | 'report:reveal'

export function scanHandlers(_ctx: AppContext): Handlers<ScanChannel> {
  return {
    async 'settings:get'() {
      throw new Error('not implemented: settings:get')
    },
    async 'settings:update'() {
      throw new Error('not implemented: settings:update')
    },
    async 'locate:run'() {
      throw new Error('not implemented: locate:run')
    },
    async 'scan:run'() {
      throw new Error('not implemented: scan:run')
    },
    async 'game:check'() {
      throw new Error('not implemented: game:check')
    },
    async 'report:build'() {
      throw new Error('not implemented: report:build')
    },
    async 'report:reveal'() {
      throw new Error('not implemented: report:reveal')
    }
  }
}
