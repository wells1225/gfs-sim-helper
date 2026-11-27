import type { SaveCopy } from '../../shared/model.ts'

/** How many of the newest copies are always kept. */
export const KEEP_NEWEST = 10
/** For each of this many newest game versions, the oldest checked copy is kept too: her saves from before an update. */
export const KEEP_VERSIONS = 3

/** Newest first: by date, then by id. */
export function newestFirst(a: SaveCopy, b: SaveCopy): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** Compares two game versions part by part as numbers ('1.12.0.0' is newer than '1.9.0.0'). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The ids of the copies to keep (briefs/pr-15.md): the newest 10, plus the oldest checked copy of each of the
 * last 3 game versions. Every other copy may be removed.
 */
export function copiesToKeep(copies: readonly SaveCopy[]): Set<string> {
  const sorted = [...copies].sort(newestFirst)
  const keep = new Set(sorted.slice(0, KEEP_NEWEST).map((copy) => copy.id))
  const versions = [...new Set(copies.flatMap((copy) => (copy.gameVersion === null ? [] : [copy.gameVersion])))]
    .sort((a, b) => compareVersions(b, a))
    .slice(0, KEEP_VERSIONS)
  for (const version of versions) {
    const oldest = sorted.filter((copy) => copy.gameVersion === version && copy.status === 'checked').at(-1)
    if (oldest !== undefined) keep.add(oldest.id)
  }
  return keep
}
