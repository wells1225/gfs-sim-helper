import type { UpdateState } from '../../shared/model.ts'
import type { Updater, UpdaterInput } from '../ports.ts'

// Stub from the contract commit. PR 13 (Fable) replaces it: the only file that may load electron-updater.
const OFF: UpdateState = { state: 'off', why: 'switched-off' }

export function createUpdater(_input: UpdaterInput, _seams: { busy?: () => boolean } = {}): Updater {
  return {
    state: () => OFF,
    check: async () => OFF,
    download: async () => OFF,
    install: () => ({ status: 'refused', why: 'not-ready' })
  }
}
