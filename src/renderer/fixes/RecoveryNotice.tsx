import { AlertTriangle, History } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { JournalEntry } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { useOptionalApi } from './optional-api.ts'

export function RecoveryNotice() {
  const api = useOptionalApi()
  const { go } = useNav()
  const [flagged, setFlagged] = useState<JournalEntry[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    // Main has already tried to put a cut-off change back at start; this list only reads what is left.

    api
      .invoke('journal:list')
      .then((entries) => {
        if (cancelled) return
        const needsReview = entries.filter(
          (entry) => entry.status === 'needs-attention' || entry.status === 'in-progress'
        )
        setFlagged(needsReview)
      })
      .catch(() => {
        // Ignore when safety handlers are unavailable (e.g. smoke tests before PR 9 merges).
      })

    return () => {
      cancelled = true
    }
  }, [api])

  if (dismissed || flagged.length === 0) {
    return null
  }

  // Only a change with an undo can be put back from History. A cache clear has none, and needs nothing more.
  const canUndo = flagged.some((entry) => entry.undo === 'can-undo')
  const title =
    flagged.length === 1 ? 'A change was cut off before it finished' : `${flagged.length} changes were cut off before they finished`
  const description = canUndo
    ? 'We could not put everything back on our own. Your saves and households were never touched. Open History and press Undo to put it back.'
    : 'It was clearing temporary cache files, which is safe: the game makes them again when it starts. Your saves and households were never touched, and there is nothing more to do.'

  return (
    <Alert variant="warn">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
              {description}
            </AlertDescription>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canUndo && (
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
