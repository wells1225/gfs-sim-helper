import { AlertTriangle, CheckCircle2, Info, RotateCcw, ShieldAlert, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Finding, FixId, FixOutcome, FixRefusal, JournalEntry, Progress } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { FIX_BUTTON_LABEL, UNEXPECTED_COPY, progressCopy, refusalMessage, type RefusalCopy } from './words.ts'

/**
 * What "Try again" repeats: the fix itself, or the undo of one entry. `neverRan` marks an undo from a stopped card
 * where no step ran: only then does nothing-to-do mean the fix can simply be offered again.
 */
type Retry = { kind: 'fix'; fix: FixId } | { kind: 'undo'; entryId: string; summary: string; neverRan: boolean }

type ActionState =
  | { phase: 'idle' }
  | { phase: 'running'; fix: FixId }
  | { phase: 'done'; entry: JournalEntry; undone: boolean }
  | { phase: 'refused'; retry: Retry; refusal: FixRefusal }
  | { phase: 'error'; retry: Retry }
  | { phase: 'stopped-part-way'; entry: JournalEntry; detail: string }

function announcement(state: ActionState, undoBusy: boolean): string {
  if (undoBusy) return 'Putting files back'
  switch (state.phase) {
    case 'running':
      return 'Making a safety copy first'
    case 'done':
      return state.undone ? 'Undo finished. Everything is back the way it was.' : `Done: ${state.entry.summary}`
    case 'stopped-part-way':
      return 'This fix stopped partway through'
    default:
      return ''
  }
}

export function FindingActions({ finding }: { finding: Finding }) {
  const api = useApi()
  const { go } = useNav()
  const { setScan } = useSession()

  const [state, setState] = useState<ActionState>({ phase: 'idle' })
  const [progress, setProgress] = useState<Progress | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const mountedRef = useRef(true)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isRunning = state.phase === 'running' || undoBusy

  // The clicked button goes away when the card changes, so keep keyboard focus on the card. A quiet return to idle
  // after undo needs nothing here: the busy step before it already moved focus to the card, which stays.
  useEffect(() => {
    if (state.phase === 'idle') return
    const active = document.activeElement
    if (!active || active === document.body) {
      cardRef.current?.focus()
    }
  }, [state, undoBusy])

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
    async (entryId: string, originalSummary: string, neverRan = false) => {
      setUndoBusy(true)
      const retry: Retry = { kind: 'undo', entryId, summary: originalSummary, neverRan }
      let outcome: FixOutcome
      try {
        outcome = await api.invoke('journal:undo', { entryId })
      } catch {
        if (mountedRef.current) {
          setState({ phase: 'error', retry })
        } else {
          toast.warning(UNEXPECTED_COPY.title, {
            description: UNEXPECTED_COPY.detail
          })
        }
        return
      } finally {
        if (mountedRef.current) {
          setUndoBusy(false)
        }
      }

      if (outcome.status === 'done') {
        toast('Undone', {
          description: `Put everything back for: ${originalSummary}`
        })
        if (mountedRef.current) setState({ phase: 'done', entry: outcome.entry, undone: true })
        return
      }
      if (outcome.status === 'refused') {
        // A stopped fix that never changed anything is dropped on undo: return to idle with no error and no toast.
        const dropped = outcome.refusal.why === 'out-of-date' && outcome.refusal.detail === 'nothing-to-do'
        if (dropped && neverRan) {
          if (mountedRef.current) setState({ phase: 'idle' })
          return
        }
        if (mountedRef.current) {
          setState({ phase: 'refused', retry, refusal: outcome.refusal })
        } else {
          // The card is gone (Undo came from the toast after she left the screen), so tell her here.
          const copy = refusalMessage(outcome.refusal)
          toast.warning(copy.title, { description: copy.detail })
        }
        return
      }
      if (mountedRef.current) {
        setState({
          phase: 'stopped-part-way',
          entry: outcome.entry,
          detail: outcome.detail
        })
      } else {
        toast.warning('Undo stopped partway through', {
          description: 'Open History to see what moved.'
        })
      }
    },
    [api]
  )

  const runFix = useCallback(
    async (fix: FixId) => {
      setProgress(null)
      setState({ phase: 'running', fix })
      let outcome: FixOutcome
      try {
        outcome = await api.invoke('fix:apply', {
          via: 'finding',
          findingId: finding.id,
          fix
        })
      } catch {
        if (mountedRef.current) setState({ phase: 'error', retry: { kind: 'fix', fix } })
        return
      }
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
        setState({
          phase: 'refused',
          retry: { kind: 'fix', fix },
          refusal: outcome.refusal
        })
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

  const retry = useCallback(
    (target: Retry) => {
      if (target.kind === 'fix') void runFix(target.fix)
      else void handleUndo(target.entryId, target.summary, target.neverRan)
    },
    [handleUndo, runFix]
  )

  if (finding.fixes.length === 0) {
    return null
  }

  return (
    <div ref={cardRef} tabIndex={-1} className="outline-none">
      <p role="status" className="sr-only">
        {announcement(state, undoBusy)}
      </p>
      {renderBody()}
    </div>
  )

  function renderNotice(copy: RefusalCopy, target: Retry, showCheckAgain: boolean) {
    const variant = copy.tone === 'destructive' ? 'destructive' : copy.tone === 'info' ? 'info' : 'warn'
    const Icon = copy.tone === 'destructive' ? ShieldAlert : copy.tone === 'info' ? Info : AlertTriangle
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
                  <Button variant="outline" size="sm" onClick={() => retry(target)}>
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

  function renderBody() {
    if (state.phase === 'running' || undoBusy) {
      const copy = progressCopy(progress)
      return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 px-3.5 py-3">
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-severity-ok-border bg-severity-ok-bg px-3.5 py-2.5 text-severity-ok">
          <div className="flex items-center gap-2 text-[0.9375rem] font-medium">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            <span>{state.undone ? 'Undone. Put back the way it was.' : state.entry.summary}</span>
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
      const showCheckAgain = state.refusal.why === 'out-of-date' && state.refusal.detail !== 'nothing-to-do'
      return renderNotice(refusalMessage(state.refusal), state.retry, showCheckAgain)
    }

    if (state.phase === 'error') {
      return renderNotice(UNEXPECTED_COPY, state.retry, false)
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
                    onClick={() =>
                      void handleUndo(
                        state.entry.id,
                        state.entry.summary,
                        state.entry.steps.every((s) => s.state === 'pending')
                      )
                    }
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
}
