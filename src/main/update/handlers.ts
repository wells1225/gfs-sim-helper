import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type UpdateChannel = 'update:get' | 'update:check' | 'update:download' | 'update:install'

/** A check the app makes by itself (`by: 'start'`) happens at most this often. A click always checks. */
export const CHECK_ON_START_EVERY_MS = 24 * 60 * 60 * 1000

/** The time of the last check, kept in <dataDir>\\state\\ so closing and reopening the app keeps the 24 hours. */
export const LAST_CHECK_FILE = 'update.json'

/**
 * The saved time, or null when there is none to trust: missing, unreadable, not a date, or later than now (the clock
 * went back). Null means "check now"; that check is then remembered in memory, so it happens once per app open at most.
 */
async function readLastCheck(ctx: AppContext): Promise<number | null> {
  try {
    const saved: unknown = JSON.parse(await readFile(join(ctx.paths.stateDir, LAST_CHECK_FILE), 'utf8'))
    if (!saved || typeof saved !== 'object') return null
    const at = (saved as { lastCheckAt?: unknown }).lastCheckAt
    if (typeof at !== 'string') return null
    const time = Date.parse(at)
    if (!Number.isFinite(time) || time > ctx.clock.now().getTime()) return null
    return time
  } catch {
    return null
  }
}

/** Saves the time through the gate's app-data zone. A refused, failed or thrown write only loses the saved copy. */
async function saveLastCheck(ctx: AppContext, time: number): Promise<void> {
  try {
    await ctx.gate.run({
      reason: 'state',
      folderPath: null,
      ops: [
        {
          op: 'write',
          path: join(ctx.paths.stateDir, LAST_CHECK_FILE),
          data: JSON.stringify({ lastCheckAt: new Date(time).toISOString() }),
          mode: 'replace'
        }
      ]
    })
  } catch {
    // the in-memory time still holds while the app is open
  }
}

/** The window is not trusted: only `{ by: 'start' }` and `{ by: 'click' }` get through, with nothing else. */
function checkedBy(req: unknown): 'start' | 'click' | null {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null
  const keys = Object.keys(req)
  const by = (req as { by?: unknown }).by
  return keys.length === 1 && (by === 'start' || by === 'click') ? by : null
}

/** Anything but a plain "no" counts as busy: a restart in the middle of a change is a power cut. */
function isBusy(ctx: AppContext): boolean {
  try {
    return ctx.busy() !== false
  } catch {
    return true
  }
}

// Every handler answers from the updater alone and logs nothing. update:check also keeps the time of the last check
// in the app data folder, read once on the first check.
export function updateHandlers(ctx: AppContext): Handlers<UpdateChannel> {
  let saved: Promise<number | null> | null = null
  let lastCheckAt: number | null = null

  return {
    async 'update:get'() {
      return ctx.updater.state()
    },

    async 'update:check'(req) {
      const by = checkedBy(req)
      if (by === null) return ctx.updater.state()
      saved ??= readLastCheck(ctx).then((time) => {
        lastCheckAt ??= time
        return time
      })
      await saved
      const now = ctx.clock.now().getTime()
      if (by === 'start' && lastCheckAt !== null && now - lastCheckAt < CHECK_ON_START_EVERY_MS) {
        return ctx.updater.state()
      }
      lastCheckAt = now // set before the check, so a check that fails or hangs is not repeated on the next start
      await saveLastCheck(ctx, now)
      return await ctx.updater.check()
    },

    async 'update:download'(req) {
      if (req !== undefined) return ctx.updater.state()
      return await ctx.updater.download()
    },

    async 'update:install'(req) {
      if (req !== undefined) return { status: 'refused', why: 'not-ready' }
      if (isBusy(ctx)) return { status: 'refused', why: 'busy' }
      return ctx.updater.install()
    }
  }
}
