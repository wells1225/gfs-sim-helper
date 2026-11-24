export type PackCode = `${'EP' | 'GP' | 'SP' | 'FP'}${string}`

export interface SimsFolder {
  path: string
  inOneDrive: boolean
  newestFileAt: Date
}

export interface GameInstall {
  path: string
  version: string
  packs: PackCode[]
}
