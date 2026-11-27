import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SaveCopy, SaveCopyFile, SaveCopyMade, SaveCopyReason } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import { readGameVersionFromTxt } from '../locate/game-install.ts'
import type { GateResult, WriteOp } from '../ports.ts'
import { freeBytes as diskFreeBytes } from '../safety/disk.ts'
import { copiesToKeep } from './keep.ts'
import { isSafeId } from '../safety/where.ts'
import { askGame, COPY_FILE, isSimsFolder, listSaveCopies, SAVE_NAME, type SaveCopyDeps } from './store.ts'

export { listSaveCopies, readSaveCopy, type SaveCopyDeps } from './store.ts'

/** A before-change copy is made at most once in this long. */
export const BEFORE_CHANGE_EVERY_MS = 24 * 60 * 60 * 1000

interface Found {
  /** Relative to the Sims folder, as path parts: ['saves', name] or ['Tray', ...]. */
  parts: string[]
  bytes: number
  mtime: Date
}

/** The Slot_*.save files directly in saves/. Not their .ver files, not scratch/, not links. */
async function findSaves(folderPath: string): Promise<Found[]> {
  let names: string[]
  try {
    names = await readdir(join(folderPath, 'saves'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw err
  }
  const found: Found[] = []
  for (const name of names.sort()) {
    if (!SAVE_NAME.test(name)) continue
    const info = await lstat(join(folderPath, 'saves', name))
    if (info.isFile()) found.push({ parts: ['saves', name], bytes: info.size, mtime: info.mtime })
  }
  return found
}

/** Every plain file in Tray/, in its subfolders too. Links are left out: the gate copies only plain files. */
async function findTray(folderPath: string, below: string[] = []): Promise<Found[]> {
  let names: string[]
  try {
    names = await readdir(join(folderPath, 'Tray', ...below))
  } catch (err) {
    if (below.length === 0 && (err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw err
  }
  const found: Found[] = []
  for (const name of names.sort()) {
    const parts = [...below, name]
    const info = await lstat(join(folderPath, 'Tray', ...parts))
    if (info.isDirectory()) found.push(...(await findTray(folderPath, parts)))
    else if (info.isFile()) found.push({ parts: ['Tray', ...parts], bytes: info.size, mtime: info.mtime })
  }
  return found
}

async function hashOrNull(file: string): Promise<string | null> {
  try {
    return await sha256File(file)
  } catch {
    return null
  }
}

const refused = (why: Extract<SaveCopyMade, { kind: 'refused' }>['why']): SaveCopyMade => ({ kind: 'refused', why })

/** Takes a copy folder that never finished back out of app data. Its failure changes nothing for her. */
async function removeFolder(deps: SaveCopyDeps, folder: string): Promise<void> {
  try {
    await deps.gate.run({ reason: 'save-copy', folderPath: null, ops: [{ op: 'remove', path: folder }] })
  } catch {
    // left for the next list to skip: it has no copy.json
  }
}

/** Removes the copies the keep rule drops. Only called once a new copy is checked, and never removes that copy. */
async function pruneCopies(deps: SaveCopyDeps, newCopyId: string): Promise<void> {
  const copies = await listSaveCopies(deps.paths)
  const keep = copiesToKeep(copies)
  const ops: WriteOp[] = copies
    .filter((copy) => copy.id !== newCopyId && !keep.has(copy.id))
    .map((copy) => ({ op: 'remove', path: join(deps.paths.saveCopiesDir, copy.id) }))
  if (ops.length > 0) await deps.gate.run({ reason: 'save-copy', folderPath: null, ops })
}

function gameRefusal(result: GateResult): SaveCopyMade | null {
  if (result.status !== 'refused') return null
  if (result.refusal.reason === 'game-running') return refused('game-running')
  if (result.refusal.reason === 'game-state-unknown') return refused('game-state-unknown')
  return null
}

/**
 * Copies every Slot_*.save in saves/ and everything in Tray/ into <saveCopiesDir>/<id>/, through the gate as a
 * 'save-copy'. Nothing in saves/ or Tray/ is changed. Each save is hashed before and after; a mismatch marks the
 * copy broken. copy.json is written last.
 */
export async function makeSaveCopy(
  deps: SaveCopyDeps,
  folderPath: string | null,
  reason: SaveCopyReason
): Promise<SaveCopyMade> {
  if (folderPath === null || !(await isSimsFolder(folderPath))) return refused('no-folder')
  // A save copied while the game writes it can be broken.
  const game = await askGame(deps)
  if (game === 'running') return refused('game-running')
  if (game !== 'not-running') return refused('game-state-unknown')

  let saves: Found[]
  let tray: Found[]
  try {
    saves = await findSaves(folderPath)
    tray = await findTray(folderPath)
  } catch {
    return refused('error')
  }
  const bytes = [...saves, ...tray].reduce((sum, file) => sum + file.bytes, 0)
  try {
    const free = await (deps.freeBytes ?? diskFreeBytes)(deps.paths.saveCopiesDir)
    if (!(free >= bytes * 2)) return refused('disk-full')
  } catch {
    return refused('error')
  }

  const before = new Map<string, string | null>()
  for (const save of saves) before.set(save.parts[1]!, await hashOrNull(join(folderPath, ...save.parts)))

  // An id that is not a plain name, or one whose folder is there, could make the clean-up below remove a copy
  // that is not this one, or the whole save-copies folder. Neither is ever written to.
  const id = deps.newId()
  if (typeof id !== 'string' || !isSafeId(id)) return refused('error')
  const copyDir = join(deps.paths.saveCopiesDir, id)
  try {
    await lstat(copyDir)
    return refused('error')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return refused('error')
  }
  const ops: WriteOp[] = [...saves, ...tray].map((file) => ({
    op: 'copy',
    from: join(folderPath, ...file.parts),
    to: join(copyDir, ...file.parts)
  }))
  if (ops.length === 0) ops.push({ op: 'mkdir', path: join(copyDir, 'saves') })
  let result: GateResult
  try {
    result = await deps.gate.run({ reason: 'save-copy', folderPath, ops })
  } catch {
    result = { status: 'failed', opsDone: 0, detail: 'the gate threw' }
  }
  if (result.status !== 'done') {
    if (result.status === 'failed') await removeFolder(deps, copyDir)
    return gameRefusal(result) ?? refused('error')
  }

  let checked = true
  const files: SaveCopyFile[] = []
  for (const save of saves) {
    const name = save.parts[1]!
    const was = before.get(name) ?? null
    const now = await hashOrNull(join(copyDir, 'saves', name))
    if (was === null || now !== was) checked = false
    files.push({ name, bytes: save.bytes, sha256: was ?? now ?? '0'.repeat(64), savedAt: save.mtime.toISOString() })
  }
  const copy: SaveCopy = {
    id,
    at: deps.clock.now().toISOString(),
    reason,
    gameVersion: (await readGameVersionFromTxt(folderPath)) ?? null,
    saves: files,
    trayFiles: tray.length,
    bytes,
    status: checked ? 'checked' : 'broken'
  }
  let written: GateResult
  try {
    written = await deps.gate.run({
      reason: 'save-copy',
      folderPath: null,
      ops: [{ op: 'write', path: join(copyDir, COPY_FILE), data: `${JSON.stringify(copy, null, 2)}\n`, mode: 'create' }]
    })
  } catch {
    written = { status: 'failed', opsDone: 0, detail: 'the gate threw' }
  }
  if (written.status !== 'done') {
    await removeFolder(deps, copyDir)
    return refused('error')
  }
  if (copy.status === 'checked') {
    try {
      await pruneCopies(deps, copy.id)
    } catch {
      // an old copy kept a little longer is no harm
    }
  }
  return { kind: 'done', copy }
}

/**
 * PR 15's hook in fix:apply: a 'before-change' copy before a change to Mods, at most once a day. It never throws
 * and its answer is never read: a refused or failed copy must not stop the fix.
 */
export async function copyBeforeChange(deps: SaveCopyDeps, folderPath: string | null): Promise<void> {
  try {
    const now = deps.clock.now().getTime()
    const copies = await listSaveCopies(deps.paths)
    const recent = copies.some(
      // A broken copy cannot be put back, so it does not count.
      (copy) =>
        copy.reason === 'before-change' &&
        copy.status === 'checked' &&
        Math.abs(now - Date.parse(copy.at)) < BEFORE_CHANGE_EVERY_MS
    )
    if (recent) return
    await makeSaveCopy(deps, folderPath, 'before-change')
  } catch {
    // never blocks the fix
  }
}
