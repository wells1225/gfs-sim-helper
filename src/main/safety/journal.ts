import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JournalEntry } from '../../shared/model.ts'
import type { GateResult, SafetyDeps, WriteOp } from '../ports.ts'
import { isSafeId, missingDirs } from './where.ts'

export function entryFile(journalDir: string, id: string): string {
  return join(journalDir, `${id}.json`)
}

function looksLikeEntry(value: unknown): value is JournalEntry {
  const entry = value as JournalEntry | null
  return typeof entry?.id === 'string' && Array.isArray(entry.steps) && typeof entry.status === 'string'
}

/**
 * 'missing' only when no file holds the entry (or the id could never name one). A file that is there but cannot be
 * read, does not parse, or holds some other entry is 'unreadable': the entry may still exist.
 */
export async function findEntry(journalDir: string, id: string): Promise<JournalEntry | 'missing' | 'unreadable'> {
  if (!isSafeId(id)) return 'missing'
  let text: string
  try {
    text = await readFile(entryFile(journalDir, id), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return looksLikeEntry(parsed) && parsed.id === id ? parsed : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

export async function readEntry(journalDir: string, id: string): Promise<JournalEntry | null> {
  const found = await findEntry(journalDir, id)
  return typeof found === 'string' ? null : found
}

/** Every readable entry, newest first. */
export async function listEntries(journalDir: string): Promise<JournalEntry[]> {
  let names: string[]
  try {
    names = await readdir(journalDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return []
    throw err
  }
  const entries: JournalEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const entry = await readEntry(journalDir, name.slice(0, -'.json'.length))
    if (entry) entries.push(entry)
  }
  return entries.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
}

/** Writes the entry through the gate. 'create' makes the journal folder first when it is missing. */
export async function saveEntry(deps: SafetyDeps, entry: JournalEntry, mode: 'create' | 'replace'): Promise<GateResult> {
  const ops: WriteOp[] = []
  if (mode === 'create') {
    for (const dir of await missingDirs(deps.paths.journalDir, new Set())) ops.push({ op: 'mkdir', path: dir })
  }
  ops.push({ op: 'write', path: entryFile(deps.paths.journalDir, entry.id), data: JSON.stringify(entry), mode })
  return await journalRequest(deps, ops)
}

export async function removeEntry(deps: SafetyDeps, id: string): Promise<GateResult> {
  return await journalRequest(deps, [{ op: 'remove', path: entryFile(deps.paths.journalDir, id) }])
}

/**
 * Removes the entry's file only when it holds exactly this entry, byte for byte as saveEntry wrote it: an older
 * entry that already had the id is never touched. Does nothing when the file is missing or cannot be read.
 */
export async function removeEntryIfSame(deps: SafetyDeps, entry: JournalEntry): Promise<void> {
  if (!isSafeId(entry.id)) return
  const path = entryFile(deps.paths.journalDir, entry.id)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile()) return
  const onDisk = await readFile(path).catch(() => null)
  if (onDisk && onDisk.equals(Buffer.from(JSON.stringify(entry), 'utf8'))) await removeEntry(deps, entry.id)
}

/**
 * A journal write never throws: a gate that throws counts as a write that failed. So once files have moved, the
 * caller always gets to report how far it got.
 */
async function journalRequest(deps: SafetyDeps, ops: WriteOp[]): Promise<GateResult> {
  try {
    return await deps.gate.run({ reason: 'journal', folderPath: null, ops })
  } catch (err) {
    return { status: 'failed', opsDone: 0, detail: (err as Error).message ?? String(err) }
  }
}
