import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameRunState, SaveCopy, SaveCopyFile, SaveCopyReason } from '../../shared/model.ts'
import type { AppPaths, Clock, Gate } from '../ports.ts'
import { isStrictIsoTime } from '../safety/manifest.ts'
import { isSafeId } from '../safety/where.ts'
import { newestFirst } from './keep.ts'

/** What the save-copy code needs from AppContext. AppContext itself fits. */
export interface SaveCopyDeps {
  gate: Gate
  paths: AppPaths
  clock: Clock
  newId(): string
  gameState(): Promise<GameRunState>
  /** Free bytes on the drive that holds a folder. Tests pass their own; the default asks statfs. */
  freeBytes?(dir: string): Promise<number>
}

/** Written last into each copy's folder: a folder without it is a copy that never finished, and is not listed. */
export const COPY_FILE = 'copy.json'
/** A saved game in saves/: Slot_ and 8 hex digits. Its .ver0 to .ver4 files are not copies of it. */
export const SAVE_NAME = /^Slot_[0-9a-fA-F]{8}\.save$/

const REASONS: readonly SaveCopyReason[] = ['by-hand', 'game-updated', 'before-change']
const SHA256 = /^[0-9a-f]{64}$/

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function readFileEntry(value: unknown): SaveCopyFile | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, bytes, sha256, savedAt } = value as Record<string, unknown>
  if (typeof name !== 'string' || !SAVE_NAME.test(name)) return null
  if (!isCount(bytes) || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null
  if (typeof savedAt !== 'string' || !isStrictIsoTime(savedAt)) return null
  return { name, bytes, sha256, savedAt }
}

/** A copy.json as written by makeSaveCopy, or null for anything else. Its id must be its folder's name. */
export function readCopyRecord(raw: string, folderName: string): SaveCopy | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { id, at, reason, gameVersion, saves, trayFiles, bytes, status } = parsed as Record<string, unknown>
  if (id !== folderName || typeof id !== 'string' || !isSafeId(id)) return null
  if (typeof at !== 'string' || !isStrictIsoTime(at)) return null
  if (typeof reason !== 'string' || !REASONS.includes(reason as SaveCopyReason)) return null
  if (gameVersion !== null && typeof gameVersion !== 'string') return null
  if (!Array.isArray(saves) || !isCount(trayFiles) || !isCount(bytes)) return null
  if (status !== 'checked' && status !== 'broken') return null
  const files: SaveCopyFile[] = []
  for (const entry of saves) {
    const file = readFileEntry(entry)
    if (file === null) return null
    files.push(file)
  }
  return { id, at, reason: reason as SaveCopyReason, gameVersion, saves: files, trayFiles, bytes, status }
}

/** One copy by id, or null when there is no finished copy of that id. */
export async function readSaveCopy(paths: AppPaths, id: string): Promise<SaveCopy | null> {
  if (!isSafeId(id)) return null
  try {
    return readCopyRecord(await readFile(join(paths.saveCopiesDir, id, COPY_FILE), 'utf8'), id)
  } catch {
    return null
  }
}

/** Every finished copy, newest first. Reads only. */
export async function listSaveCopies(paths: AppPaths): Promise<SaveCopy[]> {
  let names: string[]
  try {
    names = await readdir(paths.saveCopiesDir)
  } catch {
    return []
  }
  const copies: SaveCopy[] = []
  for (const name of names) {
    const copy = await readSaveCopy(paths, name)
    if (copy !== null) copies.push(copy)
  }
  return copies.sort(newestFirst)
}

/** True when the folder is a Sims folder: it holds Options.ini (the gate checks the same). */
export async function isSimsFolder(folderPath: string): Promise<boolean> {
  if (folderPath.length === 0) return false
  try {
    return (await stat(join(folderPath, 'Options.ini'))).isFile()
  } catch {
    return false
  }
}

/** The game's answer, with a throw counted as 'unknown'. */
export async function askGame(deps: Pick<SaveCopyDeps, 'gameState'>): Promise<GameRunState> {
  try {
    const state = await deps.gameState()
    return state === 'running' || state === 'not-running' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}
