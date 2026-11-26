import { AlertTriangle, CheckCircle2, History } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { JournalEntry, StartupRecovery } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { useOptionalApi } from './optional-api.ts'

const UNTOUCHED = 'Your saves and households were never touched'

/** Only a change that is not already undone and has an undo can be put back from History. A cache clear has none. */
function canUndo(entry: JournalEntry): boolean {
  return entry.undo === 'can-undo' && entry.status !== 'undone'
}

function isFlagged(entry: JournalEntry): boolean {
  return entry.status === 'needs-attention' || entry.status === 'in-progress'
}

export function RecoveryNotice({ recovery: givenRecovery }: { recovery?: StartupRecovery | null } = {}) {
  const api = useOptionalApi()
  const { go } = useNav()
  const [fetchedRecovery, setFetchedRecovery] = useState<StartupRecovery | null>(null)
  const [listEntries, setListEntries] = useState<JournalEntry[] | null>(null)
  const [listSettled, setListSettled] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const hasGivenRecovery = givenRecovery !== undefined
  const recovery = hasGivenRecovery ? givenRecovery : fetchedRecovery

  useEffect(() => {
    if (!api || hasGivenRecovery) return
    let cancelled = false

    api
      .invoke('journal:recovery')
      .then((answer) => {
        if (!cancelled) setFetchedRecovery(answer)
      })
      .catch(() => {
        // A rejected recovery call must never look like everything went smoothly.
        if (!cancelled) setFetchedRecovery({ status: 'failed' })
      })

    return () => {
      cancelled = true
    }
  }, [api, hasGivenRecovery])

  useEffect(() => {
    if (!api) return
    let cancelled = false

    api
      .invoke('journal:list')
      .then((entries) => {
        if (cancelled) return
        setListEntries(entries)
        setListSettled(true)
      })
      .catch(() => {
        // Ignore when safety handlers are unavailable (e.g. smoke tests before PR 9 merges).
        if (!cancelled) setListSettled(true)
      })

    return () => {
      cancelled = true
    }
  }, [api])

  if (dismissed) return null

  const failed = recovery?.status === 'failed'
  const touched = recovery?.status === 'finished' ? recovery.touched : []
  const putBack = touched.filter((entry) => entry.status === 'undone')
  const listIds = new Set((listEntries ?? []).map((entry) => entry.id))
  const flagged = [...(listEntries ?? []), ...touched.filter((entry) => !listIds.has(entry.id))].filter(isFlagged)
  const undoable = flagged.some(canUndo)
  const allCacheClears = flagged.length > 0 && flagged.every((entry) => entry.action === 'clear-caches')

  let title: string
  let description: string
  let tone: 'warn' | 'ok' = 'warn'
  if (failed) {
    title = 'We could not check for a cut-off change'
    description = undoable
      ? `When the app opened, it could not check whether a change was cut off last time. ${UNTOUCHED}. Open History and press Undo to put it back.`
      : `When the app opened, it could not check whether a change was cut off last time. ${UNTOUCHED}.`
  } else if (flagged.length > 0) {
    title =
      flagged.length === 1
        ? 'A change was cut off before it finished'
        : `${flagged.length} changes were cut off before they finished`
    description = undoable
      ? `We could not put everything back on our own. ${UNTOUCHED}. Open History and press Undo to put it back.`
      : allCacheClears
        ? `It was clearing temporary cache files, which is safe: the game makes them again when it starts. ${UNTOUCHED}, and there is nothing more to do.`
        : `We could not put everything back on our own. ${UNTOUCHED}.`
  } else if (putBack.length > 0 && listSettled) {
    // Saying all is well waits for the list, which may still hold a change left cut off.
    title =
      putBack.length === 1
        ? 'A change was cut off, so we put things back as they were.'
        : `${putBack.length} changes were cut off, so we put things back as they were.`
    description = `${UNTOUCHED}, and there is nothing more to do.`
    tone = 'ok'
  } else {
    return null
  }

  const Icon = tone === 'warn' ? AlertTriangle : CheckCircle2

  return (
    <Alert variant={tone}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {undoable && (
            <Button variant="outline" size="sm" onClick={() => go({ screen: 'history' })}>
              <History className="size-4" aria-hidden="true" />
              Open History
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
      </div>
    </Alert>
  )
}
