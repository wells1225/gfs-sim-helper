import { useSyncExternalStore } from 'react'
import type { SimsHelperApi } from '../../shared/ipc.ts'
import type { GameVersionWatch, PlayAnswer, SaveCopyMade } from '../../shared/model.ts'

export const PLAY_CHECK_DELAY_MS = 60_000

export type PlayNotice =
  | { kind: 'refused'; why: Extract<PlayAnswer, { kind: 'refused' }>['why'] }
  | { kind: 'did-not-open' }

export type AutoSaveCopyState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: SaveCopyMade }
  | { status: 'error' }

export interface PatchGuardSnapshot {
  watch: GameVersionWatch | null
  watchLoaded: boolean
  dismissed: boolean
  starting: boolean
  playNotice: PlayNotice | null
  bannerMounted: boolean
  autoSaveCopyVersion: string | null
  autoSaveCopy: AutoSaveCopyState
}

const INITIAL_SNAPSHOT: PatchGuardSnapshot = {
  watch: null,
  watchLoaded: false,
  dismissed: false,
  starting: false,
  playNotice: null,
  bannerMounted: false,
  autoSaveCopyVersion: null,
  autoSaveCopy: { status: 'idle' }
}

export class PatchGuardStore {
  private readonly api: SimsHelperApi
  private snapshot: PatchGuardSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private watchPromise: Promise<GameVersionWatch | null> | null = null
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  private bannerCount = 0
  private playButtonCount = 0

  constructor(api: SimsHelperApi) {
    this.api = api
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PatchGuardSnapshot => this.snapshot

  private update(patch: Partial<PatchGuardSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) {
      listener()
    }
  }

  private clearTimer(): void {
    if (this.checkTimer !== null) {
      clearTimeout(this.checkTimer)
      this.checkTimer = null
    }
  }

  mountBanner(): () => void {
    this.bannerCount += 1
    if (!this.snapshot.bannerMounted) {
      this.update({ bannerMounted: true })
    }
    return () => {
      this.bannerCount = Math.max(0, this.bannerCount - 1)
      if (this.bannerCount === 0 && this.snapshot.bannerMounted) {
        this.update({ bannerMounted: false })
      }
      if (this.bannerCount === 0 && this.playButtonCount === 0) {
        this.clearTimer()
      }
    }
  }

  mountPlayButton(): () => void {
    this.playButtonCount += 1
    return () => {
      this.playButtonCount = Math.max(0, this.playButtonCount - 1)
      if (this.bannerCount === 0 && this.playButtonCount === 0) {
        this.clearTimer()
      }
    }
  }

  loadWatch(force = false): Promise<GameVersionWatch | null> {
    if (this.watchPromise && !force) return this.watchPromise
    const run = this.api
      .invoke('patchguard:watch')
      .then((watch) => {
        this.update({ watch, watchLoaded: true })
        return watch
      })
      .catch(() => {
        this.update({ watchLoaded: true })
        return this.snapshot.watch
      })
    this.watchPromise = run
    return run
  }

  dismissBanner(): void {
    this.update({ dismissed: true })
  }

  clearPlayNotice(): void {
    this.update({ playNotice: null })
  }

  async markSeen(): Promise<GameVersionWatch | null> {
    try {
      const watch = await this.api.invoke('patchguard:seen')
      this.watchPromise = Promise.resolve(watch)
      this.update({ watch, watchLoaded: true, dismissed: false })
      return watch
    } catch {
      return null
    }
  }

  async runSaveCopyForUpdate(version: string | null, manual = false): Promise<void> {
    if (!manual) {
      if (version === null) return
      if (this.snapshot.autoSaveCopyVersion === version) return
      this.update({ autoSaveCopyVersion: version, autoSaveCopy: { status: 'running' } })
    } else {
      if (this.snapshot.autoSaveCopy.status === 'running') return
      this.update({
        autoSaveCopyVersion: version ?? this.snapshot.autoSaveCopyVersion,
        autoSaveCopy: { status: 'running' }
      })
    }

    try {
      const result = await this.api.invoke('savecopies:make', { reason: 'game-updated' })
      this.update({ autoSaveCopy: { status: 'done', result } })
    } catch {
      this.update({ autoSaveCopy: { status: 'error' } })
    }
  }

  async play(ignoreUpdate: boolean): Promise<PlayAnswer> {
    if (this.snapshot.starting) {
      return { kind: 'refused', why: 'error' }
    }
    this.clearTimer()
    this.update({ starting: true, playNotice: null })
    try {
      const answer = await this.api.invoke('patchguard:play', { ignoreUpdate })
      if (answer.kind === 'stopped') {
        this.watchPromise = Promise.resolve(answer.watch)
        this.update({ starting: false, watch: answer.watch, watchLoaded: true, dismissed: false })
        return answer
      }
      if (answer.kind === 'refused') {
        this.update({ starting: false, playNotice: { kind: 'refused', why: answer.why } })
        return answer
      }
      this.update({ starting: false })
      this.checkTimer = setTimeout(() => {
        this.checkTimer = null
        void this.api
          .invoke('game:check')
          .then((state) => {
            if (state !== 'running') {
              this.update({ playNotice: { kind: 'did-not-open' } })
            }
          })
          .catch(() => {
            this.update({ playNotice: { kind: 'did-not-open' } })
          })
      }, PLAY_CHECK_DELAY_MS)
      return answer
    } catch {
      this.update({ starting: false, playNotice: { kind: 'refused', why: 'error' } })
      return { kind: 'refused', why: 'error' }
    }
  }
}

const stores = new WeakMap<SimsHelperApi, PatchGuardStore>()

export function getPatchGuardStore(api: SimsHelperApi): PatchGuardStore {
  let store = stores.get(api)
  if (!store) {
    store = new PatchGuardStore(api)
    stores.set(api, store)
  }
  return store
}

const NOOP_SUBSCRIBE = () => () => {}

export function usePatchGuardStore(api: SimsHelperApi | null): {
  store: PatchGuardStore | null
  state: PatchGuardSnapshot
} {
  const store = api ? getPatchGuardStore(api) : null
  const state = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : () => INITIAL_SNAPSHOT
  )
  return { store, state }
}
