import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JournalEntry } from '../../shared/model.ts'
import type { GateResult, SafetyDeps, WriteOp } from '../ports.ts'
import { missingDirs } from './where.ts'

export function entryFile(journalDir: string, id: string): string {
  return join(journalDir, `${id}.json`)
}

function looksLikeEntry(value: unknown): value is JournalEntry {
  const entry = value as JournalEntry | null
  return typeof entry?.id === 'string' && Array.isArray(entry.steps) && typeof entry.status === 'string'
}

export async function readEntry(journalDir: string, id: string): Promise<JournalEntry | null> {
  if (!/^[\w.-]+$/.test(id)) return null
  try {
    const parsed: unknown = JSON.parse(await readFile(entryFile(journalDir, id), 'utf8'))
    return looksLikeEntry(parsed) && parsed.id === id ? parsed : null
  } catch {
    return null
  }
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
  return await deps.gate.run({ reason: 'journal', folderPath: null, ops })
}

export async function removeEntry(deps: SafetyDeps, id: string): Promise<GateResult> {
  return await deps.gate.run({
    reason: 'journal',
    folderPath: null,
    ops: [{ op: 'remove', path: entryFile(deps.paths.journalDir, id) }]
  })
}
