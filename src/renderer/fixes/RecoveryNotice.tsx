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

export function RecoveryNotice() {
  const api = useOptionalApi()
  const { go } = useNav()
  const [recovery, setRecovery] = useState<StartupRecovery | null>(null)
  const [flagged, setFlagged] = useState<JournalEntry[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    // Main put back any cut-off change at start, once. Both calls only read: what that run did, and what is left.
    // They are asked apart, so a journal that cannot be read never hides what the recovery did.

    api
      .invoke('journal:recovery')
      .then((answer) => {
        if (!cancelled) setRecovery(answer)
      })
      .catch(() => {
        // Ignore when the fixes handlers are unavailable.
      })

    api
      .invoke('journal:list')
      .then((entries) => {
        if (cancelled) return
        setFlagged(entries.filter((entry) => entry.status === 'needs-attention' || entry.status === 'in-progress'))
      })
      .catch(() => {
        // Ignore when safety handlers are unavailable (e.g. smoke tests before PR 9 merges).
      })

    return () => {
      cancelled = true
    }
  }, [api])

  if (dismissed) return null

  const failed = recovery?.status === 'failed'
  const putBack = recovery?.status === 'finished' ? recovery.touched.filter((entry) => entry.status === 'undone') : []
  const undoable = flagged.some(canUndo)

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
      : `It was clearing temporary cache files, which is safe: the game makes them again when it starts. ${UNTOUCHED}, and there is nothing more to do.`
  } else if (putBack.length > 0) {
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
