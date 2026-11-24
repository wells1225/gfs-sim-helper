// The write gate: the only code in the app that changes the disk (contracts.md, section 5).
// It checks a whole request first, and only then does the ops itself. Any doubt while checking refuses.
import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat, unlink, utimes } from 'node:fs/promises'
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

interface Approved {
  folderPath: string | null
  secret: boolean
  ops: WriteOp[]
  roots: GateRoots
  guarded: boolean
}

const shown = (value: unknown): string => (typeof value === 'string' ? value : '')
const outside = (path: unknown): GateRefusal => ({ reason: 'outside-allowed-area', path: shown(path) })
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

/** Checks the whole request. Nothing here changes the disk, and anything it throws refuses. */
async function checkRequest(deps: GateDeps, request: WriteRequest): Promise<Approved | GateRefusal> {
  if (typeof request !== 'object' || request === null) return outside('')
  const { folderPath } = request
  if (!Array.isArray(request.ops) || (folderPath !== null && typeof folderPath !== 'string')) return outside('')
  const ops: WriteOp[] = []
  for (const given of request.ops) {
    // The gate works on its own copy, so nothing a caller does later can change an op that was checked.
    const op = readOp(given)
    if (op === null) return outside((given as { path?: unknown } | null)?.path)
    ops.push(op)
  }

  const { paths } = deps
  const { dataDir } = paths
  const resolveReal = makeResolver()

  // The app data folder holds the backups. Inside a Sims folder or OneDrive it refuses every request.
  // So does a whole drive: every path on it would count as the helper's own.
  if (!isWellFormed(nativePath, dataDir) || isDriveRoot(dataDir)) return outside(dataDir)
  let realData: string
  try {
    realData = await resolveReal(dataDir)
  } catch (err) {
    return err instanceof LinkToNowhere ? outside(dataDir) : checkFailed(dataDir)
  }
  const cloudRoots: string[] = []
  for (const given of paths.oneDriveRoots) {
    // An environment variable may end in a separator. It is the same folder, and its links are followed too.
    const root = withoutTrailingSeparators(given)
    cloudRoots.push(root)
    if (!isWellFormed(nativePath, root)) continue
    try {
      cloudRoots.push(await resolveReal(root))
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

  // The Sims folder: a localized name from PR 3, with Options.ini inside. It may be a link or a junction:
  // players move the folder to another drive. The real folder may then have any name, but it still holds
  // Options.ini (stat follows the link), and it is never inside a saves or Tray folder.
  let realFolder: string | null = null
  const realForbidden: string[] = []
  if (folderPath !== null) {
    const notSims: GateRefusal = { reason: 'not-a-sims-folder', path: folderPath }
    if (!isWellFormed(nativePath, folderPath)) return notSims
    if (!SIMS_FOLDER_NAMES.has(normalizeSimsFolderName(nativePath.basename(folderPath)))) return notSims
    try {
      if (!(await statOrNull(folderPath))?.isDirectory()) return notSims
      if (!(await statOrNull(nativePath.join(folderPath, 'Options.ini')))?.isFile()) return notSims
      realFolder = await resolveReal(folderPath)
    } catch {
      return checkFailed(folderPath)
    }
    const realNames = (looseParts(nativePath, realFolder) ?? []).slice(1)
    if (realNames.some((name) => FORBIDDEN_NAMES.has(looseFold(name)))) return notSims
    // saves or Tray may itself be a link to another drive. Where it leads is forbidden too, and when that
    // cannot be found out (the drive is not plugged in), nothing is touched.
    for (const name of ['saves', 'Tray']) {
      const forbidden = nativePath.join(folderPath, name)
      try {
        realForbidden.push(await resolveReal(forbidden))
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
  if (isWellFormed(nativePath, paths.desktopDir)) {
    desktopDir = paths.desktopDir
    try {
      realDesktop = await resolveReal(desktopDir)
    } catch {
      // Only a report is refused, as a check that failed.
    }
  }
  const roots: GateRoots = { folderPath, dataDir, desktopDir }
  const realRoots: GateRoots = { folderPath: realFolder, dataDir: realData, desktopDir: realDesktop }

  /** Sorts where the path really leads. Null when it leads into saves or Tray. */
  async function sortReal(target: string): Promise<SortedPath | null> {
    const real = await resolveReal(target)
    if (realForbidden.some((root) => isInside(nativePath, real, root))) return null
    const sorted = sortPath(nativePath, realRoots, real)
    return sorted.zone === 'forbidden' ? null : sorted
  }

  let guarded = false
  async function refusalForWrite(use: WriteUse, target: string): Promise<GateRefusal | null> {
    const named = sortPath(nativePath, roots, target)
    if (named.zone === 'forbidden') return { reason: 'saves-or-tray', path: target }
    if (!named.wellFormed || !mayWrite(use, named)) return outside(target)
    if (named.zone === 'report' && realDesktop === null) return checkFailed(target)
    let real: SortedPath | null
    try {
      real = await sortReal(target)
    } catch (err) {
      return err instanceof LinkToNowhere ? { reason: 'link-escape', path: target } : checkFailed(target)
    }
    if (real === null) return { reason: 'saves-or-tray', path: target }
    if (real.zone !== named.zone || !mayWrite(use, real)) return { reason: 'link-escape', path: target }
    if (GUARDED_ZONES.includes(named.zone)) guarded = true
    return null
  }
  async function refusalForRead(target: string): Promise<GateRefusal | null> {
    const named = sortPath(nativePath, roots, target)
    if (!named.wellFormed || !READ_ZONES.includes(named.zone)) return outside(target)
    try {
      const real = await sortReal(target)
      if (real !== null && !READ_ZONES.includes(real.zone)) return { reason: 'link-escape', path: target }
    } catch (err) {
      return err instanceof LinkToNowhere ? { reason: 'link-escape', path: target } : checkFailed(target)
    }
    return null
  }

  for (const op of ops) {
    let refusal: GateRefusal | null
    if (op.op === 'mkdir') refusal = await refusalForWrite('mkdir', op.path)
    else if (op.op === 'remove') refusal = await refusalForWrite('remove', op.path)
    else if (op.op === 'write') refusal = await refusalForWrite(`write-${op.mode}`, op.path)
    else if (op.op === 'copy') refusal = (await refusalForRead(op.from)) ?? (await refusalForWrite('copy-to', op.to))
    else refusal = (await refusalForWrite('move', op.from)) ?? (await refusalForWrite('move', op.to))
    if (refusal !== null) return refusal
  }
  return { folderPath, secret: request.reason === 'key', ops, roots, guarded }
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

export async function runGate(deps: GateDeps, request: WriteRequest): Promise<GateResult> {
  let approved: Approved | GateRefusal
  try {
    approved = await checkRequest(deps, request)
  } catch {
    approved = checkFailed('')
  }
  if ('reason' in approved) return { status: 'refused', refusal: approved }

  if (approved.guarded) {
    const backup = approved.folderPath === null ? 'unknown' : await askBackup(deps, approved.folderPath)
    // The game is asked last, so nothing waits between its answer and the first change.
    const game = await askGame(deps)
    if (game === 'running') return { status: 'refused', refusal: { reason: 'game-running' } }
    if (game !== 'not-running') return { status: 'refused', refusal: { reason: 'game-state-unknown' } }
    if (backup !== 'verified') return { status: 'refused', refusal: { reason: 'no-verified-backup', backup } }
  }

  for (const [index, op] of approved.ops.entries()) {
    try {
      await carryOut(op, approved)
    } catch (err) {
      const what = 'path' in op ? `${op.op} ${op.path}` : `${op.op} ${op.from} -> ${op.to}`
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

async function carryOut(op: WriteOp, approved: Approved): Promise<void> {
  if (op.op === 'mkdir') {
    await mkdir(op.path, { recursive: true })
  } else if (op.op === 'remove') {
    await removeEntry(op.path, sortPath(nativePath, approved.roots, op.path).zone)
  } else if (op.op === 'write') {
    if (op.mode === 'create') await mustBeMissing(op.path)
    await makeParent(op.path, approved.roots)
    await viaTemp(op.path, async (temp) => {
      const handle = await open(temp, 'wx', approved.secret ? 0o600 : 0o666)
      try {
        await handle.writeFile(op.data)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (op.mode === 'create') await mustBeMissing(op.path)
    })
  } else {
    // Only a plain file is copied or moved. A link or a folder could carry a link into an allowed zone,
    // for a later op to walk through.
    const source = await lstatOrNull(op.from)
    if (source === null) throw new OpFailure('the source is missing')
    if (!source.isFile()) throw new OpFailure('the source is not a plain file')
    await mustBeMissing(op.to)
    await makeParent(op.to, approved.roots)
    if (op.op === 'copy') {
      await placeCopy(op.from, op.to, source, false)
      return
    }
    try {
      await rename(op.from, op.to)
      return
    } catch (err) {
      if (errorCode(err) !== 'EXDEV') throw err
    }
    // Another drive: copy, check the copy, and only then remove the source.
    await placeCopy(op.from, op.to, source, true)
    try {
      await unlink(op.from)
    } catch (err) {
      // Both exist now. Take the copy back only while the source is surely still there.
      const still = await lstatOrNull(op.from).catch(() => null)
      if (still?.isFile() && still.size === source.size) await unlink(op.to).catch(() => undefined)
      throw err
    }
  }
}

/** Never overwrite: the target must be missing. Asked again right before each rename onto it. */
async function mustBeMissing(target: string): Promise<void> {
  if ((await lstatOrNull(target)) !== null) throw new OpFailure('the target already exists')
}

/** Makes the folders above a new file, in the two zones where the gate may make folders. */
async function makeParent(target: string, roots: GateRoots): Promise<void> {
  const { zone } = sortPath(nativePath, roots, target)
  if (zone === 'mods' || zone === 'app-data') await mkdir(nativePath.dirname(target), { recursive: true })
}

/** Fills a temp file beside the target, then renames it into place. The temp file never outlives a failure. */
async function viaTemp(target: string, fill: (temp: string) => Promise<void>): Promise<void> {
  // Not .package or .ts4script: the game must never load a half-written file.
  const temp = `${target}.${randomBytes(6).toString('hex')}.sims-helper-tmp`
  try {
    await fill(temp)
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

async function placeCopy(from: string, to: string, source: Stats, verify: boolean): Promise<void> {
  await viaTemp(to, async (temp) => {
    const copied = await copyBytes(from, temp, verify)
    if (copied.bytes !== source.size) throw new OpFailure('the source changed while it was copied')
    if (verify) {
      const matches = (await stat(temp)).size === source.size && (await sha256File(temp)) === copied.sha256
      if (!matches) throw new OpFailure('the copy does not match the source')
    }
    await utimes(temp, source.atimeMs / 1000, source.mtimeMs / 1000) // keeps the file date
    await mustBeMissing(to)
  })
}

/** Streams a file into a new file, and returns what was read. `flush` waits until the disk has it. */
async function copyBytes(from: string, to: string, flush: boolean): Promise<{ bytes: number; sha256: string }> {
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
      if (flush) await target.sync()
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
