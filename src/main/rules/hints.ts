// Matches a log's modHints to the Python files inside her .ts4script mods.
import type { ModFile, RelPath } from '../../shared/model.ts'

export interface EntryOwner {
  groupId: string
  file: RelPath
  entry: string // as stored in the .ts4script
}

const PYTHON_ENTRY = /\.(py|pyc|pyo)$/i

/** Maps 'wicked_wardrobe/outfit_picker' (lowercased, no extension) to the script files that hold it. */
export function buildEntryIndex(files: readonly ModFile[]): Map<string, EntryOwner[]> {
  const index = new Map<string, EntryOwner[]>()
  for (const file of files) {
    if (file.kind !== 'script' || file.script.status !== 'ok') continue
    for (const entry of file.script.entries) {
      if (!PYTHON_ENTRY.test(entry)) continue
      const key = entry.replace(PYTHON_ENTRY, '').replaceAll('\\', '/').toLowerCase()
      if (key === '' || key.endsWith('/')) continue
      if (key.split('/').pop() === '__init__') continue // every package has one, so it names nobody
      const owners = index.get(key)
      const owner = { groupId: file.groupId, file: file.relPath, entry }
      if (owners) owners.push(owner)
      else index.set(key, [owner])
    }
  }
  return index
}

/**
 * The entries a hint names: it must end with '/' + the entry. The longest such entry wins; if the files holding it
 * are in more than one group, the hint names nobody and this returns [].
 */
export function matchHint(hint: string, index: ReadonlyMap<string, readonly EntryOwner[]>): EntryOwner[] {
  const text = hint.replaceAll('\\', '/').toLowerCase()
  for (let slash = text.indexOf('/'); slash !== -1; slash = text.indexOf('/', slash + 1)) {
    const owners = index.get(text.slice(slash + 1))
    if (!owners) continue
    const groups = new Set(owners.map((o) => o.groupId))
    return groups.size === 1 ? [...owners] : []
  }
  return []
}
