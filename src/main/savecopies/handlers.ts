import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handlers } from '../../shared/ipc.ts'
import type { SaveCopyReason } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { oneAtATime } from '../safety/lock.ts'
import { listSaveCopies, makeSaveCopy } from './index.ts'
import { putBackSave } from './put-back.ts'

export type SaveCopiesChannel = 'savecopies:list' | 'savecopies:make' | 'savecopies:put-back'

const REASONS: readonly SaveCopyReason[] = ['by-hand', 'game-updated', 'before-change']

async function savedFolderPath(stateDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8'))
    const folderPath = (parsed as { folderPath?: unknown } | null)?.folderPath
    return typeof folderPath === 'string' && folderPath.length > 0 ? folderPath : null
  } catch {
    return null
  }
}

/** The Sims folder: the last scan's, else the one she picked (settings.json), else none. */
async function folderPathOf(ctx: AppContext): Promise<string | null> {
  return ctx.session.scan?.folder.path ?? (await savedFolderPath(ctx.paths.stateDir))
}

/** PR 15 (briefs/pr-15.md): her save copies. Making one and putting one back wait their turn with fixes. */
export function saveCopiesHandlers(ctx: AppContext): Handlers<SaveCopiesChannel> {
  return {
    async 'savecopies:list'() {
      return await listSaveCopies(ctx.paths)
    },
    'savecopies:make'(req) {
      return oneAtATime(ctx, async () => {
        const reason = (req as { reason?: unknown } | null | undefined)?.reason
        if (typeof reason !== 'string' || !REASONS.includes(reason as SaveCopyReason)) {
          return { kind: 'refused', why: 'error' }
        }
        try {
          return await makeSaveCopy(ctx, await folderPathOf(ctx), reason as SaveCopyReason)
        } catch {
          return { kind: 'refused', why: 'error' }
        }
      })
    },
    'savecopies:put-back'(req) {
      return oneAtATime(ctx, async () => {
        const { copyId, save } = (req ?? {}) as { copyId?: unknown; save?: unknown }
        if (typeof copyId !== 'string' || typeof save !== 'string') return { kind: 'refused', why: 'not-found' }
        try {
          return await putBackSave(ctx, await folderPathOf(ctx), copyId, save)
        } catch {
          return { kind: 'refused', why: 'error' }
        }
      })
    }
  }
}
