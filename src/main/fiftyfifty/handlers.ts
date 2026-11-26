import type { Handlers } from '../../shared/ipc.ts'
import type { FiftyAnswer, FiftyResult } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { oneAtATime } from '../safety/lock.ts'
import { beginRound, finish, getState, giveAnswer, start, stop } from './index.ts'

export type FiftyChannel =
  | 'fifty:get'
  | 'fifty:start'
  | 'fifty:begin-round'
  | 'fifty:answer'
  | 'fifty:stop'
  | 'fifty:finish'

/** The driver, passed in so the handler tests can watch the order of calls. */
export interface FiftyApi {
  loadState: typeof getState
  start: typeof start
  beginRound: typeof beginRound
  giveAnswer: typeof giveAnswer
  stop: typeof stop
  finish: typeof finish
}

const DRIVER: FiftyApi = { loadState: getState, start, beginRound, giveAnswer, stop, finish }
const ANSWERS: readonly FiftyAnswer[] = ['crashed', 'worked', 'not-sure']
const KEEPS = ['keep-set-aside', 'put-back'] as const

function field(req: unknown, name: string): unknown {
  return typeof req === 'object' && req !== null ? (req as Record<string, unknown>)[name] : undefined
}

export function makeFiftyHandlers(ctx: AppContext, api: FiftyApi = DRIVER): Handlers<FiftyChannel> {
  // Every call waits for the one before it. If a state-changing step is already in flight, a late
  // fifty:answer cannot belong to the round being set up, so it returns the current state instead.
  let queue: Promise<unknown> = Promise.resolve()
  let inFlightMutations = 0

  const one = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  const mutate = <T>(work: () => Promise<T>): Promise<T> => {
    inFlightMutations += 1
    // Share the per-context change lock with fixHandlers so a fix/undo and a 50/50 step never overlap.
    return one(() =>
      oneAtATime(ctx, async () => {
        await ctx.startupRecovery?.()
        return await work()
      })
    ).finally(() => {
      inFlightMutations -= 1
    })
  }

  return {
    'fifty:get': () =>
      one(async () => {
        await ctx.startupRecovery?.()
        return await api.loadState(ctx)
      }),
    'fifty:start': () => mutate(() => api.start(ctx, ctx.session.scan)),
    'fifty:begin-round': () => mutate(() => api.beginRound(ctx)),
    'fifty:answer': (req) => {
      const given = field(req, 'answer')
      if (!ANSWERS.includes(given as FiftyAnswer)) return Promise.reject(new Error('fifty:answer needs a known answer'))
      const round = field(req, 'round')
      if (!Number.isInteger(round) || (round as number) < 0) {
        return Promise.reject(new Error('fifty:answer needs the round it answers'))
      }
      if (inFlightMutations > 0) {
        return one(async (): Promise<FiftyResult> => {
          const saved = await api.loadState(ctx)
          // 'ok' with no session would show her the Start button over a damaged file. A refusal makes the screen read again.
          if (saved !== null && 'status' in saved) return { status: 'refused', refusal: { why: 'fifty-fifty-running' } }
          return { status: 'ok', state: saved }
        })
      }
      return mutate(() => api.giveAnswer(ctx, given as FiftyAnswer, round as number))
    },
    'fifty:stop': () => mutate(() => api.stop(ctx)),
    'fifty:finish': (req) => {
      const keep = field(req, 'keep')
      if (!KEEPS.includes(keep as (typeof KEEPS)[number])) return Promise.reject(new Error('fifty:finish needs keep'))
      return mutate(() => api.finish(ctx, keep as (typeof KEEPS)[number]))
    }
  }
}

export function fiftyHandlers(ctx: AppContext): Handlers<FiftyChannel> {
  return makeFiftyHandlers(ctx)
}
