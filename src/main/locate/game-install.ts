import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GameInstall, PackCode, SimsFolder } from '../../shared/model.ts'
import { getEnvValue } from './host.ts'
import type { Host } from './host.ts'

export const SIMS_REGISTRY_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Maxis\\The Sims 4'
export const SIMS_REGISTRY_VALUE = 'Install Dir'
export const PACK_CODE_PATTERN = /^[EGSF]P\d{2,}$/
export const VERSION_PATTERN = /\d+\.\d+\.\d+\.\d+/

const GAME_EXE_NAMES = ['TS4_x64.exe', 'TS4_DX9_x64.exe', 'TS4_x64_fpb.exe'] as const

export function extractVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = raw.match(VERSION_PATTERN)
  return match?.[0]
}

export async function readGameVersionFromTxt(userFolderPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(userFolderPath, 'GameVersion.txt'))
    return extractVersion(raw.toString('latin1'))
  } catch {
    return undefined
  }
}

export async function listInstalledPacks(installPath: string): Promise<PackCode[]> {
  let entries
  try {
    entries = await readdir(installPath, { withFileTypes: true })
  } catch {
    return []
  }

  const packs: PackCode[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && PACK_CODE_PATTERN.test(entry.name)) {
      packs.push(entry.name as PackCode)
    }
  }
  packs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return packs
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile()
  } catch {
    return false
  }
}

async function isValidGameInstallDir(candidatePath: string): Promise<boolean> {
  if (!(await isDirectory(candidatePath))) return false
  for (const exeName of GAME_EXE_NAMES) {
    if (await isFile(join(candidatePath, 'Game', 'Bin', exeName))) {
      return true
    }
  }
  return isDirectory(join(candidatePath, 'Data'))
}

function collectDefaultInstallPaths(env: Record<string, string | undefined>): string[] {
  const programFiles = getEnvValue(env, 'ProgramFiles')
  const programFilesX86 = getEnvValue(env, 'ProgramFiles(x86)')
  const candidates: string[] = []

  // EA app default
  if (programFiles) {
    candidates.push(join(programFiles, 'EA Games', 'The Sims 4'))
  }
  if (programFilesX86) {
    candidates.push(join(programFilesX86, 'EA Games', 'The Sims 4'))
  }

  // Steam default
  if (programFilesX86) {
    candidates.push(join(programFilesX86, 'Steam', 'steamapps', 'common', 'The Sims 4'))
  }
  if (programFiles) {
    candidates.push(join(programFiles, 'Steam', 'steamapps', 'common', 'The Sims 4'))
  }

  // Origin legacy default
  if (programFilesX86) {
    candidates.push(join(programFilesX86, 'Origin Games', 'The Sims 4'))
  }
  if (programFiles) {
    candidates.push(join(programFiles, 'Origin Games', 'The Sims 4'))
  }

  return candidates
}

export async function findGameInstall(
  host: Pick<Host, 'env' | 'readRegistry' | 'fileVersion'>,
  userFolders: readonly SimsFolder[] = []
): Promise<GameInstall | null> {
  const candidates: string[] = []

  const regDir = await host.readRegistry(SIMS_REGISTRY_KEY, SIMS_REGISTRY_VALUE)
  if (regDir && regDir.trim() !== '') {
    candidates.push(regDir.trim())
  }

  candidates.push(...collectDefaultInstallPaths(host.env))

  const seen = new Set<string>()
  let installPath: string | null = null

  for (const rawCandidate of candidates) {
    const resolved = resolve(rawCandidate)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)

    if (await isValidGameInstallDir(resolved)) {
      installPath = resolved
      break
    }
  }

  if (!installPath) {
    return null
  }

  const exePath = join(installPath, 'Game', 'Bin', 'TS4_x64.exe')
  let version = extractVersion(await host.fileVersion(exePath))

  if (!version) {
    for (const folder of userFolders) {
      const fallback = await readGameVersionFromTxt(folder.path)
      if (fallback) {
        version = fallback
        break
      }
    }
  }

  const packs = await listInstalledPacks(installPath)
  return {
    path: installPath,
    version: version ?? '',
    packs
  }
}
