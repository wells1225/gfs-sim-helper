// The write gate: the only code in the app that changes the disk (contracts.md, section 5).
// It checks a whole request first, and only then does the ops itself. Any doubt while checking refuses.
import { createHash, randomBytes } from 'node:crypto'
import type { BigIntStats, Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import nativePath from 'node:path'
import type { PlatformPath } from 'node:path'
import type { GameRunState, GateRefusal } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import { LOCALIZED_SIMS_FOLDER_NAMES, normalizeSimsFolderName } from '../locate/user-folders.ts'
import { CACHE_NAMES } from '../ports.ts'
import type { GateDeps, GateResult, WriteOp, WriteRequest } from '../ports.ts'

export type Zone =
  | 'forbidden'
  | 'mods'
  | 'caches'
  | 'options'
  | 'app-data'
  | 'report'
  | 'mod-folder'
  | 'sims-other'
  | 'none'

/** The folders the zones hang from. Compared without regard to letter case, on every machine. */
export interface GateRoots {
  folderPath: string | null
  dataDir: string
  desktopDir: string | null
  /** The Sims Helper Mods folder (PR 17), only once the gate has checked it. Absent or null: no mod-folder zone. */
  modFolder?: string | null
}

export interface SortedPath {
  zone: Zone
  /** The path is the Mods folder or the app data folder itself, not something inside it. */
  atRoot: boolean
  /** Written out in full, in the one form Windows cannot read as a different path. */
  wellFormed: boolean
}

type WriteUse = 'mkdir' | 'copy-to' | 'move' | 'write-create' | 'write-replace' | 'remove'

// The table in briefs/pr-08.md. An op in any other zone is refused. Nothing in Mods is ever
// removed or overwritten, and nothing but a cache is ever removed from the Sims folder. The mod folder takes
// only her request file and its folder, and only for a mod-request (modFolderWrite says which names).
const WRITE_ZONES: Record<WriteUse, readonly Zone[]> = {
  mkdir: ['mods', 'app-data', 'mod-folder'],
  'copy-to': ['app-data'],
  move: ['mods', 'app-data'],
  'write-create': ['app-data', 'report', 'mod-folder'],
  'write-replace': ['options', 'app-data'],
  remove: ['caches', 'app-data']
}
// The source of a copy is only read: anywhere in the Sims folder (saves too: that is the backup) or app data,
// and a delivered mod in the mod folder for a mod-install (modFolderRead says which).
const READ_ZONES: readonly Zone[] = ['forbidden', 'mods', 'caches', 'options', 'sims-other', 'app-data', 'mod-folder']
// A write to one of these needs the game closed and a verified backup.
const GUARDED_ZONES: readonly Zone[] = ['mods', 'caches', 'options']

// Letter case as an allow check may ignore it: A to Z and nothing else. Windows keeps its own table for the
// other letters, and JavaScript lower-casing knows pairs that table does not (the Kelvin sign becomes k).
const fold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
// Wider than Windows itself, and used only to forbid: a name that could be read as saves or Tray is one.
const looseFold = (text: string): string => text.normalize('NFKC').toUpperCase().toLowerCase()

const FORBIDDEN_NAMES = new Set(['saves', 'tray'])
const SIMS_FOLDER_NAMES = new Set(LOCALIZED_SIMS_FOLDER_NAMES.map(normalizeSimsFolderName))
const CACHE_KINDS = new Map<string, 'file' | 'folder'>(
  CACHE_NAMES.map((name) => [fold(name.replace(/\/$/, '')), name.endsWith('/') ? 'folder' : 'file'])
)
const REPORT_NAME = /^Sims Helper report \d{8}-\d{6}\.zip$/
// save-new-slot (briefs/pr-15.md, round 7): the one name in saves/ the gate ever writes. Eight lower-case hex
// digits, the first one 0: EA's helpers report saves starting with another digit failing to load.
const NEW_SLOT_NAME = /^Slot_0[0-9a-f]{7}\.save$/
// mod-folder (briefs/pr-17.md, round 7): the shared folder's exact name, and her request file in it.
const MOD_FOLDER_NAME = 'Sims Helper Mods'
const REQUESTS_FOLDER = 'requests'
const REQUEST_NAME = /^r-\d{8}-\d{6}-[a-z0-9]{4}\.json$/
const DELIVERIES_FOLDER = 'from-tyler'
// Folders the mod folder may never be inside: Windows itself, programs, and the hidden app folders.
// AppData is not one of them: Windows keeps its temp folder there, and dataDir is kept apart on its own.
const SYSTEM_FOLDER_NAMES = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information'
])
// Names Windows hands to a device, with or without an extension. Spaces before the dot do not save a name:
// 'NUL .package' is still the device.
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9\u00b9\u00b2\u00b3]) *(\..*)?$/i
const CHARS_NO_WINDOWS_NAME_HOLDS = /[<>"|?*\u0000-\u001f]/


function isWellFormed(pathApi: PlatformPath, target: unknown): target is string {
  if (typeof target !== 'string' || target === '') return false
  if (pathApi.sep === '/' && target.includes('\\')) return false
  if (!pathApi.isAbsolute(target) || pathApi.resolve(target) !== target) return false // relative, '..', '/' for '\'
  const root = pathApi.parse(target).root
  // On Windows only a drive letter may start a path: no UNC share, no \\?\ and no \\.\
  if (pathApi.sep === '\\' && !/^[A-Za-z]:\\$/.test(root)) return false
  const rest = target.slice(root.length)
  if (rest === '') return true
  return rest.split(pathApi.sep).every(
    (part) =>
      part !== '' &&
      !/[. ]$/.test(part) && // Windows drops trailing dots and spaces: 'saves.' is 'saves'
      !part.includes(':') && // a data stream
      !CHARS_NO_WINDOWS_NAME_HOLDS.test(part) &&
      !DEVICE_NAME.test(part)
  )
}

/**
 * The parts of a path as Windows would end up reading it: the root, then each name with '..' applied and
 * with data streams and trailing dots and spaces dropped. Null when the path is not absolute.
 */
function looseParts(pathApi: PlatformPath, target: unknown): string[] | null {
  if (typeof target !== 'string') return null
  const text =
    pathApi.sep === '\\'
      ? target.replace(/^[\\/]{2}[?.][\\/](?!UNC[\\/])/i, '') // \\?\C:\x is C:\x
      : target.replaceAll('\\', '/')
  if (!pathApi.isAbsolute(text)) return null
  const resolved = pathApi.resolve(text)
  const root = pathApi.parse(resolved).root
  const rest = resolved.slice(root.length)
  const names = rest === '' ? [] : rest.split(pathApi.sep)
  return [root, ...names.map((name) => name.split(':')[0]!.replace(/[. ]+$/, ''))]
}

/** The parts of a path below a root, or null when the path is not the root or inside it. */
function partsBelow(parts: string[], rootParts: string[] | null, same: (text: string) => string): string[] | null {
  if (rootParts === null || parts.length < rootParts.length) return null
  if (!rootParts.every((name, index) => same(name) === same(parts[index]!))) return null
  return parts.slice(rootParts.length)
}

/** Only ever used to forbid, so it matches widely. */
function isInside(pathApi: PlatformPath, target: string, root: string): boolean {
  const parts = looseParts(pathApi, target)
  return parts !== null && partsBelow(parts, looseParts(pathApi, root), looseFold) !== null
}

/**
 * Sorts a path into a zone by its name alone. No disk access, and any path flavour, so the Windows rules are
 * tested on every machine. A malformed path is still sorted, so that a path into saves always says so.
 */
export function sortPath(pathApi: PlatformPath, roots: GateRoots, target: unknown): SortedPath {
  const wellFormed = isWellFormed(pathApi, target)
  const sorted = (zone: Zone, atRoot = false): SortedPath => ({ zone, atRoot, wellFormed })
  const parts = looseParts(pathApi, target)
  if (parts === null) return sorted('none')

  if (roots.folderPath !== null) {
    const simsParts = looseParts(pathApi, roots.folderPath)
    const perhapsInside = partsBelow(parts, simsParts, looseFold)
    if (perhapsInside?.[0] !== undefined && FORBIDDEN_NAMES.has(looseFold(perhapsInside[0]))) {
      return sorted('forbidden')
    }
    const inside = partsBelow(parts, simsParts, fold)
    if (inside !== null) {
      const first = inside[0] === undefined ? '' : fold(inside[0])
      if (first === 'mods') return sorted('mods', inside.length === 1)
      if (inside.length === 1 && CACHE_KINDS.has(first)) return sorted('caches')
      if (inside.length === 1 && first === 'options.ini') return sorted('options')
      return sorted('sims-other')
    }
  }

  const inData = partsBelow(parts, looseParts(pathApi, roots.dataDir), fold)
  if (inData !== null) return sorted('app-data', inData.length === 0)

  if (roots.modFolder !== undefined && roots.modFolder !== null) {
    const inMods = partsBelow(parts, looseParts(pathApi, roots.modFolder), fold)
    if (inMods !== null) return sorted('mod-folder', inMods.length === 0)
  }

  if (roots.desktopDir !== null && wellFormed) {
    const onDesktop = partsBelow(parts, looseParts(pathApi, roots.desktopDir), fold)
    if (onDesktop?.length === 1 && REPORT_NAME.test(onDesktop[0]!)) return sorted('report')
  }
  return sorted('none')
}

function mayWrite(use: WriteUse, sorted: SortedPath): boolean {
  return WRITE_ZONES[use].includes(sorted.zone) && (!sorted.atRoot || use === 'mkdir')
}

const isDriveRoot = (place: string): boolean => nativePath.parse(place).root === place

/** A folder path with no separator at its end. A bare drive root keeps its own: 'C:\' is not 'C:'. */
function withoutTrailingSeparators(place: string): string {
  const root = nativePath.parse(place).root
  return root + place.slice(root.length).replace(nativePath.sep === '\\' ? /[\\/]+$/ : /\/+$/, '')
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : undefined
}

function isMissing(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

/** Follows links. Null only when nothing is there: any other error is a check that failed. */
async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

// A file can have a second name (a hard link) that no path check can see through. The file id can.
const fileId = (info: BigIntStats): string => `${info.dev}:${info.ino}`

/** The ids of the files under these folders that have more than one name. Links are not followed. */
async function manyNamedFilesUnder(folders: string[]): Promise<Set<string>> {
  const ids = new Set<string>()
  async function walk(folder: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(folder)
    } catch (err) {
      if (isMissing(err)) return
      throw err
    }
    for (const name of names) {
      const entry = nativePath.join(folder, name)
      const info = await lstat(entry, { bigint: true })
      if (info.isDirectory()) await walk(entry)
      else if (info.isFile() && info.nlink > 1n) ids.add(fileId(info))
    }
  }
  for (const folder of folders) await walk(folder)
  return ids
}

/** The name exists and leads nowhere. That is an answer about the path, not a check that failed. */
class LinkToNowhere extends Error {}

/**
 * Where a path really leads: links, junctions and short 8.3 names resolved on the part that exists, the rest
 * re-attached. Throws on anything but a plainly missing tail. Answers are kept for one check only.
 */
function makeResolver(): (target: string) => Promise<string> {
  const known = new Map<string, Promise<string>>()
  const resolveReal = (target: string): Promise<string> => {
    let answer = known.get(target)
    if (answer === undefined) {
      answer = lookUp(target)
      known.set(target, answer)
    }
    return answer
  }
  async function lookUp(target: string): Promise<string> {
    try {
      return await realpath(target)
    } catch (err) {
      if (!isMissing(err)) throw err
    }
    // It has no real path. If the name still exists, it is a link that leads nowhere: never write through it.
    if ((await lstatOrNull(target)) !== null) throw new LinkToNowhere()
    const parent = nativePath.dirname(target)
    if (parent === target) throw new Error('nothing on this path exists')
    return nativePath.join(await resolveReal(parent), nativePath.basename(target))
  }
  return resolveReal
}

/** A path the gate checked, and where it really led when it was checked. */
interface Lead {
  path: string
  real: string
}

/** The gate's own copy of what was asked, so nothing a caller does later can change a request that was checked. */
interface Asked {
  folderPath: string | null
  /**
   * The request's reason as given. Most zones ignore it; save-new-slot and mod-folder each need their own. Not
   * named `reason`: a refusal is told apart from everything else by that key.
   */
  purpose: string
  secret: boolean
  ops: WriteOp[]
  dataDir: string
  desktopDir: string
  oneDriveRoots: string[]
  saveCopiesDir: string | null
  /** What deps.modFolderRoot() said, asked once for this request, and only for a mod-request or mod-install. */
  modFolderRoot: string | null
}

/** The folders a request stands on, as one check found them. */
interface Ground {
  roots: GateRoots
  realRoots: GateRoots
  /** Where saves and Tray really are. */
  realForbidden: string[]
  /** Where saves really is, or null with no Sims folder. */
  realSaves: string | null
  leads: Lead[]
}

interface Approved {
  asked: Asked
  ground: Ground
  /** For each op, its paths in order. */
  opLeads: Lead[][]
  guarded: boolean
  /** A save put back: the game must be closed, and no backup is needed. */
  gameOnly: boolean
}

/** What one check has learned from the disk. Never kept for a later check. */
interface Glance {
  real(target: string): Promise<string>
  forbiddenIds: Promise<Set<string>> | null
}

const newGlance = (): Glance => ({ real: makeResolver(), forbiddenIds: null })

const shown = (value: unknown): string => (typeof value === 'string' ? value : '')
const outside = (path: unknown): GateRefusal => ({ reason: 'outside-allowed-area', path: shown(path) })
const savesOrTray = (path: string): GateRefusal => ({ reason: 'saves-or-tray', path })
const PUT_BACK = 'save-put-back'
const MOD_REQUEST = 'mod-request'
const MOD_INSTALL = 'mod-install'
const linkEscape = (path: string): GateRefusal => ({ reason: 'link-escape', path })
// The gate could not find out. It never guesses, and it never blames the path for it.
const checkFailed = (path: unknown): GateRefusal => ({ reason: 'check-failed', path: shown(path) })

/** A copy of the op with only the fields the gate knows, or null when it is not an op the gate knows. */
function readOp(op: unknown): WriteOp | null {
  if (typeof op !== 'object' || op === null) return null
  const { op: kind, path, from, to, data, mode } = op as Record<string, unknown>
  if ((kind === 'mkdir' || kind === 'remove') && typeof path === 'string') return { op: kind, path }
  if ((kind === 'copy' || kind === 'move') && typeof from === 'string' && typeof to === 'string') {
    return { op: kind, from, to }
  }
  if (
    kind === 'write' &&
    typeof path === 'string' &&
    (mode === 'create' || mode === 'replace') &&
    (typeof data === 'string' || data instanceof Uint8Array)
  ) {
    return { op: kind, path, data, mode }
  }
  return null
}

function readRequest(deps: GateDeps, request: WriteRequest): Asked | GateRefusal {
  if (typeof request !== 'object' || request === null) return outside('')
  const { folderPath } = request
  if (!Array.isArray(request.ops) || (folderPath !== null && typeof folderPath !== 'string')) return outside('')
  const ops: WriteOp[] = []
  for (const given of request.ops) {
    const op = readOp(given)
    if (op === null) return outside((given as { path?: unknown } | null)?.path)
    ops.push(op)
  }
  const { dataDir, desktopDir, oneDriveRoots, saveCopiesDir } = deps.paths
  const reason = typeof request.reason === 'string' ? request.reason : ''
  return {
    folderPath,
    purpose: reason,
    secret: reason === 'key',
    ops,
    dataDir,
    desktopDir,
    oneDriveRoots: [...oneDriveRoots],
    saveCopiesDir: typeof saveCopiesDir === 'string' ? saveCopiesDir : null,
    modFolderRoot: reason === MOD_REQUEST || reason === MOD_INSTALL ? askModFolderRoot(deps) : null
  }
}

/** The mod folder as deps tells it. Anything but a plain string, a throw included, is no folder. */
function askModFolderRoot(deps: GateDeps): string | null {
  try {
    const root: unknown = deps.modFolderRoot()
    return typeof root === 'string' ? root : null
  } catch {
    return null
  }
}

/** Each path of an op, with what the op does there. */
function pathUses(op: WriteOp): [string, WriteUse | 'read'][] {
  if (op.op === 'copy') {
    return [
      [op.from, 'read'],
      [op.to, 'copy-to']
    ]
  }
  if (op.op === 'move') {
    return [
      [op.from, 'move'],
      [op.to, 'move']
    ]
  }
  return [[op.path, op.op === 'write' ? `write-${op.mode}` : op.op]]
}

/** The path is a saves or Tray folder, or inside one, wherever that folder is. */
function hasForbiddenName(place: string): boolean {
  const names = (looseParts(nativePath, place) ?? []).slice(1)
  return names.some((name) => FORBIDDEN_NAMES.has(looseFold(name)))
}

/** Checks the folders a request stands on. Nothing here changes the disk. */
async function checkGround(asked: Asked, glance: Glance): Promise<Ground | GateRefusal> {
  const { folderPath, dataDir } = asked
  const leads: Lead[] = []

  // The app data folder holds the backups. Inside a Sims folder or OneDrive it refuses every request.
  // So does a whole drive: every path on it would count as the helper's own.
  if (!isWellFormed(nativePath, dataDir) || isDriveRoot(dataDir)) return outside(dataDir)
  let realData: string
  try {
    realData = await glance.real(dataDir)
  } catch (err) {
    return err instanceof LinkToNowhere ? outside(dataDir) : checkFailed(dataDir)
  }
  leads.push({ path: dataDir, real: realData })
  const cloudRoots: string[] = []
  for (const given of asked.oneDriveRoots) {
    // An environment variable may end in a separator. It is the same folder, and its links are followed too.
    const root = withoutTrailingSeparators(given)
    cloudRoots.push(root)
    if (!isWellFormed(nativePath, root)) continue
    try {
      const realRoot = await glance.real(root)
      cloudRoots.push(realRoot)
      leads.push({ path: root, real: realRoot })
    } catch {
      return checkFailed(root)
    }
  }
  if (isDriveRoot(realData)) return outside(dataDir)
  for (const place of [dataDir, realData]) {
    const names = (looseParts(nativePath, place) ?? []).slice(1)
    if (names.some((name) => SIMS_FOLDER_NAMES.has(normalizeSimsFolderName(name)))) return outside(dataDir)
    if (names.some((name) => looseFold(name).startsWith('onedrive'))) return outside(dataDir)
    if (cloudRoots.some((root) => isInside(nativePath, place, root))) return outside(dataDir)
  }

  // The Sims folder is the folder that holds Options.ini (stat follows a link), under any name: players move
  // it to another drive, and PR 3 hands over the real path. It is never saves or Tray, nor inside one,
  // neither by the path that was given nor by where that path really leads. It is never a whole drive
  // either, even one with Options.ini in its root: every path on that drive would sort into its zones.
  // The given path is asked on its own, since Windows resolves a subst drive's root to the folder behind it.
  let realFolder: string | null = null
  const realForbidden: string[] = []
  let realSaves: string | null = null
  if (folderPath !== null) {
    const notSims: GateRefusal = { reason: 'not-a-sims-folder', path: folderPath }
    if (!isWellFormed(nativePath, folderPath)) return notSims
    if (hasForbiddenName(folderPath) || isDriveRoot(folderPath)) return notSims
    try {
      if (!(await statOrNull(folderPath))?.isDirectory()) return notSims
      if (!(await statOrNull(nativePath.join(folderPath, 'Options.ini')))?.isFile()) return notSims
      realFolder = await glance.real(folderPath)
    } catch {
      return checkFailed(folderPath)
    }
    if (hasForbiddenName(realFolder) || isDriveRoot(realFolder)) return notSims
    leads.push({ path: folderPath, real: realFolder })
    // saves or Tray may itself be a link to another drive. Where it leads is forbidden too, and when that
    // cannot be found out (the drive is not plugged in), nothing is touched.
    for (const name of ['saves', 'Tray']) {
      const forbidden = nativePath.join(folderPath, name)
      try {
        const real = await glance.real(forbidden)
        realForbidden.push(real)
        if (name === 'saves') realSaves = real
        leads.push({ path: forbidden, real })
      } catch {
        return checkFailed(forbidden)
      }
    }
    // A copy of the Sims folder inside app data is a backup, not the game's folder.
    if (isInside(nativePath, folderPath, dataDir) || isInside(nativePath, realFolder, realData)) return notSims
    if (isInside(nativePath, dataDir, folderPath) || isInside(nativePath, realData, realFolder)) return outside(dataDir)
  }

  // A Desktop the gate cannot make sense of means no report zone. It does not hold up anything else.
  let desktopDir: string | null = null
  let realDesktop: string | null = null
  if (isWellFormed(nativePath, asked.desktopDir)) {
    desktopDir = asked.desktopDir
    try {
      realDesktop = await glance.real(desktopDir)
      leads.push({ path: desktopDir, real: realDesktop })
    } catch {
      // Only a report is refused, as a check that failed.
    }
  }
  // The mod folder is a zone only when every check on it passes. Otherwise it is no zone, and its paths are in
  // none: nothing here refuses the request itself.
  const modLead = await checkModFolder(asked, glance, [dataDir, realData, folderPath, realFolder])
  if (modLead !== null) leads.push(modLead)
  return {
    roots: { folderPath, dataDir, desktopDir, modFolder: modLead?.path ?? null },
    realRoots: { folderPath: realFolder, dataDir: realData, desktopDir: realDesktop, modFolder: modLead?.real ?? null },
    realForbidden,
    realSaves,
    leads
  }
}

/**
 * The Sims Helper Mods folder (briefs/pr-17.md), or null when it may not be a zone: a name other than exactly
 * Sims Helper Mods; inside or around a Sims folder, saves or Tray, app data, or a system folder; not a folder;
 * or reached through a link anywhere on its path. A check that fails also means no zone.
 */
async function checkModFolder(asked: Asked, glance: Glance, keepApart: (string | null)[]): Promise<Lead | null> {
  const root = asked.modFolderRoot
  if (root === null || !isWellFormed(nativePath, root) || isDriveRoot(root)) return null
  if (nativePath.basename(root) !== MOD_FOLDER_NAME) return null
  const clearOfOthers = (place: string): boolean => {
    const names = (looseParts(nativePath, place) ?? []).slice(1)
    if (names.some((name) => FORBIDDEN_NAMES.has(looseFold(name)))) return false
    if (names.some((name) => SIMS_FOLDER_NAMES.has(normalizeSimsFolderName(name)))) return false
    if (names.some((name) => SYSTEM_FOLDER_NAMES.has(looseFold(name)))) return false
    return keepApart.every(
      (other) => other === null || (!isInside(nativePath, place, other) && !isInside(nativePath, other, place))
    )
  }
  if (!clearOfOthers(root)) return null
  try {
    const real = await glance.real(root)
    // It resolves to itself: no link, junction or short name anywhere on the way. The disk's own spelling of the
    // last name must be exactly Sims Helper Mods too: a disk that ignores letter case answers to it for any spelling.
    if (fold(real) !== fold(root) || nativePath.basename(real) !== MOD_FOLDER_NAME || !clearOfOthers(real)) return null
    if (!(await statOrNull(root))?.isDirectory()) return null
    // A Sims folder under any name holds Options.ini. Neither the folder nor anything above it may be one.
    for (let place = root; ; place = nativePath.dirname(place)) {
      if ((await statOrNull(nativePath.join(place, 'Options.ini'))) !== null) return null
      if (isDriveRoot(place) || nativePath.dirname(place) === place) break
    }
    return { path: root, real }
  } catch {
    return null
  }
}

/** The names of a path below the mod folder, or null when it is not in it. */
function namesInModFolder(ground: Ground, target: string): string[] | null {
  const root = ground.roots.modFolder
  const parts = looseParts(nativePath, target)
  if (root === undefined || root === null || parts === null) return null
  return partsBelow(parts, looseParts(nativePath, root), fold)
}

/** Her request, and the folder it goes in: the only writes the mod folder takes, and only for a mod-request. */
function modFolderWrite(asked: Asked, ground: Ground, use: WriteUse, target: string): boolean {
  const names = namesInModFolder(ground, target)
  if (asked.purpose !== MOD_REQUEST || names === null || names[0] !== REQUESTS_FOLDER) return false
  if (use === 'mkdir') return names.length === 1
  return use === 'write-create' && names.length === 2 && REQUEST_NAME.test(names[1]!)
}

/** A delivered mod, below from-tyler/, read for a mod-install: the only reads the mod folder allows. */
function modFolderRead(asked: Asked, ground: Ground, source: string): boolean {
  const names = namesInModFolder(ground, source)
  return asked.purpose === MOD_INSTALL && names !== null && names.length >= 2 && names[0] === DELIVERIES_FOLDER
}

/** True when a path in the mod folder leads to its own name below where the folder really is. */
function leadsToItsOwnModName(ground: Ground, target: string, real: string): boolean {
  const { modFolder } = ground.roots
  const realMods = ground.realRoots.modFolder
  if (modFolder === undefined || modFolder === null || realMods === undefined || realMods === null) return false
  return fold(real) === fold(realMods + target.slice(modFolder.length))
}

/** Sorts where a path really leads. Null when it leads into saves or Tray. */
function sortReal(ground: Ground, real: string): SortedPath | null {
  if (ground.realForbidden.some((root) => isInside(nativePath, real, root))) return null
  const sorted = sortPath(nativePath, ground.realRoots, real)
  return sorted.zone === 'forbidden' ? null : sorted
}

/**
 * A file in Mods or app data may be one file with a save, under a second name. A file with one name costs
 * nothing here: saves and Tray are read only when a path has a second name, and then once per check.
 */
async function isAlsoInForbidden(ground: Ground, glance: Glance, target: string): Promise<boolean> {
  let found: BigIntStats
  try {
    found = await lstat(target, { bigint: true })
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
  if (!found.isFile() || found.nlink <= 1n) return false
  glance.forbiddenIds ??= manyNamedFilesUnder(ground.realForbidden)
  return (await glance.forbiddenIds).has(fileId(found))
}

/**
 * The gate makes every folder and file in app data, and it never makes a link. So a path in app data must
 * lead to its own name: the same names, below the place the app data folder really is. One that leads
 * anywhere else goes through a link something else made, and names one thing while it reaches another: a
 * copy in holding that is really a file in a backup, a journal entry, the key, or what another change holds.
 * Only the part below the app data folder is compared, since the folder itself may be reached through a link
 * or a short 8.3 name. Both paths are written out in full, so the given one is cut by length.
 *
 * The disk may spell a name its own way: a folder made as 'Été' answers to 'été' too, and its real path comes
 * back as 'Été'. A to Z is compared without letter case, as in every allow check. For any other letter the
 * answer comes from the disk, never from a table of letters. The wide fold reads two names as one that Windows
 * keeps apart, so a link from one such name to the other would pass a compare that used it. The wide fold only
 * narrows here: two names it reads apart are refused, and two it reads as one still have to be one on the disk.
 */
async function leadsToItsOwnName(ground: Ground, target: string, real: string): Promise<boolean> {
  const own = ground.realRoots.dataDir + target.slice(ground.roots.dataDir.length)
  if (fold(real) === fold(own)) return true
  const asked = own.split(nativePath.sep)
  const found = real.split(nativePath.sep)
  if (asked.length !== found.length) return false
  for (const [index, name] of asked.entries()) {
    const spelled = found[index]!
    if (fold(name) === fold(spelled)) continue
    if (index === 0 || looseFold(name) !== looseFold(spelled)) return false
    const parent = found.slice(0, index).join(nativePath.sep) + nativePath.sep
    if (!(await isOneEntry(parent + name, parent + spelled))) return false
  }
  return true
}

/**
 * True only when the disk proves that two spellings in one folder are one name: neither is a link, and both
 * give the same file id. A link has its own id, and it is refused before ids are compared. A disk that gives
 * no file id proves nothing, so there the answer is false. An error is thrown on: the check failed.
 */
async function isOneEntry(asked: string, spelled: string): Promise<boolean> {
  const first = await lstat(asked, { bigint: true })
  const second = await lstat(spelled, { bigint: true })
  if (first.isSymbolicLink() || second.isSymbolicLink()) return false
  return first.ino !== 0n && fileId(first) === fileId(second)
}

async function checkWrite(
  asked: Asked,
  ground: Ground,
  glance: Glance,
  use: WriteUse,
  target: string
): Promise<Lead | GateRefusal> {
  const named = sortPath(nativePath, ground.roots, target)
  if (named.zone === 'forbidden') return savesOrTray(target)
  if (!named.wellFormed || !mayWrite(use, named)) return outside(target)
  if (named.zone === 'mod-folder' && !modFolderWrite(asked, ground, use, target)) return outside(target)
  // A mod-request writes her request into the mod folder, and nothing anywhere else.
  if (asked.purpose === MOD_REQUEST && named.zone !== 'mod-folder') return outside(target)
  if (named.zone === 'report' && ground.realRoots.desktopDir === null) return checkFailed(target)
  try {
    const real = await glance.real(target)
    const sorted = sortReal(ground, real)
    if (sorted === null) return savesOrTray(target)
    if (sorted.zone !== named.zone || !mayWrite(use, sorted)) return linkEscape(target)
    if (await isAlsoInForbidden(ground, glance, target)) return savesOrTray(target)
    if (named.zone === 'app-data' && !(await leadsToItsOwnName(ground, target, real))) return linkEscape(target)
    if (named.zone === 'mod-folder' && !leadsToItsOwnModName(ground, target, real)) return linkEscape(target)
    return { path: target, real }
  } catch (err) {
    return err instanceof LinkToNowhere ? linkEscape(target) : checkFailed(target)
  }
}

async function checkRead(asked: Asked, ground: Ground, glance: Glance, target: string): Promise<Lead | GateRefusal> {
  const named = sortPath(nativePath, ground.roots, target)
  if (!named.wellFormed || !READ_ZONES.includes(named.zone)) return outside(target)
  if (named.zone === 'mod-folder' && !modFolderRead(asked, ground, target)) return outside(target)
  try {
    const real = await glance.real(target)
    const sorted = sortReal(ground, real)
    if (sorted !== null && !READ_ZONES.includes(sorted.zone)) return linkEscape(target)
    // A delivered mod is read from its own name in the mod folder, and nothing else is read through it.
    if (named.zone === 'mod-folder') {
      if (sorted?.zone !== 'mod-folder' || !leadsToItsOwnModName(ground, target, real)) return linkEscape(target)
    } else if (sorted?.zone === 'mod-folder') {
      return linkEscape(target)
    }
    return { path: target, real }
  } catch (err) {
    return err instanceof LinkToNowhere ? linkEscape(target) : checkFailed(target)
  }
}

/** Checks every path of one op, and says where each really leads. */
async function checkOp(asked: Asked, ground: Ground, glance: Glance, op: WriteOp): Promise<Lead[] | GateRefusal> {
  if (asked.purpose === PUT_BACK) return await checkPutBack(asked, ground, glance, op)
  const leads: Lead[] = []
  for (const [path, use] of pathUses(op)) {
    const answer =
      use === 'read' ? await checkRead(asked, ground, glance, path) : await checkWrite(asked, ground, glance, use, path)
    if ('reason' in answer) return answer
    leads.push(answer)
  }
  return leads
}

/**
 * save-new-slot (briefs/pr-15.md, round 7): a save copy put back is one `copy`, from the copy's own name in
 * saveCopiesDir to a slot name in saves/ that nobody has. Every other op of a put-back is refused, and so is a
 * put-back's op anywhere else. Nothing of hers is changed or removed, so it needs no backup; the game must be
 * closed (takeTurn asks).
 */
async function checkPutBack(asked: Asked, ground: Ground, glance: Glance, op: WriteOp): Promise<Lead[] | GateRefusal> {
  if (op.op !== 'copy') {
    const paths = pathUses(op).map(([path]) => path)
    const inSaves = paths.find((path) => sortPath(nativePath, ground.roots, path).zone === 'forbidden')
    return inSaves === undefined ? outside(paths[0]) : savesOrTray(inSaves)
  }
  const source = await checkSaveCopy(asked, ground, glance, op.from)
  if ('reason' in source) return source
  const target = await checkNewSlot(ground, glance, op.to)
  if ('reason' in target) return target
  return [source, target]
}

/** The source of a put-back: a file in saveCopiesDir that leads to its own name. */
async function checkSaveCopy(asked: Asked, ground: Ground, glance: Glance, source: string): Promise<Lead | GateRefusal> {
  const copies = asked.saveCopiesDir
  const named = sortPath(nativePath, ground.roots, source)
  if (!named.wellFormed || named.zone !== 'app-data' || copies === null) return outside(source)
  const copiesSorted = sortPath(nativePath, ground.roots, copies)
  if (!copiesSorted.wellFormed || copiesSorted.zone !== 'app-data' || copiesSorted.atRoot) return outside(source)
  const sourceParts = looseParts(nativePath, source)
  const below = sourceParts === null ? null : partsBelow(sourceParts, looseParts(nativePath, copies), fold)
  if (below === null || below.length === 0) return outside(source)
  try {
    const real = await glance.real(source)
    if (sortReal(ground, real)?.zone !== 'app-data') return linkEscape(source)
    if (!(await leadsToItsOwnName(ground, source, real))) return linkEscape(source)
    return { path: source, real }
  } catch (err) {
    return err instanceof LinkToNowhere ? linkEscape(source) : checkFailed(source)
  }
}

/**
 * The target of a put-back: <folderPath>/saves/Slot_0<7 lower-case hex>.save, directly in a saves folder that is
 * itself no link, and missing. Any other name in saves or Tray, and a slot that is taken, is saves-or-tray.
 */
async function checkNewSlot(ground: Ground, glance: Glance, target: string): Promise<Lead | GateRefusal> {
  const named = sortPath(nativePath, ground.roots, target)
  if (named.zone !== 'forbidden') return outside(target)
  const { folderPath } = ground.roots
  const realFolder = ground.realRoots.folderPath
  const { realSaves } = ground
  const targetParts = looseParts(nativePath, target)
  if (!named.wellFormed || folderPath === null || realFolder === null || realSaves === null || targetParts === null) {
    return savesOrTray(target)
  }
  const names = partsBelow(targetParts, looseParts(nativePath, folderPath), fold)
  if (names?.length !== 2 || fold(names[0]!) !== 'saves' || !NEW_SLOT_NAME.test(names[1]!)) return savesOrTray(target)
  const name = names[1]!
  try {
    // saves must be the folder of that name in the Sims folder, not a link to somewhere else.
    if (fold(realSaves) !== fold(nativePath.join(realFolder, 'saves'))) return linkEscape(target)
    if (!(await lstatOrNull(nativePath.dirname(target)))?.isDirectory()) return savesOrTray(target)
    // Only a new slot. A name that is there, as a file, a folder or a link, is hers.
    if ((await lstatOrNull(target)) !== null) return savesOrTray(target)
    const real = await glance.real(target)
    if (fold(real) !== fold(nativePath.join(realSaves, name)) || nativePath.basename(real) !== name) {
      return linkEscape(target)
    }
    return { path: target, real }
  } catch (err) {
    return err instanceof LinkToNowhere ? linkEscape(target) : checkFailed(target)
  }
}

/** Checks the whole request. Nothing here changes the disk, and anything it throws refuses. */
async function checkRequest(asked: Asked): Promise<Approved | GateRefusal> {
  const glance = newGlance()
  const ground = await checkGround(asked, glance)
  if ('reason' in ground) return ground
  // A put-back is one copy, never more and never none.
  if (asked.purpose === PUT_BACK && asked.ops.length !== 1) return outside('')
  const opLeads: Lead[][] = []
  for (const op of asked.ops) {
    const leads = await checkOp(asked, ground, glance, op)
    if (!Array.isArray(leads)) return leads
    opLeads.push(leads)
  }
  const zoneOf = (path: string): Zone => sortPath(nativePath, ground.roots, path).zone
  const guarded = asked.ops.some((op) =>
    pathUses(op).some(([path, use]) => use !== 'read' && GUARDED_ZONES.includes(zoneOf(path)))
  )
  return { asked, ground, opLeads, guarded, gameOnly: asked.purpose === PUT_BACK }
}

/**
 * The first path that no longer leads where it led, or null. Letter case is left out of it: once an earlier
 * op has made a folder, Windows answers with the folder's own spelling.
 */
function firstMoved(before: Lead[], after: Lead[]): string | null {
  for (const [index, was] of before.entries()) {
    const now = after[index]
    if (now === undefined || now.path !== was.path || looseFold(now.real) !== looseFold(was.real)) return was.path
  }
  return after[before.length]?.path ?? null
}

/** The whole check once more. Every path must pass again, and lead exactly where it led the first time. */
async function checkAgain(approved: Approved): Promise<Approved | GateRefusal> {
  let again: Approved | GateRefusal
  try {
    again = await checkRequest(approved.asked)
  } catch {
    return checkFailed('')
  }
  if ('reason' in again) return again
  let moved = firstMoved(approved.ground.leads, again.ground.leads)
  for (const [index, leads] of approved.opLeads.entries()) moved ??= firstMoved(leads, again.opLeads[index] ?? [])
  return moved === null ? again : linkEscape(moved)
}

/**
 * A move's target alone, followed again with nothing remembered. True only when it still passes its check
 * and leads where it led: then a removal at that path removes what the gate put there, and nothing else.
 */
async function targetHolds(approved: Approved, index: number): Promise<boolean> {
  const op = approved.asked.ops[index]!
  const was = approved.opLeads[index]![1]
  if (op.op !== 'move' || was === undefined) return false
  try {
    const now = await checkWrite(approved.asked, approved.ground, newGlance(), 'move', op.to)
    return !('reason' in now) && firstMoved([was], [now]) === null
  } catch {
    return false
  }
}

/** One op's paths followed again, with nothing remembered. Null when they pass and lead where they led. */
async function refusalNow(approved: Approved, index: number): Promise<GateRefusal | null> {
  const op = approved.asked.ops[index]!
  try {
    const now = await checkOp(approved.asked, approved.ground, newGlance(), op)
    if (!Array.isArray(now)) return now
    const moved = firstMoved(approved.opLeads[index]!, now)
    return moved === null ? null : linkEscape(moved)
  } catch {
    return checkFailed('path' in op ? op.path : op.from)
  }
}

async function askGame(deps: GateDeps): Promise<GameRunState> {
  try {
    const state = await deps.gameState()
    return state === 'not-running' || state === 'running' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function askBackup(deps: GateDeps, folderPath: string): Promise<'verified' | 'none' | 'stale' | 'unknown'> {
  try {
    const state = (await deps.backupStatus(folderPath))?.state
    return state === 'verified' || state === 'none' || state === 'stale' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}

// One request at a time. Two that ran together could each find a name free and both take it. So neither
// deps.gameState nor deps.backupStatus may call the gate: it would wait for itself.
let lastTurn: Promise<unknown> = Promise.resolve()

export async function runGate(deps: GateDeps, request: WriteRequest): Promise<GateResult> {
  const turn = lastTurn.then(() => takeTurn(deps, request))
  lastTurn = turn.catch(() => undefined)
  return await turn
}

async function takeTurn(deps: GateDeps, request: WriteRequest): Promise<GateResult> {
  const refused = (refusal: GateRefusal): GateResult => ({ status: 'refused', refusal })
  let approved: Approved | GateRefusal
  try {
    const asked = readRequest(deps, request)
    approved = 'reason' in asked ? asked : await checkRequest(asked)
  } catch {
    approved = checkFailed('')
  }
  if ('reason' in approved) return refused(approved)

  if (approved.guarded) {
    const { folderPath } = approved.asked
    const backup = folderPath === null ? 'unknown' : await askBackup(deps, folderPath)
    // The game is asked last, so only the second look at the paths stands between its answer and the first change.
    const game = await askGame(deps)
    if (game === 'running') return refused({ reason: 'game-running' })
    if (game !== 'not-running') return refused({ reason: 'game-state-unknown' })
    if (backup !== 'verified') return refused({ reason: 'no-verified-backup', backup })
    // Those answers took time, and a folder can be swapped for a link in that time.
    approved = await checkAgain(approved)
    if ('reason' in approved) return refused(approved)
  } else if (approved.gameOnly) {
    // A save put back: the game must be closed, or it may write that slot too. No backup: nothing is replaced.
    const game = await askGame(deps)
    if (game === 'running') return refused({ reason: 'game-running' })
    if (game !== 'not-running') return refused({ reason: 'game-state-unknown' })
    approved = await checkAgain(approved)
    if ('reason' in approved) return refused(approved)
  }

  const checked = approved
  for (const [index, op] of checked.asked.ops.entries()) {
    const what = 'path' in op ? `${op.op} ${op.path}` : `${op.op} ${op.from} -> ${op.to}`
    // Node cannot hold a folder open and work inside it. So each op's paths are followed once more right
    // before it, and an op whose path has changed does not run.
    const followAgain = async (): Promise<void> => {
      const refusal = await refusalNow(checked, index)
      if (refusal !== null) throw new OpFailure(`the path no longer passes its check (${refusal.reason})`)
    }
    // Before the first op nothing has run, so a path that no longer passes refuses the whole request.
    // `failed` is only for a stop after the disk may have changed.
    if (index === 0) {
      const refusal = await refusalNow(checked, 0)
      if (refusal !== null) return refused(refusal)
    }
    try {
      if (index > 0) await followAgain()
      await carryOut(op, checked, followAgain, () => targetHolds(checked, index))
    } catch (err) {
      return { status: 'failed', opsDone: index, detail: `${what}: ${explain(err)}` }
    }
  }
  return { status: 'done' }
}

/** A failure whose message is safe to show: it never holds file contents. */
class OpFailure extends Error {}

// Only the gate's own words and the error code go into `detail`. Node's own messages can quote an argument,
// and a write's argument may be the AI key.
function explain(err: unknown): string {
  if (err instanceof OpFailure) return err.message
  const code = errorCode(err)
  return code === undefined ? 'an unexpected error' : `the disk said ${code}`
}

async function carryOut(
  op: WriteOp,
  approved: Approved,
  followAgain: () => Promise<void>,
  targetStillHolds: () => Promise<boolean>
): Promise<void> {
  const { roots } = approved.ground
  if (op.op === 'mkdir') {
    await mkdir(op.path, { recursive: true })
  } else if (op.op === 'remove') {
    await removeEntry(op.path, sortPath(nativePath, roots, op.path).zone)
  } else if (op.op === 'write') {
    if (op.mode === 'create') await mustBeMissing(op.path)
    await makeParent(op.path, roots)
    await viaTemp(op.path, op.mode === 'replace', async (temp) => {
      const handle = await open(temp, 'wx', approved.asked.secret ? 0o600 : 0o666)
      try {
        await handle.writeFile(op.data)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  } else {
    // Only a plain file is copied or moved. A link or a folder could carry a link into an allowed zone,
    // for a later op to walk through.
    const source = await lstatOrNull(op.from)
    if (source === null) throw new OpFailure('the source is missing')
    if (!source.isFile()) throw new OpFailure('the source is not a plain file')
    await mustBeMissing(op.to)
    await makeParent(op.to, roots)
    if (op.op === 'copy') {
      // A save put back is read back once more before it gets its name, and only a hard link may give it that
      // name: it fails when the name is taken. A rename can replace a file, so saves never gets one.
      const putBack = approved.asked.purpose === PUT_BACK
      await placeCopy(op.from, op.to, source, putBack, putBack)
      return
    }
    try {
      await nameWithoutOverwrite(op.from, op.to, targetStillHolds)
      return
    } catch (err) {
      if (errorCode(err) !== 'EXDEV') throw err
    }
    // Another drive: copy, check the copy, and only then remove the source. The copy took time, so the
    // paths are followed again first: a source whose folder was swapped meanwhile is not removed.
    const original = await lstat(op.from, { bigint: true })
    const sha256 = await placeCopy(op.from, op.to, source, true)
    // A move that stops here answers `failed`, never `done`. Its copy may be the only one left, so it is
    // taken back only when the source is proven still in place, and only from where the gate put it.
    // A copy that stays is named in the answer.
    const stop = async (err: unknown): Promise<never> => {
      const kept = (await sourceStillInPlace(op.from, original, sha256))
        ? await takeCopyBack(op.to, source, targetStillHolds)
        : 'the source is no longer surely there'
      if (kept === null) throw err
      throw new OpFailure(`${explain(err)}, and the copy at the target was left in place: ${kept}`)
    }
    await followAgain().catch(stop)
    await unlink(op.from).catch(stop)
  }
}

/**
 * True only when the file a copy was made from is proven still at its path: a plain file there, with the id
 * it had before the copy and the bytes the copy has. Anything else is false, and so is any error and a disk
 * that gives no file id: in doubt the copy stays. The id is read as a bigint, because as a plain number two
 * NTFS ids can read the same. The bytes are compared as well, because a file id alone is not proof: Windows
 * lets a disk use an id again, and on FAT the id is only the place of the name in its folder.
 */
async function sourceStillInPlace(from: string, original: BigIntStats, sha256: string): Promise<boolean> {
  try {
    const now = await lstat(from, { bigint: true })
    if (!now.isFile() || now.ino === 0n || fileId(now) !== fileId(original)) return false
    return (await sha256File(from)) === sha256
  } catch {
    return false
  }
}

/**
 * Removes the copy a stopped cross-drive move placed. The target's folder is followed again first: had it
 * been swapped for a link, the removal could reach a file somewhere else. Null when no copy is left,
 * else why it was kept.
 */
async function takeCopyBack(
  to: string,
  source: Stats,
  targetStillHolds: () => Promise<boolean>
): Promise<string | null> {
  if (!(await targetStillHolds())) return 'its path no longer passes its check'
  try {
    const copy = await lstatOrNull(to)
    if (copy === null) return null
    if (!copy.isFile() || copy.size !== source.size) return 'it is no longer the file that was copied'
    await unlink(to)
    return null
  } catch (err) {
    return explain(err)
  }
}

/** Never overwrite: the target must be missing. */
async function mustBeMissing(target: string): Promise<void> {
  if ((await lstatOrNull(target)) !== null) throw new OpFailure('the target already exists')
}

/**
 * Gives a file its new name, never in place of a file that is already there. A hard link does that in one
 * step: it fails when the name is taken, and the old name is removed after. A disk with no hard links (exFAT,
 * some network drives) gets the next best thing: look, then rename at once. With `linkOnly` there is no next
 * best thing: a rename can still replace a file that appears after the look, so a failed hard link fails the op.
 * `targetStillHolds` is asked only before a new name is taken back.
 */
async function nameWithoutOverwrite(
  from: string,
  to: string,
  targetStillHolds: () => Promise<boolean>,
  linkOnly = false
): Promise<void> {
  try {
    await link(from, to)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'EEXIST') throw new OpFailure('the target already exists')
    if (code === 'EXDEV' || code === 'ENOENT') throw err
    if (linkOnly) throw new OpFailure(`the disk could not give the file its name without a rename (${code ?? 'no code'})`)
    await mustBeMissing(to)
    await rename(from, to)
    return
  }
  try {
    await unlink(from)
  } catch (err) {
    // One file with two names now. The new name is taken back only when the old one is proven to be
    // another name of that same file, and only from where the gate put it. Without the proof the new name
    // may be the last one. With a target folder that was swapped for a link, its path may reach a third
    // name of the file, one the gate never made. Either way it stays, and the answer says so. The target
    // is looked at last, right before the removal.
    let kept: string | null
    if (!(await twoNamesOfOneFile(from, to))) kept = 'the source is no longer surely there'
    else if (!(await targetStillHolds())) kept = 'its path no longer passes its check'
    else kept = await unlink(to).then(() => null, explain)
    if (kept === null) throw err
    throw new OpFailure(`${explain(err)}, and the file at the target was left in place: ${kept}`)
  }
}

/**
 * True only when the two paths are proven to be two names of one file: the same file id, more than one name
 * on the file, and two different real names. Two paths that lead to a single name do not pass, since removing
 * through one of them removes that name for both. Any error is false, and so is a disk that gives no file id.
 */
async function twoNamesOfOneFile(one: string, other: string): Promise<boolean> {
  try {
    const first = await lstat(one, { bigint: true })
    const second = await lstat(other, { bigint: true })
    if (first.ino === 0n || fileId(first) !== fileId(second) || first.nlink < 2n) return false
    return looseFold(await realpath(one)) !== looseFold(await realpath(other))
  } catch {
    return false
  }
}

/** Makes the folders above a new file, in the two zones where the gate may make folders. */
async function makeParent(target: string, roots: GateRoots): Promise<void> {
  const { zone } = sortPath(nativePath, roots, target)
  if (zone === 'mods' || zone === 'app-data') await mkdir(nativePath.dirname(target), { recursive: true })
}

// A temp file and its target are two names in one folder, and the temp name is random and the gate's own.
// A folder swapped for a link cannot hold both as names of one file, so this take-back asks nothing more.
const tempIsBesideTarget = async (): Promise<boolean> => true

/**
 * Fills a temp file beside the target, then gives it the target's name. Only `replace` may take the name from
 * a file that is there. The temp file never outlives a failure. `fill` returns once the disk has the file, and
 * the folder is flushed after the name is given, so a file reported done is still there after a power loss.
 */
async function viaTemp(
  target: string,
  replace: boolean,
  fill: (temp: string) => Promise<void>,
  linkOnly = false
): Promise<void> {
  // Not .package or .ts4script: the game must never load a half-written file.
  const temp = `${target}.${randomBytes(6).toString('hex')}.sims-helper-tmp`
  try {
    await fill(temp)
    if (replace) await rename(temp, target)
    else await nameWithoutOverwrite(temp, target, tempIsBesideTarget, linkOnly)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
  await flushFolder(nativePath.dirname(target))
}

/**
 * Waits until the disk has a folder's list of names. Windows gives Node no way to open a folder, so there a
 * new name rests on the disk's own journal: after a power loss the file is whole or missing, never half there.
 */
async function flushFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(folder, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Places a copy under its final name, and returns the hash of the bytes it read from the source. */
async function placeCopy(from: string, to: string, source: Stats, verify: boolean, linkOnly = false): Promise<string> {
  let sha256: string | null = null
  await viaTemp(to, false, async (temp) => {
    const copied = await copyBytes(from, temp, source)
    if (copied.bytes !== source.size) throw new OpFailure('the source changed while it was copied')
    if (verify) {
      const matches = (await stat(temp)).size === source.size && (await sha256File(temp)) === copied.sha256
      if (!matches) throw new OpFailure('the copy does not match the source')
    }
    sha256 = copied.sha256
  }, linkOnly)
  if (sha256 === null) throw new OpFailure('the copy was not made')
  return sha256
}

/** Streams a file into a new file with the source's date, waits until the disk has it, and returns what was read. */
async function copyBytes(from: string, to: string, dated: Stats): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  const source = await open(from, 'r')
  try {
    const target = await open(to, 'wx')
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024)
      for (;;) {
        const { bytesRead } = await source.read(chunk, 0, chunk.byteLength, null)
        if (bytesRead === 0) break
        const part = chunk.subarray(0, bytesRead)
        hash.update(part)
        await writeAll(target, part)
        bytes += bytesRead
      }
      // The date is set through this handle, after its last write, so closing it does not move the date.
      await target.utimes(dated.atimeMs / 1000, dated.mtimeMs / 1000)
      await target.sync()
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let done = 0
  while (done < data.byteLength) {
    const { bytesWritten } = await handle.write(data, done, data.byteLength - done)
    if (bytesWritten === 0) throw new OpFailure('the disk took no more bytes')
    done += bytesWritten
  }
}

async function removeEntry(target: string, zone: Zone): Promise<void> {
  const found = await lstatOrNull(target)
  if (found === null) return // already gone
  if (zone === 'caches' && !found.isSymbolicLink()) {
    const kind = CACHE_KINDS.get(fold(nativePath.basename(target)))
    if (kind === 'folder' ? !found.isDirectory() : !found.isFile()) {
      throw new OpFailure('this is not the kind of cache the game keeps under that name')
    }
  }
  // lstat does not follow links, and neither does rm: a link inside a folder is removed, not what it points at.
  await rm(target, { recursive: found.isDirectory() })
}
