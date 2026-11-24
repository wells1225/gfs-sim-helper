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

  const count = flagged.length
  const title =
    count === 1
      ? 'A previous change stopped partway through'
      : `${count} previous changes stopped partway through`

  return (
    <Alert variant="warn">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
              Your Saves and Tray were never touched. Open History to review or undo what moved.
            </AlertDescription>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => go({ screen: 'history' })}>
            <History className="size-4" aria-hidden="true" />
            Open History
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
      </div>
    </Alert>
  )
}
