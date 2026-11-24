import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  History as HistoryIcon,
  Info,
  Layers,
  ShieldAlert,
  Undo2
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { FixOutcome, FixRefusal, JournalEntry, Progress } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { useNav } from '../nav.tsx'
import { groupHistoryEntries, type HistoryRow } from './history-groups.ts'
import { useOptionalApi } from './optional-api.ts'
import {
  LOAD_FAILED_COPY,
  UNEXPECTED_COPY,
  formatEntryTimestamp,
  formatStepSummary,
  progressCopy,
  refusalMessage
} from './words.ts'

export function HistoryScreen() {
  const api = useOptionalApi()
  const { go } = useNav()

  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusHeadingRef = useRef(false)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({})
  const [errorState, setErrorState] = useState<{
    entryId: string
    summary: string
    refusal: FixRefusal | 'unexpected' // 'unexpected': the call failed with an error
  } | null>(null)
  const [partWayMessage, setPartWayMessage] = useState<string | null>(null)
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null)

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const list = await api.invoke('journal:list')
      if (mountedRef.current) {
        setEntries(list)
        setLoadFailed(false)
      }
    } catch {
      // Keep what is on screen: a failed load must never look like an empty History.
      if (mountedRef.current) {
        setLoadFailed(true)
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // Try again goes away once the list loads, so keep keyboard focus on the page.
  useEffect(() => {
    if (loading || !focusHeadingRef.current) return
    focusHeadingRef.current = false
    const active = document.activeElement
    if (!active || active === document.body) {
      headingRef.current?.focus()
    }
  }, [loading, loadFailed])

  useEffect(() => {
    if (!api || !undoingId) {
      setProgress(null)
      return
    }
    return api.onProgress((p) => {
      if (mountedRef.current && (p.task === 'backup' || p.task === 'fix')) {
        setProgress(p)
      }
    })
  }, [api, undoingId])

  const rows = useMemo<HistoryRow[]>(() => groupHistoryEntries(entries), [entries])

  // The Undo button turns into a label, so keep keyboard focus on its row.
  useEffect(() => {
    if (!focusEntryId) return
    const active = document.activeElement
    if (!active || active === document.body) {
      document.getElementById(`history-entry-${focusEntryId}`)?.focus()
    }
    setFocusEntryId(null)
  }, [focusEntryId, entries])

  const handleUndo = useCallback(
    async (entry: JournalEntry) => {
      if (!api) return
      setErrorState(null)
      setPartWayMessage(null)
      setProgress(null)
      setUndoingId(entry.id)

      try {
        let outcome: FixOutcome
        try {
          outcome = await api.invoke('journal:undo', { entryId: entry.id })
        } catch {
          if (mountedRef.current) {
            setErrorState({ entryId: entry.id, summary: entry.summary, refusal: 'unexpected' })
          }
          return
        }
        if (!mountedRef.current) return

        if (outcome.status === 'done') {
          setEntries((prev) => prev.map((e) => (e.id === entry.id ? outcome.entry : e)))
          setFocusEntryId(entry.id)
          toast('Undone', { description: `Put everything back for: ${entry.summary}` })
          return
        }

        if (outcome.status === 'refused') {
          setErrorState({ entryId: entry.id, summary: entry.summary, refusal: outcome.refusal })
          return
        }

        setEntries((prev) => prev.map((e) => (e.id === entry.id ? outcome.entry : e)))
        setPartWayMessage(outcome.detail || 'Undo stopped partway through.')
      } finally {
        if (mountedRef.current) {
          setUndoingId(null)
        }
      }
    },
    [api]
  )

  const toggleSession = (sessionId: string) => {
    setExpandedSessions((prev) => ({ ...prev, [sessionId]: !prev[sessionId] }))
  }

  const renderEntryStatus = (entry: JournalEntry) => {
    if (entry.status === 'undone') {
      return (
        <Badge variant="secondary" className="text-muted-foreground">
          Undone
        </Badge>
      )
    }

    if (entry.undo === 'cannot-undo') {
      return (
        <span className="text-sm text-muted-foreground">Can&apos;t be undone</span>
      )
    }

    return (
      <div className="flex items-center gap-2">
        {(entry.status === 'needs-attention' || entry.status === 'in-progress') && (
          <Badge variant="warn">Needs attention</Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={undoingId !== null}
          onClick={() => void handleUndo(entry)}
        >
          <Undo2 className="size-4" aria-hidden="true" />
          {undoingId === entry.id ? 'Undoing…' : 'Undo'}
        </Button>
      </div>
    )
  }

  const progressText = progressCopy(progress)

  return (
    <main className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-foreground outline-none"
        >
          History
        </h1>
        <p className="text-[0.9375rem] text-muted-foreground">
          Every change made to your Mods folder or settings is saved here so you can put things back in one click.
        </p>
      </div>

      {undoingId && (
        <div
          aria-live="polite"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs"
        >
          <div className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
            <span>{progress ? progressText.heading : 'Putting files back…'}</span>
            {progressText.detail && (
              <span className="tabular-nums text-muted-foreground">{progressText.detail}</span>
            )}
          </div>
          <ProgressBar value={progressText.percent} aria-label="Undo progress" />
        </div>
      )}

      {errorState && (() => {
        const copy =
          errorState.refusal === 'unexpected' ? UNEXPECTED_COPY : refusalMessage(errorState.refusal)
        const variant =
          copy.tone === 'destructive' ? 'destructive' : copy.tone === 'info' ? 'info' : 'warn'
        const Icon =
          copy.tone === 'destructive' ? ShieldAlert : copy.tone === 'info' ? Info : AlertTriangle
        const targetEntry = entries.find((e) => e.id === errorState.entryId)
        return (
          <Alert variant={variant}>
            <div className="flex items-start gap-2.5">
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="flex flex-1 flex-col gap-2">
                <AlertTitle>{copy.title}</AlertTitle>
                <AlertDescription>{copy.detail}</AlertDescription>
                {copy.canRetry && targetEntry && (
                  <div>
                    <Button variant="outline" size="sm" onClick={() => void handleUndo(targetEntry)}>
                      Try again
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </Alert>
        )
      })()}

      {partWayMessage && (
        <Alert variant="warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <AlertTitle>Undo stopped partway through</AlertTitle>
              <AlertDescription>{partWayMessage}</AlertDescription>
            </div>
          </div>
        </Alert>
      )}

      {loadFailed && (
        <Alert variant="warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>{LOAD_FAILED_COPY.title}</AlertTitle>
              <AlertDescription>
                We could not read your list of changes. {LOAD_FAILED_COPY.detail}
              </AlertDescription>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => {
                    focusHeadingRef.current = true
                    void load()
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          </div>
        </Alert>
      )}

      {!loading && !loadFailed && rows.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HistoryIcon className="size-5 text-muted-foreground" aria-hidden="true" />
              No changes yet
            </CardTitle>
            <CardDescription>
              When you run a fix or set a mod aside, it will show up here with an Undo button.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              <Button variant="outline" onClick={() => go({ screen: 'check-up' })}>
                Go to Check-up
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <section aria-label="Change history" className="flex flex-col gap-3">
          {rows.map((row) => {
            if (row.kind === 'fix') {
              const { entry } = row
              return (
                <Card
                  key={entry.id}
                  id={`history-entry-${entry.id}`}
                  tabIndex={-1}
                  className="gap-0 px-4 py-3.5 outline-none"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-[0.9375rem] font-semibold text-foreground">
                        {entry.summary}
                      </span>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="size-3.5" aria-hidden="true" />
                          {formatEntryTimestamp(entry.at)}
                        </span>
                        <span>· {formatStepSummary(entry)}</span>
                        {entry.undo === 'cannot-undo' && (
                          <span>· Rebuilt automatically by the game</span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0">{renderEntryStatus(entry)}</div>
                  </div>
                </Card>
              )
            }

            const expanded = Boolean(expandedSessions[row.sessionId])
            const roundLabel = row.roundCount === 1 ? '1 round' : `${row.roundCount} rounds`
            const changeLabel =
              row.entries.length === 1 ? '1 change' : `${row.entries.length} changes`

            return (
              <Card key={`ff-${row.sessionId}`} className="gap-3 px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Layers className="size-4 text-primary" aria-hidden="true" />
                      <span className="text-[0.9375rem] font-semibold text-foreground">
                        50/50 test
                      </span>
                      <Badge variant="secondary" className="tabular-nums">
                        {roundLabel} · {changeLabel}
                      </Badge>
                      {row.allUndone && (
                        <Badge variant="secondary" className="text-muted-foreground">
                          Undone
                        </Badge>
                      )}
                      {row.needsAttention && <Badge variant="warn">Needs attention</Badge>}
                    </div>

                    <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3.5" aria-hidden="true" />
                        {formatEntryTimestamp(row.latestAt)}
                      </span>
                      {!row.allUndone && row.canUndoCount > 0 && (
                        <span>
                          · {row.canUndoCount} {row.canUndoCount === 1 ? 'mod' : 'mods'} still set aside
                        </span>
                      )}
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={expanded}
                    onClick={() => toggleSession(row.sessionId)}
                  >
                    {expanded ? (
                      <>
                        Hide details
                        <ChevronUp className="size-4" aria-hidden="true" />
                      </>
                    ) : (
                      <>
                        Show details
                        <ChevronDown className="size-4" aria-hidden="true" />
                      </>
                    )}
                  </Button>
                </div>

                {expanded && (
                  <>
                    <Separator />
                    <div className="flex flex-col gap-2.5">
                      {row.entries.map((entry) => (
                        <div
                          key={entry.id}
                          id={`history-entry-${entry.id}`}
                          tabIndex={-1}
                          className="flex flex-wrap items-center justify-between gap-2 text-sm outline-none"
                        >
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-foreground">{entry.summary}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {entry.origin.by === 'fifty-fifty' ? `Round ${entry.origin.round} · ` : ''}
                              {formatEntryTimestamp(entry.at)}
                            </span>
                          </div>
                          <div>{renderEntryStatus(entry)}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Card>
            )
          })}
        </section>
      )}
    </main>
  )
}
