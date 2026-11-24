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

export type Zone = 'forbidden' | 'mods' | 'caches' | 'options' | 'app-data' | 'report' | 'sims-other' | 'none'

/** The folders the zones hang from. Compared without regard to letter case, on every machine. */
export interface GateRoots {
  folderPath: string | null
  dataDir: string
  desktopDir: string | null
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
// removed or overwritten, and nothing but a cache is ever removed from the Sims folder.
const WRITE_ZONES: Record<WriteUse, readonly Zone[]> = {
  mkdir: ['mods', 'app-data'],
  'copy-to': ['app-data'],
  move: ['mods', 'app-data'],
  'write-create': ['app-data', 'report'],
  'write-replace': ['options', 'app-data'],
  remove: ['caches', 'app-data']
}
// The source of a copy is only read: anywhere in the Sims folder (saves too: that is the backup) or app data.
const READ_ZONES: readonly Zone[] = ['forbidden', 'mods', 'caches', 'options', 'sims-other', 'app-data']
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
  secret: boolean
  ops: WriteOp[]
  dataDir: string
  desktopDir: string
  oneDriveRoots: string[]
}

/** The folders a request stands on, as one check found them. */
interface Ground {
  roots: GateRoots
  realRoots: GateRoots
  /** Where saves and Tray really are. */
  realForbidden: string[]
  leads: Lead[]
}

interface Approved {
  asked: Asked
  ground: Ground
  /** For each op, its paths in order. */
  opLeads: Lead[][]
  guarded: boolean
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
  const { dataDir, desktopDir, oneDriveRoots } = deps.paths
  return { folderPath, secret: request.reason === 'key', ops, dataDir, desktopDir, oneDriveRoots: [...oneDriveRoots] }
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
  return {
    roots: { folderPath, dataDir, desktopDir },
    realRoots: { folderPath: realFolder, dataDir: realData, desktopDir: realDesktop },
    realForbidden,
    leads
  }
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

async function checkWrite(ground: Ground, glance: Glance, use: WriteUse, target: string): Promise<Lead | GateRefusal> {
  const named = sortPath(nativePath, ground.roots, target)
  if (named.zone === 'forbidden') return savesOrTray(target)
  if (!named.wellFormed || !mayWrite(use, named)) return outside(target)
  if (named.zone === 'report' && ground.realRoots.desktopDir === null) return checkFailed(target)
  try {
    const real = await glance.real(target)
    const sorted = sortReal(ground, real)
    if (sorted === null) return savesOrTray(target)
    if (sorted.zone !== named.zone || !mayWrite(use, sorted)) return linkEscape(target)
    if (await isAlsoInForbidden(ground, glance, target)) return savesOrTray(target)
    return { path: target, real }
  } catch (err) {
    return err instanceof LinkToNowhere ? linkEscape(target) : checkFailed(target)
  }
}

async function checkRead(ground: Ground, glance: Glance, target: string): Promise<Lead | GateRefusal> {
  const named = sortPath(nativePath, ground.roots, target)
  if (!named.wellFormed || !READ_ZONES.includes(named.zone)) return outside(target)
  try {
    const real = await glance.real(target)
    const sorted = sortReal(ground, real)
    if (sorted !== null && !READ_ZONES.includes(sorted.zone)) return linkEscape(target)
    return { path: target, real }
  } catch (err) {
    return err instanceof LinkToNowhere ? linkEscape(target) : checkFailed(target)
  }
}

/** Checks every path of one op, and says where each really leads. */
async function checkOp(ground: Ground, glance: Glance, op: WriteOp): Promise<Lead[] | GateRefusal> {
  const leads: Lead[] = []
  for (const [path, use] of pathUses(op)) {
    const answer = use === 'read' ? await checkRead(ground, glance, path) : await checkWrite(ground, glance, use, path)
    if ('reason' in answer) return answer
    leads.push(answer)
  }
  return leads
}

/** Checks the whole request. Nothing here changes the disk, and anything it throws refuses. */
async function checkRequest(asked: Asked): Promise<Approved | GateRefusal> {
  const glance = newGlance()
  const ground = await checkGround(asked, glance)
  if ('reason' in ground) return ground
  const opLeads: Lead[][] = []
  for (const op of asked.ops) {
    const leads = await checkOp(ground, glance, op)
    if (!Array.isArray(leads)) return leads
    opLeads.push(leads)
  }
  const zoneOf = (path: string): Zone => sortPath(nativePath, ground.roots, path).zone
  const guarded = asked.ops.some((op) =>
    pathUses(op).some(([path, use]) => use !== 'read' && GUARDED_ZONES.includes(zoneOf(path)))
  )
  return { asked, ground, opLeads, guarded }
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
    const now = await checkWrite(approved.ground, newGlance(), 'move', op.to)
    return !('reason' in now) && firstMoved([was], [now]) === null
  } catch {
    return false
  }
}

/** One op's paths followed again, with nothing remembered. Null when they pass and lead where they led. */
async function refusalNow(approved: Approved, index: number): Promise<GateRefusal | null> {
  const op = approved.asked.ops[index]!
  try {
    const now = await checkOp(approved.ground, newGlance(), op)
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
      await placeCopy(op.from, op.to, source, false)
      return
    }
    try {
      await nameWithoutOverwrite(op.from, op.to)
      return
    } catch (err) {
      if (errorCode(err) !== 'EXDEV') throw err
    }
    // Another drive: copy, check the copy, and only then remove the source. The copy took time, so the
    // paths are followed again first: a source whose folder was swapped meanwhile is not removed.
    await placeCopy(op.from, op.to, source, true)
    try {
      await followAgain()
    } catch (err) {
      // The source stays, so the move did not run and its copy is taken back. When it cannot be, the
      // disk is not as it was, and the answer says so.
      const kept = await takeCopyBack(op.to, source, targetStillHolds)
      if (kept === null) throw err
      throw new OpFailure(`${explain(err)}, and the copy at the target was left in place: ${kept}`)
    }
    try {
      await unlink(op.from)
    } catch (err) {
      // Both exist now. Take the copy back only while the source is surely still there, and only from
      // where the gate put it. A copy that stays is named in the answer.
      const still = await lstatOrNull(op.from).catch(() => null)
      const kept =
        still?.isFile() && still.size === source.size
          ? await takeCopyBack(op.to, source, targetStillHolds)
          : 'the source is no longer surely there'
      if (kept === null) throw err
      throw new OpFailure(`${explain(err)}, and the copy at the target was left in place: ${kept}`)
    }
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
 * some network drives) gets the next best thing: look, then rename at once.
 */
async function nameWithoutOverwrite(from: string, to: string): Promise<void> {
  try {
    await link(from, to)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'EEXIST') throw new OpFailure('the target already exists')
    if (code === 'EXDEV' || code === 'ENOENT') throw err
    await mustBeMissing(to)
    await rename(from, to)
    return
  }
  try {
    await unlink(from)
  } catch (err) {
    // One file with two names now. Take the new name back, but only while the old one is surely still there.
    const still = await lstatOrNull(from).catch(() => null)
    if (still?.isFile()) await unlink(to).catch(() => undefined)
    throw err
  }
}

/** Makes the folders above a new file, in the two zones where the gate may make folders. */
async function makeParent(target: string, roots: GateRoots): Promise<void> {
  const { zone } = sortPath(nativePath, roots, target)
  if (zone === 'mods' || zone === 'app-data') await mkdir(nativePath.dirname(target), { recursive: true })
}

/**
 * Fills a temp file beside the target, then gives it the target's name. Only `replace` may take the name from
 * a file that is there. The temp file never outlives a failure. `fill` returns once the disk has the file, and
 * the folder is flushed after the name is given, so a file reported done is still there after a power loss.
 */
async function viaTemp(target: string, replace: boolean, fill: (temp: string) => Promise<void>): Promise<void> {
  // Not .package or .ts4script: the game must never load a half-written file.
  const temp = `${target}.${randomBytes(6).toString('hex')}.sims-helper-tmp`
  try {
    await fill(temp)
    if (replace) await rename(temp, target)
    else await nameWithoutOverwrite(temp, target)
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

async function placeCopy(from: string, to: string, source: Stats, verify: boolean): Promise<void> {
  await viaTemp(to, false, async (temp) => {
    const copied = await copyBytes(from, temp, source)
    if (copied.bytes !== source.size) throw new OpFailure('the source changed while it was copied')
    if (verify) {
      const matches = (await stat(temp)).size === source.size && (await sha256File(temp)) === copied.sha256
      if (!matches) throw new OpFailure('the copy does not match the source')
    }
  })
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
