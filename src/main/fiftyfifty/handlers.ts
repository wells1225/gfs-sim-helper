import type { Handlers } from '../../shared/ipc.ts'
import type { FiftyAnswer } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { beginRound, finish, giveAnswer, loadState, start, stop } from './index.ts'

export type FiftyChannel =
  | 'fifty:get'
  | 'fifty:start'
  | 'fifty:begin-round'
  | 'fifty:answer'
  | 'fifty:stop'
  | 'fifty:finish'

/** The driver, passed in so the handler tests can watch the order of calls. */
export interface FiftyApi {
  loadState: typeof loadState
  start: typeof start
  beginRound: typeof beginRound
  giveAnswer: typeof giveAnswer
  stop: typeof stop
  finish: typeof finish
}

const DRIVER: FiftyApi = { loadState, start, beginRound, giveAnswer, stop, finish }
const ANSWERS: readonly FiftyAnswer[] = ['crashed', 'worked', 'not-sure']
const KEEPS = ['keep-set-aside', 'put-back'] as const

function field(req: unknown, name: string): unknown {
  return typeof req === 'object' && req !== null ? (req as Record<string, unknown>)[name] : undefined
}

export function makeFiftyHandlers(ctx: AppContext, api: FiftyApi = DRIVER): Handlers<FiftyChannel> {
  // Every call waits for the one before it: two quick clicks must not both answer the same round.
  let queue: Promise<unknown> = Promise.resolve()
  const one = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    'fifty:get': () => one(() => api.loadState(ctx)),
    'fifty:start': () => one(() => api.start(ctx, ctx.session.scan)),
    'fifty:begin-round': () => one(() => api.beginRound(ctx)),
    'fifty:answer': (req) => {
      const given = field(req, 'answer')
      if (!ANSWERS.includes(given as FiftyAnswer)) return Promise.reject(new Error('fifty:answer needs a known answer'))
      return one(() => api.giveAnswer(ctx, given as FiftyAnswer))
    },
    'fifty:stop': () => one(() => api.stop(ctx)),
    'fifty:finish': (req) => {
      const keep = field(req, 'keep')
      if (!KEEPS.includes(keep as (typeof KEEPS)[number])) return Promise.reject(new Error('fifty:finish needs keep'))
      return one(() => api.finish(ctx, keep as (typeof KEEPS)[number]))
    }
  }
}

export function fiftyHandlers(ctx: AppContext): Handlers<FiftyChannel> {
  return makeFiftyHandlers(ctx)
}
