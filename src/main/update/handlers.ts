import type { Handlers } from '../../shared/ipc.ts'
import type { AppContext } from '../ports.ts'

export type UpdateChannel = 'update:get' | 'update:check' | 'update:download' | 'update:install'

/** A check the app makes by itself (`by: 'start'`) happens at most this often. A click always checks. */
export const CHECK_ON_START_EVERY_MS = 24 * 60 * 60 * 1000

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

// Every handler answers from the updater alone and logs nothing.
export function updateHandlers(ctx: AppContext): Handlers<UpdateChannel> {
  let lastCheckAt: number | null = null

  return {
    async 'update:get'() {
      return ctx.updater.state()
    },

    async 'update:check'(req) {
      const by = checkedBy(req)
      if (by === null) return ctx.updater.state()
      const now = ctx.clock.now().getTime()
      if (by === 'start' && lastCheckAt !== null && now - lastCheckAt < CHECK_ON_START_EVERY_MS) {
        return ctx.updater.state()
      }
      lastCheckAt = now
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
