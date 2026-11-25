export type PackCode = `${'EP' | 'GP' | 'SP' | 'FP'}${string}`

export interface SimsFolder {
  path: string
  inOneDrive: boolean
  /**
   * Newest date among files the game itself writes (settings, logs, saves). Mods, Tray and caches
   * are left out: other programs write those. The epoch when the folder has none of these files.
   */
  newestFileAt: Date
}

export interface GameInstall {
  path: string
  version: string
  packs: PackCode[]
}
