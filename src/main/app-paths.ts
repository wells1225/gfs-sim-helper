import { join } from 'node:path'
import type { AppPaths } from './ports.ts'

export interface AppPathsInput {
  localAppData: string
  appData?: string | null
  desktopDir: string
  env?: Record<string, string | undefined>
}

const ONEDRIVE_ENV_KEYS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const

function lookupEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct.trim()
  }
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && typeof v === 'string' && v.trim() !== '') {
      return v.trim()
    }
  }
  return undefined
}

export function appPaths({ localAppData, appData, desktopDir, env = {} }: AppPathsInput): AppPaths {
  const dataDir = join(localAppData, 'SimsHelper')

  const seen = new Set<string>()
  const oneDriveRoots: string[] = []
  for (const key of ONEDRIVE_ENV_KEYS) {
    const value = lookupEnv(env, key)
    if (!value) continue
    const normalized = value.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    oneDriveRoots.push(value)
  }

  const trimmedAppData = typeof appData === 'string' ? appData.trim() : ''
  const curseForgeInstanceFile = trimmedAppData
    ? join(trimmedAppData, 'CurseForge', 'agent', 'GameInstances', 'AddonGameInstance.json')
    : null

  return {
    dataDir,
    backupsDir: join(dataDir, 'backups'),
    holdingDir: join(dataDir, 'holding'),
    journalDir: join(dataDir, 'journal'),
    stateDir: join(dataDir, 'state'),
    keyFile: join(dataDir, 'assist', 'key.bin'),
    oldSavesDir: join(dataDir, 'old-saves'),
    shareDir: join(dataDir, 'share'),
    desktopDir,
    oneDriveRoots,
    curseForgeInstanceFile
  }
}
