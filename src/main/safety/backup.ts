import { lstat, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BackupRecord, BackupResult, BackupStatus, GameRunState, Progress, Sha256 } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { GateResult, OnProgress, SafetyDeps, WriteOp } from '../ports.ts'
import { freeBytes } from './disk.ts'
import { listFolderFiles } from './files.ts'
import type { ListedFile, SkippedLink } from './files.ts'
import { listEntries } from './journal.ts'
import { isStrictIsoTime, manifestFile, manifestJson, newestVerified, normalizeIsoTime, storedFile } from './manifest.ts'
import type { Manifest, ManifestFile } from './manifest.ts'
import {
  fromManifestPath,
  inOneDriveReal,
  isInsideReal,
  isSafeId,
  manifestKey,
  missingDirs,
  pathKey,
  samePath
} from './where.ts'

const OPS_PER_REQUEST = 200
const PROGRESS_EVERY_MS = 100
const SPACE_FACTOR = 1.1
const RACY_WINDOW_MS = 2000

export async function askGame(deps: SafetyDeps): Promise<GameRunState> {
  try {
    const state = await deps.gameState()
    return state === 'running' || state === 'not-running' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Calls onProgress at most once every 100 ms, by the injected clock. */
export function throttled(deps: SafetyDeps, onProgress: OnProgress | undefined): OnProgress {
  let last = Number.NEGATIVE_INFINITY
  return (progress: Progress) => {
    if (!onProgress) return
    const now = deps.clock.now().getTime()
    if (now - last < PROGRESS_EVERY_MS) return
    last = now
    onProgress(progress)
  }
}

function sameDate(a: number, b: number): boolean {
  return Math.floor(a) === Math.floor(b)
}

/** A file whose mtime falls within 2 seconds of when the backup ran may have been overwritten in the same ms. */
function isRacy(backupAt: string, fileMtimeMs: number): boolean {
  const atMs = Date.parse(backupAt)
  return Number.isFinite(atMs) && Math.abs(atMs - fileMtimeMs) < RACY_WINDOW_MS
}

function gateDetail(result: GateResult): string {
  if (result.status === 'refused') return `refused: ${result.refusal.reason}`
  if (result.status === 'failed') return result.detail
  return 'done'
}

const STORED_AT_ONCE = 32

/**
 * Whether every line of the list still has its stored copy, with its size. A list can point into an older backup
 * (`storedIn`), so deleting an old backup folder by hand takes the bytes away from the newest one too.
 */
export async function storedCopiesInPlace(backupsDir: string, lines: ManifestFile[]): Promise<boolean> {
  for (let start = 0; start < lines.length; start += STORED_AT_ONCE) {
    const found = await Promise.all(
      lines.slice(start, start + STORED_AT_ONCE).map(async (line) => {
        try {
          const kept = await lstat(storedFile(backupsDir, line))
          return kept.isFile() && kept.size === line.bytes
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code
          if (code === 'ENOENT' || code === 'ENOTDIR') return false
          throw err
        }
      })
    )
    if (found.includes(false)) return false
  }
  return true
}

const STATUS_UNKNOWN = 'We could not check your safety copy right now.'

export async function backupStatus(deps: SafetyDeps, folderPath: string): Promise<BackupStatus> {
  try {
    const manifest = await newestVerified(deps.paths.backupsDir, folderPath)
    if (!manifest) return { state: 'none' }
    const { id: backupId, at: rawAt } = manifest.record
    if (!isSafeId(backupId) || !isStrictIsoTime(rawAt)) {
      return { state: 'unknown', detail: STATUS_UNKNOWN }
    }
    const at = normalizeIsoTime(rawAt)
    // A backup that lost any of its bytes covers nothing. `stale` makes the next backup copy them again.
    if (!(await storedCopiesInPlace(deps.paths.backupsDir, manifest.files))) return { state: 'stale', backupId, at }
    const lines = new Map(manifest.files.map((line) => [manifestKey(line.path), line]))
    const journalMoves = new Map<string, { bytes: number; sha256: Sha256 }[]>()
    const journalEdits = new Map<string, Sha256[]>()
    for (const entry of await listEntries(deps.paths.journalDir)) {
      if (!samePath(entry.folderPath, folderPath) || entry.backupId !== backupId) continue
      for (const step of entry.steps) {
        if (step.state !== 'applied') continue
        if (step.kind === 'move') {
          const key = pathKey(step.to)
          journalMoves.set(key, [...(journalMoves.get(key) ?? []), { bytes: step.bytes, sha256: step.sha256 }])
        } else if (step.kind === 'edit') {
          const key = pathKey(step.path)
          journalEdits.set(key, [...(journalEdits.get(key) ?? []), step.afterSha256])
        }
      }
    }
    const { files } = await listFolderFiles(folderPath, 'Mods')
    for (const file of files) {
      const line = lines.get(manifestKey(file.path))
      if (line && line.bytes === file.bytes && sameDate(line.mtimeMs, file.mtimeMs)) {
        if (!isRacy(at, file.mtimeMs) || (await sha256File(file.abs)) === line.sha256) continue
      }
      const key = pathKey(file.abs)
      const moves = journalMoves.get(key)?.filter((m) => m.bytes === file.bytes)
      const edits = journalEdits.get(key)
      if ((moves && moves.length > 0) || (edits && edits.length > 0)) {
        const hash = await sha256File(file.abs)
        if (moves?.some((m) => m.sha256 === hash) || edits?.includes(hash)) continue
      }
      return { state: 'stale', backupId, at }
    }
    return { state: 'verified', backupId, at }
  } catch {
    // backup:status sends this to the screen side, so the raw error and its paths stay here.
    return { state: 'unknown', detail: STATUS_UNKNOWN }
  }
}

/** A line of the newest verified backup that still matches the file, with its stored bytes still in place. */
async function reusable(
  deps: SafetyDeps,
  previous: Map<string, ManifestFile>,
  previousAt: string | null,
  file: ListedFile
): Promise<ManifestFile | null> {
  const line = previous.get(manifestKey(file.path))
  if (!line || line.bytes !== file.bytes || !sameDate(line.mtimeMs, file.mtimeMs)) return null
  try {
    const kept = await lstat(storedFile(deps.paths.backupsDir, line))
    if (!kept.isFile() || kept.size !== line.bytes) return null
    if (previousAt !== null && isRacy(previousAt, file.mtimeMs)) {
      if ((await sha256File(file.abs)) !== line.sha256) return null
    }
    return line
  } catch {
    return null
  }
}

const inFlight = new WeakMap<SafetyDeps, number>()

export function backupInFlight(deps: SafetyDeps): boolean {
  return (inFlight.get(deps) ?? 0) > 0
}

/** Counts a backup as running from the moment it is asked for, so a second one is refused. */
export async function tracked<T>(deps: SafetyDeps, run: () => Promise<T>): Promise<T> {
  inFlight.set(deps, (inFlight.get(deps) ?? 0) + 1)
  try {
    return await run()
  } finally {
    inFlight.set(deps, (inFlight.get(deps) ?? 1) - 1)
  }
}

/** The backup itself, with no lock and no "already running" check: index.ts adds those. */
export async function makeBackup(deps: SafetyDeps, folderPath: string, onProgress?: OnProgress): Promise<BackupResult> {
  const { paths } = deps
  const game = await askGame(deps)
  if (game === 'running') return { status: 'refused', reason: 'game-running' }
  if (game !== 'not-running') return { status: 'refused', reason: 'game-state-unknown' }
  if (await inOneDriveReal(paths.backupsDir, paths.oneDriveRoots)) {
    return { status: 'refused', reason: 'backup-folder-in-onedrive' }
  }
  try {
    if (!(await stat(folderPath)).isDirectory()) return { status: 'refused', reason: 'sims-folder-missing' }
  } catch {
    return { status: 'refused', reason: 'sims-folder-missing' }
  }
  if (await isInsideReal(paths.backupsDir, folderPath)) {
    return { status: 'refused', reason: 'backup-folder-in-sims-folder' }
  }

  let files: ListedFile[]
  let skipped: SkippedLink[]
  let previous: Manifest | null
  try {
    const listed = await listFolderFiles(folderPath)
    files = listed.files
    skipped = listed.skipped
    previous = await newestVerified(paths.backupsDir, folderPath)
  } catch (err) {
    return { status: 'failed', detail: `Could not read the Sims folder: ${(err as Error).message}` }
  }
  const previousLines = new Map((previous?.files ?? []).map((line) => [manifestKey(line.path), line]))
  const previousAt = previous?.record.at ?? null
  const kept = new Map<string, ManifestFile>()
  const toCopy: ListedFile[] = []
  for (const file of files) {
    const line = await reusable(deps, previousLines, previousAt, file)
    if (line) kept.set(file.path, line)
    else toCopy.push(file)
  }
  const bytesToCopy = toCopy.reduce((sum, file) => sum + file.bytes, 0)
  try {
    if ((await freeBytes(paths.backupsDir)) < SPACE_FACTOR * bytesToCopy) return { status: 'refused', reason: 'not-enough-space' }
  } catch (err) {
    return { status: 'failed', detail: `Could not check the free space: ${(err as Error).message}` }
  }

  const id = deps.newId()
  const backupDir = join(paths.backupsDir, id)
  const filesDir = join(backupDir, 'files')
  const record: BackupRecord = {
    id,
    at: deps.clock.now().toISOString(),
    folderPath,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    state: 'copying'
  }

  const startOps: WriteOp[] = []
  const planned = new Set<string>()
  for (const dir of await missingDirs(filesDir, planned)) startOps.push({ op: 'mkdir', path: dir })
  planned.add(pathKey(paths.backupsDir)).add(pathKey(backupDir)).add(pathKey(filesDir))
  startOps.push({
    op: 'write',
    path: manifestFile(paths.backupsDir, id),
    data: manifestJson({ record, files: [], skipped }),
    mode: 'create'
  })
  const started = await deps.gate.run({ reason: 'backup', folderPath: null, ops: startOps })
  if (started.status !== 'done') return { status: 'failed', detail: `Could not start the backup: ${gateDetail(started)}` }

  const finish = async (state: 'verified' | 'failed', lines: ManifestFile[], detail: string): Promise<BackupResult> => {
    const done: BackupRecord = { ...record, state }
    const written = await deps.gate.run({
      reason: 'backup',
      folderPath: null,
      ops: [
        {
          op: 'write',
          path: manifestFile(paths.backupsDir, id),
          data: manifestJson({ record: done, files: lines, skipped }),
          mode: 'replace'
        }
      ]
    })
    if (state === 'failed') return { status: 'failed', detail }
    if (written.status !== 'done') return { status: 'failed', detail: `Could not save the backup list: ${gateDetail(written)}` }
    return { status: 'verified', record: done }
  }

  try {
    const progress = throttled(deps, onProgress)
    const ops: WriteOp[] = []
    for (const file of toCopy) {
      const target = fromManifestPath(filesDir, file.path)
      for (const dir of await missingDirs(dirname(target), planned)) ops.push({ op: 'mkdir', path: dir })
      ops.push({ op: 'copy', from: file.abs, to: target })
    }
    let copied = 0
    progress({ task: 'backup', stage: 'copying', done: 0, total: toCopy.length })
    for (let start = 0; start < ops.length; start += OPS_PER_REQUEST) {
      const chunk = ops.slice(start, start + OPS_PER_REQUEST)
      const result = await deps.gate.run({ reason: 'backup', folderPath, ops: chunk })
      if (result.status !== 'done') return await finish('failed', [], `The copy stopped: ${gateDetail(result)}`)
      copied += chunk.filter((op) => op.op === 'copy').length
      progress({ task: 'backup', stage: 'copying', done: copied, total: toCopy.length })
    }

    const lines: ManifestFile[] = []
    let checked = 0
    for (const file of files) {
      const line = kept.get(file.path)
      if (line) {
        lines.push(line)
        continue
      }
      const target = fromManifestPath(filesDir, file.path)
      const [srcInfo, copy] = await Promise.all([lstat(file.abs).catch(() => null), lstat(target).catch(() => null)])
      const unchanged =
        srcInfo !== null && srcInfo.isFile() && srcInfo.size === file.bytes && sameDate(srcInfo.mtimeMs, file.mtimeMs)
      const copyOk = copy !== null && copy.isFile() && copy.size === file.bytes
      const [source, copyHash] = unchanged && copyOk ? await Promise.all([sha256File(file.abs), sha256File(target)]) : ['', '']
      if (!unchanged || !copyOk || source !== copyHash) {
        return await finish('failed', lines, `The copy of ${file.path} does not match the original.`)
      }
      lines.push({ path: file.path, bytes: file.bytes, mtimeMs: file.mtimeMs, sha256: copyHash, storedIn: id })
      checked += 1
      progress({ task: 'backup', stage: 'checking', done: checked, total: toCopy.length })
    }
    return await finish('verified', lines, '')
  } catch (err) {
    const detail = `The backup stopped: ${(err as Error).message}`
    return await finish('failed', [], detail).catch((): BackupResult => ({ status: 'failed', detail }))
  }
}
