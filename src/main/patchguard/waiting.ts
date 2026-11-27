import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ClearHoldingResult, CurseForgeAddon, JournalEntry, WaitingOnMod } from '../../shared/model.ts'
import { samePath } from '../fixes/index.ts'
import { readCurseForge } from '../inventory/curseforge.ts'
import type { AppContext } from '../ports.ts'
import { entryFile, findEntry } from '../safety/journal.ts'
import { isSafeId } from '../safety/where.ts'
import { locateCurrentInstall } from './watch.ts'

const CF_GROUP_ID = /^cf:(\d+)$/i
const MOD_FILE_EXT = /\.(package|ts4script)$/i

interface ModsIndex {
  /** Lowercased basename -> newest mtimeMs among matching files in Mods/ (.package / .ts4script only). */
  baseNames: Map<string, number>
}

function isModFileName(pathOrName: string): boolean {
  return MOD_FILE_EXT.test(pathOrName)
}

function parseCurseForgeAddonId(groupId: string): number | null {
  const match = CF_GROUP_ID.exec(groupId)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

function normalizeSlashPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function baseNameOf(slashPath: string): string {
  const idx = slashPath.lastIndexOf('/')
  return idx === -1 ? slashPath : slashPath.slice(idx + 1)
}

function normalizePathKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePathKey(targetPath)
  const normRoot = normalizePathKey(rootPath).replace(/[\\/]+$/, '')
  return normTarget === normRoot || normTarget.startsWith(normRoot + sep)
}

async function readSavedFolderPath(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'folderPath' in parsed) {
      const folderPath = (parsed as { folderPath?: unknown }).folderPath
      if (typeof folderPath === 'string' && folderPath.length > 0) {
        return folderPath
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Date of the last game update: mtime of <install>/Game/Bin/TS4_x64.exe (same definition as readFolderFacts).
 * Null when the install or exe cannot be read.
 */
async function readVersionChangeTimeMs(ctx: AppContext): Promise<number | null> {
  const install = await locateCurrentInstall(ctx)
  if (!install) return null
  try {
    const info = await stat(join(install.path, 'Game', 'Bin', 'TS4_x64.exe'))
    return info.isFile() ? info.mtime.getTime() : null
  } catch {
    return null
  }
}

async function collectModsIndex(modsDir: string): Promise<ModsIndex> {
  const baseNames = new Map<string, number>()

  let modsRealRoot: string
  try {
    const rootInfo = await stat(modsDir)
    if (!rootInfo.isDirectory()) return { baseNames }
    modsRealRoot = await realpath(modsDir)
  } catch {
    return { baseNames }
  }

  const visitedDirs = new Set<string>([normalizePathKey(modsRealRoot)])

  async function walk(dirPath: string, relDir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (depth === 0 && entry.name.toLowerCase() === 'resource.cfg') continue
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const fullPath = join(dirPath, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        let targetReal: string
        try {
          targetReal = await realpath(fullPath)
        } catch {
          continue
        }
        if (!isInsideRoot(targetReal, modsRealRoot)) continue
        const key = normalizePathKey(targetReal)
        if (visitedDirs.has(key)) continue
        visitedDirs.add(key)
        await walk(fullPath, relPath, depth + 1)
        continue
      }
      if (entry.isFile() && isModFileName(entry.name)) {
        try {
          const info = await lstat(fullPath)
          if (!info.isFile()) continue
          const lowerBase = entry.name.toLowerCase()
          const prev = baseNames.get(lowerBase)
          if (prev === undefined || info.mtimeMs > prev) {
            baseNames.set(lowerBase, info.mtimeMs)
          }
        } catch {
          // Skip unreadable file
        }
      }
    }
  }

  await walk(modsDir, '', 0)
  return { baseNames }
}

/**
 * True only when EVERY mod file the entry set aside is accounted for back in Mods/, so "Clear the old copy" can
 * never delete a held file that has no replacement. A moved file is accounted for when:
 * (a) a file sits again at its exact original path, or
 * (b) CurseForge has a newer file for the addon than the set-aside time (fileDate > at) AND a .package or
 *     .ts4script with the same file name, modified after the set-aside time, is somewhere in Mods/.
 * One file back after a partial reinstall, or an unrelated mod that happens to share a file name while the addon has
 * no newer CurseForge file, never counts for the whole group.
 */
async function isEntryBackInMods(
  entry: JournalEntry,
  addon: CurseForgeAddon | null,
  modsIndex: ModsIndex
): Promise<boolean> {
  const movedModFiles = entry.steps.flatMap((step) =>
    step.kind === 'move' && isModFileName(step.from) ? [step.from] : []
  )
  if (movedModFiles.length === 0) return false

  const setAsideMs = Date.parse(entry.at)
  const addonMs = addon !== null ? Date.parse(addon.fileDate) : Number.NaN
  const addonIsNewer = Number.isFinite(setAsideMs) && Number.isFinite(addonMs) && addonMs > setAsideMs

  for (const from of movedModFiles) {
    if (await isFileAt(from)) continue
    if (addonIsNewer) {
      const lowerBase = baseNameOf(normalizeSlashPath(from)).toLowerCase()
      const baseMtime = lowerBase !== '' ? modsIndex.baseNames.get(lowerBase) : undefined
      if (baseMtime !== undefined && baseMtime > setAsideMs) continue
    }
    return false
  }
  return true
}

async function isFileAt(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function classifyEntry(
  entry: JournalEntry,
  addonMap: ReadonlyMap<number, CurseForgeAddon>,
  modsIndex: ModsIndex
): Promise<Pick<WaitingOnMod, 'state' | 'updatedAt'>> {
  const addonId = entry.groupId !== null ? parseCurseForgeAddonId(entry.groupId) : null
  if (addonId === null) {
    return { state: 'not-curseforge', updatedAt: null }
  }

  const addon = addonMap.get(addonId) ?? null
  const setAsideMs = Date.parse(entry.at)
  const addonMs = addon !== null ? Date.parse(addon.fileDate) : Number.NaN
  const isNewer =
    addon !== null && Number.isFinite(setAsideMs) && Number.isFinite(addonMs) && addonMs > setAsideMs

  if (await isEntryBackInMods(entry, addon, modsIndex)) {
    return { state: 'back-in-mods', updatedAt: isNewer ? addon.fileDate : null }
  }

  if (isNewer) {
    return { state: 'updated', updatedAt: addon.fileDate }
  }

  return { state: 'waiting', updatedAt: null }
}

async function loadCurseForgeAddonMap(instanceFile: string | null): Promise<Map<number, CurseForgeAddon>> {
  const map = new Map<number, CurseForgeAddon>()
  const read = await readCurseForge(instanceFile)
  if (read.status !== 'found') return map
  for (const addon of read.addons) {
    if (!map.has(addon.addonId)) {
      map.set(addon.addonId, addon)
    }
  }
  return map
}

/**
 * Lists every set-aside group (origin: 'fix') newer than the game update, classified against local
 * CurseForge metadata (AddonGameInstance.json) and Mods/ on disk. No network calls.
 */
export async function listWaitingOnMods(ctx: AppContext): Promise<WaitingOnMod[]> {
  await ctx.startupRecovery()
  const [entries, folderPath, versionChangeMs, addonMap] = await Promise.all([
    ctx.safety.listJournal(),
    ctx.session.scan?.folder.path
      ? Promise.resolve(ctx.session.scan.folder.path)
      : readSavedFolderPath(ctx.paths.stateDir),
    readVersionChangeTimeMs(ctx),
    loadCurseForgeAddonMap(ctx.paths.curseForgeInstanceFile)
  ])

  const modsIndexes = new Map<string, Promise<ModsIndex>>()
  const getModsIndex = (simsFolder: string): Promise<ModsIndex> => {
    const key = normalizePathKey(simsFolder)
    let pending = modsIndexes.get(key)
    if (!pending) {
      pending = collectModsIndex(join(simsFolder, 'Mods'))
      modsIndexes.set(key, pending)
    }
    return pending
  }

  const seenGroups = new Set<string>()
  const waiting: WaitingOnMod[] = []

  for (const entry of entries) {
    if (
      entry.action !== 'disable-group' ||
      entry.status !== 'done' ||
      entry.groupId === null ||
      entry.origin.by !== 'fix'
    ) {
      continue
    }
    if (folderPath !== null && !samePath(entry.folderPath, folderPath)) {
      continue
    }
    if (seenGroups.has(entry.groupId)) continue
    seenGroups.add(entry.groupId)

    if (versionChangeMs !== null) {
      const entryMs = Date.parse(entry.at)
      if (!Number.isFinite(entryMs) || entryMs <= versionChangeMs) {
        continue
      }
    }

    const modsIndex = await getModsIndex(entry.folderPath)
    const { state, updatedAt } = await classifyEntry(entry, addonMap, modsIndex)
    waiting.push({
      groupId: entry.groupId,
      label: entry.groupLabel ?? 'A mod',
      entryId: entry.id,
      setAsideAt: entry.at,
      state,
      updatedAt
    })
  }

  return waiting.sort((a, b) => {
    const cmp = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    return cmp !== 0 ? cmp : a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0
  })
}

/**
 * "Clear the old copy" on a back-in-mods entry: verifies the entry is genuinely back-in-mods,
 * removes its holding folder in app data through the gate, and marks the journal entry settled so it
 * disappears from Waiting on and Undo can never put an old copy back beside the new one.
 */
export async function clearHoldingEntry(ctx: AppContext, entryId: string): Promise<ClearHoldingResult> {
  await ctx.startupRecovery()

  if (typeof entryId !== 'string' || !isSafeId(entryId)) {
    return { kind: 'refused', why: 'not-found' }
  }

  const found = await findEntry(ctx.paths.journalDir, entryId)
  if (found === 'missing') {
    return { kind: 'refused', why: 'not-found' }
  }
  if (found === 'unreadable') {
    return { kind: 'refused', why: 'error' }
  }
  if (
    found.action !== 'disable-group' ||
    found.status !== 'done' ||
    found.groupId === null ||
    found.origin.by !== 'fix'
  ) {
    return { kind: 'refused', why: 'not-found' }
  }

  const [addonMap, modsIndex] = await Promise.all([
    loadCurseForgeAddonMap(ctx.paths.curseForgeInstanceFile),
    collectModsIndex(join(found.folderPath, 'Mods'))
  ])
  const { state } = await classifyEntry(found, addonMap, modsIndex)
  if (state !== 'back-in-mods') {
    return { kind: 'refused', why: 'not-back-in-mods' }
  }

  const updatedEntry: JournalEntry = {
    ...found,
    status: 'undone',
    undo: 'cannot-undo',
    undoneAt: ctx.clock.now().toISOString(),
    steps: found.steps.map((step) => ({ ...step, state: 'reverted' as const }))
  }

  const holdingEntryDir = join(ctx.paths.holdingDir, found.id)
  const journalPath = entryFile(ctx.paths.journalDir, found.id)

  try {
    // Settle the journal entry first so a failed write leaves holding untouched, and a failed remove leaves
    // only a harmless holding copy without offering a broken Undo in History.
    const result = await ctx.gate.run({
      reason: 'journal',
      folderPath: null,
      ops: [
        { op: 'write', path: journalPath, data: JSON.stringify(updatedEntry), mode: 'replace' },
        { op: 'remove', path: holdingEntryDir }
      ]
    })
    return result.status === 'done' ? { kind: 'done' } : { kind: 'refused', why: 'error' }
  } catch {
    return { kind: 'refused', why: 'error' }
  }
}
