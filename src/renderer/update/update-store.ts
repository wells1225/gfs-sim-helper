import { useSyncExternalStore } from 'react'
import type { SimsHelperApi } from '../../shared/ipc.ts'
import type { UpdateState } from '../../shared/model.ts'
import { useApi } from '../api.tsx'

export const POLL_EVERY_MS = 1000
// The banner asks this often; the main process checks GitHub at most once in 24 hours (update/handlers.ts).
export const ASK_AGAIN_EVERY_MS = 60 * 60 * 1000

/** What the banner and the About row both show. One per window, so a check from About reaches the banner. */
export interface UpdateView {
  state: UpdateState | null // null: nothing known yet, or the last call was rejected (then nothing shows)
  hidden: boolean // Later: hidden until the next start, or until she checks again from About
  busy: boolean // Restart now was refused: a change is running
  restarting: boolean
  retrying: boolean // Try again is checking before retrying the download
}

export interface UpdateStore {
  view(): UpdateView
  subscribe(listener: () => void): () => void
  checkOnStart(): Promise<void>
  checkByClick(): Promise<UpdateState | null>
  refresh(): Promise<void>
  download(): Promise<void>
  tryAgain(): Promise<void>
  install(): Promise<void>
  later(): void
}

function createUpdateStore(api: SimsHelperApi): UpdateStore {
  let view: UpdateView = { state: null, hidden: false, busy: false, restarting: false, retrying: false }
  const listeners = new Set<() => void>()
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let actionSeq = 0
  let pendingStartCheck: Promise<UpdateState | null> | null = null

  function set(patch: Partial<UpdateView>): void {
    view = { ...view, ...patch }
    for (const listener of listeners) listener()
    if (view.state?.state === 'downloading') schedulePoll()
    else stopPolling()
  }

  function stopPolling(): void {
    if (pollTimer === null) return
    clearTimeout(pollTimer)
    pollTimer = null
  }

  /** The answer of one call, or null when it was rejected: the window never shows an error's text. */
  async function answer<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call()
    } catch {
      return null
    }
  }

  // While a download runs, update:get once a second for the percent. A late or rejected poll never undoes an active download.
  function schedulePoll(): void {
    if (pollTimer !== null || listeners.size === 0) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void answer(() => api.invoke('update:get')).then((state) => {
        if (view.state?.state !== 'downloading') return
        if (state !== null) set({ state })
        else schedulePoll()
      })
    }, POLL_EVERY_MS)
  }

  async function checkByClick(): Promise<UpdateState | null> {
    actionSeq += 1
    const inFlightStart = pendingStartCheck
    let state = await answer(() => api.invoke('update:check', { by: 'click' }))
    if (state?.state === 'checking' && inFlightStart !== null) {
      state = await inFlightStart
    }
    set({ state, hidden: false, busy: false })
    return state
  }

  async function download(): Promise<void> {
    const before = view.state
    if (before?.state !== 'available') return
    actionSeq += 1
    set({ state: { state: 'downloading', current: before.current, next: before.next, percent: 0 }, busy: false })
    set({ state: await answer(() => api.invoke('update:download')) })
  }

  return {
    view: () => view,

    subscribe(listener) {
      listeners.add(listener)
      if (view.state?.state === 'downloading') schedulePoll()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopPolling()
      }
    },

    async checkOnStart() {
      if (view.restarting || view.state?.state === 'downloading' || view.state?.state === 'ready') return
      const seq = actionSeq
      const call = answer(() => api.invoke('update:check', { by: 'start' }))
      pendingStartCheck = call
      try {
        const state = await call
        if (seq !== actionSeq || view.restarting) return
        set({ state })
      } finally {
        if (pendingStartCheck === call) pendingStartCheck = null
      }
    },

    checkByClick,

    async refresh() {
      set({ state: await answer(() => api.invoke('update:get')) })
    },

    download,

    async tryAgain() {
      if (view.retrying) return
      set({ retrying: true })
      try {
        const state = await checkByClick()
        if (state?.state === 'available') await download()
      } finally {
        set({ retrying: false })
      }
    },

    async install() {
      actionSeq += 1
      const result = await answer(() => api.invoke('update:install'))
      if (result === null) return set({ state: null })
      if (result.status === 'restarting') return set({ restarting: true, busy: false })
      if (result.why === 'busy') return set({ busy: true })
      set({ state: await answer(() => api.invoke('update:get')), busy: false })
    },

    later() {
      set({ hidden: true })
    }
  }
}

const stores = new WeakMap<SimsHelperApi, UpdateStore>()

export function updateStoreFor(api: SimsHelperApi): UpdateStore {
  let store = stores.get(api)
  if (!store) {
    store = createUpdateStore(api)
    stores.set(api, store)
  }
  return store
}

export function useUpdateStore(): { store: UpdateStore; view: UpdateView } {
  const store = updateStoreFor(useApi())
  const view = useSyncExternalStore(store.subscribe, store.view)
  return { store, view }
}
