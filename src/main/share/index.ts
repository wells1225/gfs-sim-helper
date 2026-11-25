import type { AppContext, Share } from '../ports.ts'

/** What createShare gets (PR 14, unit F may widen it). Never the whole context: share is part of it. */
export type ShareDeps = Pick<
  AppContext,
  'gate' | 'safety' | 'paths' | 'clock' | 'newId' | 'host' | 'gameState' | 'redact' | 'pickFolder'
>

/** PR 14 (unit F). Building it calls nothing; each stub rejects when called, so shareRoot() refuses a share op. */
export function createShare(_deps: ShareDeps): Share {
  return {
    async view() {
      throw new Error('not implemented: share.view')
    },
    async setRole() {
      throw new Error('not implemented: share.setRole')
    },
    async findFolder() {
      throw new Error('not implemented: share.findFolder')
    },
    async check() {
      throw new Error('not implemented: share.check')
    },
    async send() {
      throw new Error('not implemented: share.send')
    },
    async receive() {
      throw new Error('not implemented: share.receive')
    },
    async restore() {
      throw new Error('not implemented: share.restore')
    },
    async keep() {
      throw new Error('not implemented: share.keep')
    },
    async stop() {
      throw new Error('not implemented: share.stop')
    },
    async oldSaves() {
      throw new Error('not implemented: share.oldSaves')
    },
    async localSaves() {
      throw new Error('not implemented: share.localSaves')
    },
    async shareRoot() {
      throw new Error('not implemented: share.shareRoot')
    }
  }
}
