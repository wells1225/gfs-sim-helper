import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BackupRecord, BackupResult, BackupStatus, GameRunState, Progress } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { GateResult, OnProgress, SafetyDeps, WriteOp } from '../ports.ts'
import { freeBytes } from './disk.ts'
import { listFolderFiles } from './files.ts'
import type { ListedFile } from './files.ts'
import { listEntries } from './journal.ts'
import { manifestFile, manifestJson, newestVerified, storedFile } from './manifest.ts'
import type { Manifest, ManifestFile } from './manifest.ts'
import { exists, fromManifestPath, inOneDrive, isInside, manifestKey, missingDirs, pathKey, samePath } from './where.ts'

const OPS_PER_REQUEST = 200
const PROGRESS_EVERY_MS = 100
const SPACE_FACTOR = 1.1

export async function askGame(deps: SafetyDeps): Promise<GameRunState> {
  try {
    return await deps.gameState()
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

function gateDetail(result: GateResult): string {
  if (result.status === 'refused') return `refused: ${result.refusal.reason}`
  if (result.status === 'failed') return result.detail
  return 'done'
}

export async function backupStatus(deps: SafetyDeps, folderPath: string): Promise<BackupStatus> {
  try {
    const manifest = await newestVerified(deps.paths.backupsDir, folderPath)
    if (!manifest) return { state: 'none' }
    const { id: backupId, at } = manifest.record
    const lines = new Map(manifest.files.map((line) => [manifestKey(line.path), line]))
    const journalMoves = new Map<string, number[]>()
    const journalEdits = new Set<string>()
    for (const entry of await listEntries(deps.paths.journalDir)) {
      if (!samePath(entry.folderPath, folderPath)) continue
      for (const step of entry.steps) {
        if (step.state !== 'applied') continue
        if (step.kind === 'move') {
          const key = pathKey(step.to)
          journalMoves.set(key, [...(journalMoves.get(key) ?? []), step.bytes])
        } else if (step.kind === 'edit') {
          journalEdits.add(pathKey(step.path))
        }
      }
    }
    for (const file of await listFolderFiles(folderPath, 'Mods')) {
      const line = lines.get(manifestKey(file.path))
      if (line && line.bytes === file.bytes && sameDate(line.mtimeMs, file.mtimeMs)) continue
      const key = pathKey(file.abs)
      if (journalMoves.get(key)?.includes(file.bytes)) continue
      if (journalEdits.has(key)) continue
      return { state: 'stale', backupId, at }
    }
    return { state: 'verified', backupId, at }
  } catch (err) {
    return { state: 'unknown', detail: (err as Error).message ?? String(err) }
  }
}

/** A line of the newest verified backup that still matches the file, with its stored bytes still in place. */
async function reusable(deps: SafetyDeps, previous: Map<string, ManifestFile>, file: ListedFile): Promise<ManifestFile | null> {
  const line = previous.get(manifestKey(file.path))
  if (!line || line.bytes !== file.bytes || !sameDate(line.mtimeMs, file.mtimeMs)) return null
  try {
    const kept = await stat(storedFile(deps.paths.backupsDir, line))
    return kept.isFile() && kept.size === line.bytes ? line : null
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
  if (game === 'unknown') return { status: 'refused', reason: 'game-state-unknown' }
  if (inOneDrive(paths.backupsDir, paths.oneDriveRoots)) return { status: 'refused', reason: 'backup-folder-in-onedrive' }
  try {
    if (!(await stat(folderPath)).isDirectory()) return { status: 'refused', reason: 'sims-folder-missing' }
  } catch {
    return { status: 'refused', reason: 'sims-folder-missing' }
  }
  if (isInside(paths.backupsDir, folderPath)) {
    return { status: 'failed', detail: 'The backups folder is inside the Sims folder, so no backup was made.' }
  }

  let files: ListedFile[]
  let previous: Manifest | null
  try {
    files = await listFolderFiles(folderPath)
    previous = await newestVerified(paths.backupsDir, folderPath)
  } catch (err) {
    return { status: 'failed', detail: `Could not read the Sims folder: ${(err as Error).message}` }
  }
  const previousLines = new Map((previous?.files ?? []).map((line) => [manifestKey(line.path), line]))
  const kept = new Map<string, ManifestFile>()
  const toCopy: ListedFile[] = []
  for (const file of files) {
    const line = await reusable(deps, previousLines, file)
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
  for (const dir of await missingDirs(paths.backupsDir, planned)) startOps.push({ op: 'mkdir', path: dir })
  startOps.push({ op: 'mkdir', path: backupDir }, { op: 'mkdir', path: filesDir })
  planned.add(pathKey(backupDir)).add(pathKey(filesDir))
  startOps.push({ op: 'write', path: manifestFile(paths.backupsDir, id), data: manifestJson({ record, files: [] }), mode: 'create' })
  const started = await deps.gate.run({ reason: 'backup', folderPath: null, ops: startOps })
  if (started.status !== 'done') return { status: 'failed', detail: `Could not start the backup: ${gateDetail(started)}` }

  const finish = async (state: 'verified' | 'failed', lines: ManifestFile[], detail: string): Promise<BackupResult> => {
    const done: BackupRecord = { ...record, state }
    const written = await deps.gate.run({
      reason: 'backup',
      folderPath: null,
      ops: [{ op: 'write', path: manifestFile(paths.backupsDir, id), data: manifestJson({ record: done, files: lines }), mode: 'replace' }]
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
      const copy = (await exists(target)) ? await stat(target) : null
      const [source, copyHash] = copy?.size === file.bytes ? await Promise.all([sha256File(file.abs), sha256File(target)]) : ['', '']
      if (!copy || copy.size !== file.bytes || source !== copyHash) {
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
