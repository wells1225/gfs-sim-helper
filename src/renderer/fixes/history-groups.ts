import type { IsoTime, JournalEntry } from '../../shared/model.ts'

export type HistoryRow =
  | { kind: 'fix'; entry: JournalEntry }
  | {
      kind: 'fifty-fifty'
      sessionId: string
      latestAt: IsoTime
      entries: JournalEntry[]
      roundCount: number
      canUndoCount: number
      allUndone: boolean
      needsAttention: boolean
    }

/**
 * Orders journal entries newest first and folds every entry belonging to the same
 * 50/50 session into a single row positioned at its newest entry.
 */
export function groupHistoryEntries(entries: readonly JournalEntry[]): HistoryRow[] {
  const sorted = [...entries].sort((a, b) => {
    if (a.at === b.at) return 0
    return a.at > b.at ? -1 : 1
  })

  const rows: HistoryRow[] = []
  const sessionIndex = new Map<string, number>()

  for (const entry of sorted) {
    if (entry.origin.by === 'fifty-fifty') {
      const { sessionId } = entry.origin
      const existingIdx = sessionIndex.get(sessionId)
      if (existingIdx !== undefined) {
        const row = rows[existingIdx]!
        if (row.kind === 'fifty-fifty') {
          row.entries.push(entry)
        }
      } else {
        sessionIndex.set(sessionId, rows.length)
        rows.push({
          kind: 'fifty-fifty',
          sessionId,
          latestAt: entry.at,
          entries: [entry],
          roundCount: 0,
          canUndoCount: 0,
          allUndone: false,
          needsAttention: false
        })
      }
    } else {
      rows.push({ kind: 'fix', entry })
    }
  }

  for (const row of rows) {
    if (row.kind !== 'fifty-fifty') continue
    const rounds = new Set<number>()
    let canUndoCount = 0
    let undoableTotal = 0
    let undoneCount = 0
    let needsAttention = false

    for (const entry of row.entries) {
      if (entry.origin.by === 'fifty-fifty') {
        rounds.add(entry.origin.round)
      }
      if (entry.status === 'needs-attention' || entry.status === 'in-progress') {
        needsAttention = true
      }
      if (entry.undo === 'can-undo') {
        undoableTotal += 1
        if (entry.status === 'undone') {
          undoneCount += 1
        } else {
          canUndoCount += 1
        }
      }
    }

    row.roundCount = rounds.size
    row.canUndoCount = canUndoCount
    row.allUndone = undoableTotal > 0 && undoneCount === undoableTotal
    row.needsAttention = needsAttention
  }

  return rows
}
