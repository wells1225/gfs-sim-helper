import { readFile, stat } from 'node:fs/promises'
import type { CurseForgeAddon, CurseForgeRead } from '../../shared/model.ts'

const SIMS4_CURSEFORGE_GAME_ID = 78062
const MAX_CURSEFORGE_BYTES = 16 * 1024 * 1024

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAddon(raw: unknown, index: number): { ok: true; addon: CurseForgeAddon | null } | { ok: false; detail: string } {
  if (!isRecord(raw)) {
    return { ok: false, detail: `installedAddons[${index}] is not an object` }
  }
  if (raw.installed === false) {
    return { ok: true, addon: null }
  }

  const addonId = raw.addonID
  if (typeof addonId !== 'number' || !Number.isFinite(addonId)) {
    return { ok: false, detail: `installedAddons[${index}].addonID is not a finite number` }
  }

  const installedFile = raw.installedFile
  if (!isRecord(installedFile)) {
    return { ok: false, detail: `installedAddons[${index}].installedFile is not an object` }
  }

  const fileId = installedFile.id
  if (typeof fileId !== 'number' || !Number.isFinite(fileId)) {
    return { ok: false, detail: `installedAddons[${index}].installedFile.id is not a finite number` }
  }

  const name = installedFile.displayName
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, detail: `installedAddons[${index}].installedFile.displayName is missing or empty` }
  }

  const fileNameOnDisk = installedFile.fileNameOnDisk
  if (typeof fileNameOnDisk !== 'string') {
    return { ok: false, detail: `installedAddons[${index}].installedFile.fileNameOnDisk is not a string` }
  }

  const rawFileDate = installedFile.fileDate
  if (typeof rawFileDate !== 'string') {
    return { ok: false, detail: `installedAddons[${index}].installedFile.fileDate is not a string` }
  }
  const parsedDateMs = Date.parse(rawFileDate)
  if (Number.isNaN(parsedDateMs)) {
    return { ok: false, detail: `installedAddons[${index}].installedFile.fileDate is not a valid date` }
  }

  const rawModules = installedFile.modules
  if (!Array.isArray(rawModules)) {
    return { ok: false, detail: `installedAddons[${index}].installedFile.modules is not an array` }
  }

  const moduleNames: string[] = []
  for (let m = 0; m < rawModules.length; m += 1) {
    const mod = rawModules[m]
    if (!isRecord(mod) || typeof mod.name !== 'string') {
      return { ok: false, detail: `installedAddons[${index}].installedFile.modules[${m}].name is not a string` }
    }
    moduleNames.push(mod.name)
  }

  return {
    ok: true,
    addon: {
      addonId,
      fileId,
      name,
      fileNameOnDisk,
      fileDate: new Date(parsedDateMs).toISOString(),
      moduleNames
    }
  }
}

export async function readCurseForge(instanceFile: string | null): Promise<CurseForgeRead> {
  if (instanceFile === null || instanceFile.trim() === '') {
    return { status: 'not-found' }
  }

  try {
    const info = await stat(instanceFile)
    if (!info.isFile()) {
      return { status: 'unreadable', detail: 'CurseForge instance path is not a file' }
    }
    if (info.size > MAX_CURSEFORGE_BYTES) {
      return { status: 'unreadable', detail: `CurseForge instance file is ${info.size} bytes (limit is 16 MB)` }
    }
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'not-found' }
    }
    return { status: 'unreadable', detail: formatError(err) }
  }

  let rawText: string
  try {
    rawText = await readFile(instanceFile, 'utf8')
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'not-found' }
    }
    return { status: 'unreadable', detail: formatError(err) }
  }

  const cleanText = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText
  let parsed: unknown
  try {
    parsed = JSON.parse(cleanText)
  } catch (err) {
    return { status: 'unreadable', detail: `Invalid JSON: ${formatError(err)}` }
  }

  if (!Array.isArray(parsed)) {
    return { status: 'unreadable', detail: 'Expected top-level JSON array in AddonGameInstance.json' }
  }

  let simsInstance: Record<string, unknown> | null = null
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i]
    if (!isRecord(item)) {
      return { status: 'unreadable', detail: `Entry ${i} in AddonGameInstance.json is not an object` }
    }
    if (item.gameID === SIMS4_CURSEFORGE_GAME_ID && simsInstance === null) {
      simsInstance = item
    }
  }

  if (simsInstance === null) {
    return { status: 'not-found' }
  }

  const rawAddons = simsInstance.installedAddons
  if (!Array.isArray(rawAddons)) {
    return { status: 'unreadable', detail: 'Sims 4 instance installedAddons is not an array' }
  }

  const addons: CurseForgeAddon[] = []
  for (let i = 0; i < rawAddons.length; i += 1) {
    const result = parseAddon(rawAddons[i], i)
    if (!result.ok) {
      return { status: 'unreadable', detail: result.detail }
    }
    if (result.addon !== null) {
      addons.push(result.addon)
    }
  }

  return { status: 'found', file: instanceFile, addons }
}
