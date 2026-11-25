import type { IpcInvoke, SimsHelperApi } from '../../shared/ipc.ts'
import type { Progress, UpdateState } from '../../shared/model.ts'

export type FakeAnswer<K extends keyof IpcInvoke> =
  | IpcInvoke[K]['res']
  | ((req: IpcInvoke[K]['req']) => IpcInvoke[K]['res'] | Promise<IpcInvoke[K]['res']>)

export type FakeApiAnswers = {
  [K in keyof IpcInvoke]?: FakeAnswer<K>
}

export interface FakeApiCall {
  channel: keyof IpcInvoke
  req: unknown
}

export interface FakeApi extends SimsHelperApi {
  readonly calls: FakeApiCall[]
  emitProgress(progress: Progress): void
}

const UPDATES_OFF: UpdateState = { state: 'off', why: 'switched-off', current: '0.2.0' }

/** Every test gets these unless it passes its own: no update banner, and the About row shows the version and a note saying why updates are off. */
const DEFAULT_ANSWERS: FakeApiAnswers = {
  'update:get': UPDATES_OFF,
  'update:check': UPDATES_OFF
}

export function fakeApi(given: FakeApiAnswers = {}): FakeApi {
  const answers: FakeApiAnswers = { ...DEFAULT_ANSWERS, ...given }
  const calls: FakeApiCall[] = []
  const listeners = new Set<(progress: Progress) => void>()

  return {
    calls,

    async invoke<K extends keyof IpcInvoke>(
      channel: K,
      ...req: IpcInvoke[K]['req'] extends void ? [] : [IpcInvoke[K]['req']]
    ): Promise<IpcInvoke[K]['res']> {
      const arg = req[0] as IpcInvoke[K]['req']
      calls.push({ channel, req: arg })

      if (!(channel in answers)) {
        throw new Error(`fakeApi: no answer configured for channel "${String(channel)}"`)
      }

      const answer: unknown = answers[channel]
      if (typeof answer === 'function') {
        const fn = answer as (r: unknown) => unknown
        return (await fn(arg)) as IpcInvoke[K]['res']
      }
      return answer as IpcInvoke[K]['res']
    },

    onProgress(listener: (progress: Progress) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    emitProgress(progress: Progress): void {
      for (const listener of listeners) {
        listener(progress)
      }
    }
  }
}
