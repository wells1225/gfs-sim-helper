import type { IsoTime, RelPath } from '../../shared/model.ts'

/** The quick filters on Your mods. */
export type ModsFilter = 'all' | 'scripts' | 'older-than-update' | 'set-aside'
/** The sort choices on Your mods. */
export type ModsSort = 'name' | 'largest' | 'oldest'

export interface ModFileInfo {
  relPath: RelPath
  bytes: number
  modifiedAt: IsoTime
}

/** What the filter needs from a row. A row known only from the journal has no files and a null size. */
export interface FilterableMod {
  label: string
  enabled: boolean
  hasScript: boolean
  bytes: number | null
  files: readonly ModFileInfo[]
}

export interface ModsViewOptions {
  query: string
  filter: ModsFilter
  sort: ModsSort
  gameUpdatedAt: IsoTime | null
}

export interface ModsViewRow<T> {
  item: T
  /** Set when the search matched a file rather than the group's name: the file name, or the path for a folder. */
  matchedFile: string | null
}

export interface ModsSummary {
  groups: number
  scripts: number
  bytes: number
  setAside: number
}

/** A big CC pack can hold hundreds of files, so a row lists this many at most. */
export const FILE_LIST_CAP = 25

function toTime(iso: IsoTime): number | null {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

/** The newest modified date among a group's files, in milliseconds, or null when there is none. */
export function newestModifiedAt(files: readonly ModFileInfo[]): number | null {
  let newest: number | null = null
  for (const file of files) {
    const time = toTime(file.modifiedAt)
    if (time !== null && (newest === null || time > newest)) newest = time
  }
  return newest
}

export function baseName(relPath: RelPath): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? relPath : relPath.slice(slash + 1)
}

/** She may paste a Windows path, so backslashes count as forward slashes. */
function normalizeQuery(query: string): string {
  return query.replaceAll('\\', '/').trim().toLowerCase()
}

export function matchMod(item: FilterableMod, query: string): { matches: boolean; matchedFile: string | null } {
  const needle = normalizeQuery(query)
  if (!needle) return { matches: true, matchedFile: null }
  if (item.label.toLowerCase().includes(needle)) return { matches: true, matchedFile: null }
  for (const file of item.files) {
    if (!file.relPath.toLowerCase().includes(needle)) continue
    const name = baseName(file.relPath)
    return { matches: true, matchedFile: name.toLowerCase().includes(needle) ? name : file.relPath }
  }
  return { matches: false, matchedFile: null }
}

function passesFilter(item: FilterableMod, filter: ModsFilter, updatedAt: number | null): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'scripts':
      return item.hasScript
    case 'set-aside':
      return !item.enabled
    case 'older-than-update': {
      if (updatedAt === null) return false
      const newest = newestModifiedAt(item.files)
      return newest !== null && newest < updatedAt
    }
  }
}

function byName(a: FilterableMod, b: FilterableMod): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
}

/** Unknown values go last whichever way the sort runs. */
function nullsLast(a: number | null, b: number | null, order: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return order === 'asc' ? a - b : b - a
}

/** Searches, filters and sorts the rows. Pure: the same input always gives the same rows. */
export function applyModsView<T extends FilterableMod>(items: readonly T[], options: ModsViewOptions): ModsViewRow<T>[] {
  const updatedAt = options.gameUpdatedAt === null ? null : toTime(options.gameUpdatedAt)
  const rows: (ModsViewRow<T> & { newest: number | null })[] = []
  for (const item of items) {
    if (!passesFilter(item, options.filter, updatedAt)) continue
    const match = matchMod(item, options.query)
    if (!match.matches) continue
    rows.push({ item, matchedFile: match.matchedFile, newest: newestModifiedAt(item.files) })
  }

  rows.sort((a, b) => {
    let order = 0
    if (options.sort === 'largest') order = nullsLast(a.item.bytes, b.item.bytes, 'desc')
    else if (options.sort === 'oldest') order = nullsLast(a.newest, b.newest, 'asc')
    return order !== 0 ? order : byName(a.item, b.item)
  })

  return rows.map(({ item, matchedFile }) => ({ item, matchedFile }))
}

export function summarizeMods(items: readonly FilterableMod[]): ModsSummary {
  let scripts = 0
  let bytes = 0
  let setAside = 0
  for (const item of items) {
    if (item.hasScript) scripts += 1
    if (item.bytes !== null) bytes += item.bytes
    if (!item.enabled) setAside += 1
  }
  return { groups: items.length, scripts, bytes, setAside }
}
