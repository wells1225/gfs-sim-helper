import type { UpdateState } from '../../shared/model.ts'
import type { Updater, UpdaterInput } from '../ports.ts'

// Stub from the contract commit. PR 13 (Fable) replaces it: the only file that may load electron-updater.
export function createUpdater(input: UpdaterInput, _seams: { busy?: () => boolean } = {}): Updater {
  const OFF: UpdateState = { state: 'off', why: 'switched-off', current: input.version }
  return {
    state: () => OFF,
    check: async () => OFF,
    download: async () => OFF,
    install: () => ({ status: 'refused', why: 'not-ready' })
  }
}
