import { readFile, realpath, stat } from 'node:fs/promises'
import nativePath, { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { ModFolderState } from '../../shared/model.ts'
import { locate } from '../locate/index.ts'
import { LOCALIZED_SIMS_FOLDER_NAMES, normalizeSimsFolderName } from '../locate/user-folders.ts'
import type { AppContext } from '../ports.ts'
import { setModFolderRoot } from './mod-folder.ts'

export const MOD_FOLDER_NAME = 'Sims Helper Mods'
export const MOD_FOLDER_STATE_FILE = 'mod-folder.json'

const FORBIDDEN_NAMES = new Set(['saves', 'tray'])
const SIMS_FOLDER_NAMES = new Set(LOCALIZED_SIMS_FOLDER_NAMES.map(normalizeSimsFolderName))
const SYSTEM_FOLDER_NAMES = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information'
])
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/i
const CHARS_NO_WINDOWS_NAME_HOLDS = /[<>"|?*\u0000-\u001f]/

const fold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
const looseFold = (text: string): string => text.normalize('NFKC').toUpperCase().toLowerCase()

function isDriveRoot(place: string): boolean {
  return parse(place).root === place
}

function isWellFormed(target: string): boolean {
  if (target === '') return false
  if (nativePath.sep === '/' && target.includes('\\')) return false
  if (!isAbsolute(target) || resolve(target) !== target) return false
  const root = parse(target).root
  if (nativePath.sep === '\\' && !/^[A-Za-z]:\\$/.test(root)) return false
  const rest = target.slice(root.length)
  if (rest === '') return true
  return rest.split(nativePath.sep).every(
    (part) =>
      part !== '' &&
      !/[. ]$/.test(part) &&
      !part.includes(':') &&
      !CHARS_NO_WINDOWS_NAME_HOLDS.test(part) &&
      !DEVICE_NAME.test(part)
  )
}

function looseParts(target: string): string[] | null {
  const text =
    nativePath.sep === '\\'
      ? target.replace(/^[\\/]{2}[?.][\\/](?!UNC[\\/])/i, '')
      : target.replaceAll('\\', '/')
  if (!isAbsolute(text)) return null
  const resolved = resolve(text)
  const root = parse(resolved).root
  const rest = resolved.slice(root.length)
  const names = rest === '' ? [] : rest.split(nativePath.sep)
  return [root, ...names.map((name) => name.split(':')[0]!.replace(/[. ]+$/, ''))]
}

function partsBelow(parts: string[], rootParts: string[] | null, same: (text: string) => string): string[] | null {
  if (rootParts === null || parts.length < rootParts.length) return null
  if (!rootParts.every((name, index) => same(name) === same(parts[index]!))) return null
  return parts.slice(rootParts.length)
}

function isInsideLoose(target: string, root: string): boolean {
  const parts = looseParts(target)
  return parts !== null && partsBelow(parts, looseParts(root), looseFold) !== null
}

function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function statOrNull(target: string) {
  try {
    return await stat(target)
  } catch (err) {
    if (isMissingError(err)) return null
    throw err
  }
}

async function hasAncestorOptionsIni(folderPath: string): Promise<boolean> {
  for (let place = folderPath; ; place = dirname(place)) {
    if ((await statOrNull(join(place, 'Options.ini'))) !== null) return true
    const parent = dirname(place)
    if (isDriveRoot(place) || parent === place) break
  }
  return false
}

async function readSavedSimsFolder(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'folderPath' in parsed) {
      const value = (parsed as { folderPath?: unknown }).folderPath
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return null
  } catch {
    return null
  }
}

async function knownSimsFolders(ctx: AppContext): Promise<string[]> {
  const dirs: string[] = []
  const add = (p: string | null | undefined) => {
    if (typeof p === 'string' && p.trim() !== '') dirs.push(p)
  }
  add(ctx.session.scan?.folder.path)
  add(await readSavedSimsFolder(ctx.paths.stateDir))
  try {
    const located = await locate(ctx.host)
    for (const f of located.userFolders) add(f.path)
  } catch {
    // Best-effort locate; ancestor Options.ini and localized Sims folder names still guard below.
  }
  const resolved: string[] = []
  for (const dir of dirs) {
    resolved.push(dir)
    try {
      resolved.push(await realpath(dir))
    } catch {
      // Ignore if missing
    }
  }
  return resolved
}

function overlapsAny(place: string, others: readonly string[]): boolean {
  return others.some((other) => isInsideLoose(place, other) || isInsideLoose(other, place))
}

function hasSimsOrForbiddenSegment(place: string): boolean {
  const names = (looseParts(place) ?? []).slice(1)
  if (names.some((name) => FORBIDDEN_NAMES.has(looseFold(name)))) return true
  if (names.some((name) => SIMS_FOLDER_NAMES.has(normalizeSimsFolderName(name)))) return true
  return false
}

function hasSystemSegment(place: string): boolean {
  const names = (looseParts(place) ?? []).slice(1)
  return names.some((name) => SYSTEM_FOLDER_NAMES.has(looseFold(name)))
}

/**
 * Checks a candidate Sims Helper Mods folder with the exact same rules as gate.ts checkModFolder,
 * returning the typed ModFolderState for the setup screen.
 */
export async function validateModFolder(rawPath: string, ctx: AppContext): Promise<ModFolderState> {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { kind: 'not-set' }
  }

  // Strip only trailing path separators (never spaces or dots) so a picker path like "G:\Sims Helper Mods\" works.
  const root = parse(rawPath).root
  const candidate =
    rawPath.length > root.length
      ? root + rawPath.slice(root.length).replace(nativePath.sep === '\\' ? /[\\/]+$/ : /\/+$/, '')
      : rawPath

  if (!isWellFormed(candidate) || isDriveRoot(candidate)) {
    return { kind: 'wrong-name', path: candidate }
  }

  let info
  try {
    info = await statOrNull(candidate)
  } catch {
    return { kind: 'missing', path: candidate }
  }
  if (!info?.isDirectory()) {
    return { kind: 'missing', path: candidate }
  }

  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return { kind: 'missing', path: candidate }
  }

  const simsFolders = await knownSimsFolders(ctx)
  if (
    hasSimsOrForbiddenSegment(candidate) ||
    hasSimsOrForbiddenSegment(real) ||
    overlapsAny(candidate, simsFolders) ||
    overlapsAny(real, simsFolders) ||
    (await hasAncestorOptionsIni(candidate)) ||
    (await hasAncestorOptionsIni(real))
  ) {
    return { kind: 'in-sims-folder', path: candidate }
  }

  if (basename(candidate) !== MOD_FOLDER_NAME || basename(real) !== MOD_FOLDER_NAME) {
    return { kind: 'wrong-name', path: candidate }
  }

  // Must resolve to itself (no symlink, junction, or 8.3 short name anywhere on its path).
  if (fold(real) !== fold(candidate)) {
    return { kind: 'wrong-name', path: candidate }
  }

  // Must stay apart from system folders and app data.
  const dataDirs = [ctx.paths.dataDir]
  try {
    dataDirs.push(await realpath(ctx.paths.dataDir))
  } catch {
    // dataDir may not exist yet on first run
  }
  if (
    hasSystemSegment(candidate) ||
    hasSystemSegment(real) ||
    overlapsAny(candidate, dataDirs) ||
    overlapsAny(real, dataDirs)
  ) {
    return { kind: 'wrong-name', path: candidate }
  }

  return { kind: 'set', path: candidate }
}

async function readSavedModFolderPath(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, MOD_FOLDER_STATE_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'path' in parsed) {
      const value = (parsed as { path?: unknown }).path
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return null
  } catch {
    return null
  }
}

/**
 * Loads state/mod-folder.json asynchronously, validates it, and syncs the in-memory getter
 * used by GateDeps.modFolderRoot(). Called at the start of every requests:* handler.
 */
export async function syncModFolder(ctx: AppContext): Promise<ModFolderState> {
  const saved = await readSavedModFolderPath(ctx.paths.stateDir)
  if (saved === null) {
    setModFolderRoot(null)
    return { kind: 'not-set' }
  }
  const state = await validateModFolder(saved, ctx)
  setModFolderRoot(state.kind === 'set' ? state.path : null)
  return state
}

export async function pickAndSaveModFolder(ctx: AppContext): Promise<ModFolderState> {
  const picked = await ctx.pickFolder()
  if (picked === null) {
    return await syncModFolder(ctx)
  }

  const state = await validateModFolder(picked, ctx)
  if (state.kind !== 'set') {
    return state
  }

  const statePath = join(ctx.paths.stateDir, MOD_FOLDER_STATE_FILE)
  const written = await ctx.gate.run({
    reason: 'state',
    folderPath: null,
    ops: [
      { op: 'mkdir', path: ctx.paths.stateDir },
      {
        op: 'write',
        path: statePath,
        data: `${JSON.stringify({ path: state.path }, null, 2)}\n`,
        mode: 'replace'
      }
    ]
  })

  if (written.status !== 'done') {
    return await syncModFolder(ctx)
  }

  setModFolderRoot(state.path)
  return state
}
