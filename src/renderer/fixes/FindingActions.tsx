import { AlertTriangle, CheckCircle2, Info, RotateCcw, ShieldAlert, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Finding, FixId, FixRefusal, JournalEntry, Progress } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { FIX_BUTTON_LABEL, progressCopy, refusalMessage } from './words.ts'

type ActionState =
  | { phase: 'idle' }
  | { phase: 'running'; fix: FixId }
  | { phase: 'done'; entry: JournalEntry; undone: boolean }
  | { phase: 'refused'; fix: FixId; refusal: FixRefusal }
  | { phase: 'stopped-part-way'; entry: JournalEntry; detail: string }

export function FindingActions({ finding }: { finding: Finding }) {
  const api = useApi()
  const { go } = useNav()
  const { setScan } = useSession()

  const [state, setState] = useState<ActionState>({ phase: 'idle' })
  const [progress, setProgress] = useState<Progress | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isRunning = state.phase === 'running' || undoBusy

  useEffect(() => {
    if (!isRunning) {
      setProgress(null)
      return
    }
    return api.onProgress((p) => {
      if (mountedRef.current && (p.task === 'backup' || p.task === 'fix')) {
        setProgress(p)
      }
    })
  }, [api, isRunning])

  const handleCheckAgain = useCallback(() => {
    setScan(null)
    go({ screen: 'check-up' })
  }, [go, setScan])

  const handleUndo = useCallback(
    async (entryId: string, originalSummary: string) => {
      setUndoBusy(true)
      try {
        const outcome = await api.invoke('journal:undo', { entryId })
        if (!mountedRef.current) return
        if (outcome.status === 'done') {
          setState({ phase: 'done', entry: outcome.entry, undone: true })
          toast('Undone', { description: `Put everything back for: ${originalSummary}` })
        } else if (outcome.status === 'refused') {
          setState({
            phase: 'refused',
            fix: finding.fixes[0]?.fix ?? 'set-aside-files',
            refusal: outcome.refusal
          })
        } else {
          setState({
            phase: 'stopped-part-way',
            entry: outcome.entry,
            detail: outcome.detail
          })
        }
      } finally {
        if (mountedRef.current) {
          setUndoBusy(false)
        }
      }
    },
    [api, finding.fixes]
  )

  const runFix = useCallback(
    async (fix: FixId) => {
      setProgress(null)
      setState({ phase: 'running', fix })
      const outcome = await api.invoke('fix:apply', {
        via: 'finding',
        findingId: finding.id,
        fix
      })
      if (!mountedRef.current) return

      if (outcome.status === 'done') {
        const { entry } = outcome
        setState({ phase: 'done', entry, undone: false })
        if (entry.undo === 'can-undo') {
          toast(entry.summary, {
            description: 'A safety copy was made first. You can undo this anytime in History.',
            action: {
              label: 'Undo',
              onClick: () => {
                void handleUndo(entry.id, entry.summary)
              }
            }
          })
        } else {
          toast(entry.summary, {
            description: 'The game rebuilds these temporary files on its own.'
          })
        }
        return
      }

      if (outcome.status === 'refused') {
        setState({ phase: 'refused', fix, refusal: outcome.refusal })
        return
      }

      setState({
        phase: 'stopped-part-way',
        entry: outcome.entry,
        detail: outcome.detail
      })
    },
    [api, finding.id, handleUndo]
  )

  if (finding.fixes.length === 0) {
    return null
  }

  if (state.phase === 'running' || undoBusy) {
    const copy = progressCopy(progress)
    return (
      <div
        aria-live="polite"
        className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 px-3.5 py-3"
      >
        <div className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
          <span>{undoBusy && !progress ? 'Putting files back…' : copy.heading}</span>
          {copy.detail && <span className="tabular-nums text-muted-foreground">{copy.detail}</span>}
        </div>
        <ProgressBar value={copy.percent} aria-label={copy.heading} />
      </div>
    )
  }

  if (state.phase === 'done') {
    return (
      <div
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-severity-ok-border bg-severity-ok-bg px-3.5 py-2.5 text-severity-ok"
      >
        <div className="flex items-center gap-2 text-[0.9375rem] font-medium">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {state.undone ? 'Undone — put back the way it was.' : state.entry.summary}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {!state.undone && state.entry.undo === 'can-undo' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleUndo(state.entry.id, state.entry.summary)}
            >
              <Undo2 className="size-4" aria-hidden="true" />
              Undo
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleCheckAgain}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Check again
          </Button>
        </div>
      </div>
    )
  }

  if (state.phase === 'refused') {
    const copy = refusalMessage(state.refusal)
    const variant =
      copy.tone === 'destructive' ? 'destructive' : copy.tone === 'info' ? 'info' : 'warn'
    const Icon =
      copy.tone === 'destructive' ? ShieldAlert : copy.tone === 'info' ? Info : AlertTriangle
    const showCheckAgain =
      state.refusal.why === 'out-of-date' && state.refusal.detail !== 'nothing-to-do'

    return (
      <Alert variant={variant}>
        <div className="flex items-start gap-2.5">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-2">
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.detail}</AlertDescription>
            {(copy.canRetry || showCheckAgain) && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {copy.canRetry && (
                  <Button variant="outline" size="sm" onClick={() => void runFix(state.fix)}>
                    Try again
                  </Button>
                )}
                {showCheckAgain && (
                  <Button variant="outline" size="sm" onClick={handleCheckAgain}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Check again
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </Alert>
    )
  }

  if (state.phase === 'stopped-part-way') {
    return (
      <Alert variant="warn">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-2">
            <AlertTitle>This fix stopped partway through</AlertTitle>
            <AlertDescription>
              {state.detail || 'Not every file finished moving. You can undo what moved so far.'}
            </AlertDescription>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {state.entry.undo === 'can-undo' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleUndo(state.entry.id, state.entry.summary)}
                >
                  <Undo2 className="size-4" aria-hidden="true" />
                  Undo
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => go({ screen: 'history' })}>
                Open History
              </Button>
            </div>
          </div>
        </div>
      </Alert>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {finding.fixes.map((req) => (
        <Button key={req.fix} size="sm" onClick={() => void runFix(req.fix)}>
          {FIX_BUTTON_LABEL[req.fix]}
        </Button>
      ))}
    </div>
  )
}
