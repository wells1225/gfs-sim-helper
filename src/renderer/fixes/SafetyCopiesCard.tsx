import { AlertTriangle, Info, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { BackupPruneResult, BackupSummary } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card } from '../components/ui/card.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { useOptionalApi } from './optional-api.ts'
import { formatBytes, formatEntryTimestamp } from './words.ts'

export interface SafetyCopiesCardProps {
  busy: boolean
  refreshKey: number
  onPruningChange?: (pruning: boolean) => void
}

interface PruneNotice {
  title: string
  detail: string
  variant: 'info' | 'warn'
}

function refusalNotice(why: Extract<BackupPruneResult, { status: 'refused' }>['why']): PruneNotice {
  switch (why) {
    case 'busy':
      return {
        title: 'A safety copy is running right now',
        detail: 'Wait a moment for the current safety copy or change to finish, then try again.',
        variant: 'info'
      }
    case 'fifty-fifty-running':
      return {
        title: 'A 50/50 test is in progress',
        detail: 'Finish or stop your 50/50 test before clearing old safety copies.',
        variant: 'warn'
      }
    case 'unsafe-state':
      return {
        title: 'Could not safely clear copies right now',
        detail: 'Some backup records could not be checked cleanly, so nothing was removed. Your saves and mods were not touched.',
        variant: 'warn'
      }
    case 'nothing-to-prune':
      return {
        title: 'Nothing left to clear',
        detail: 'Only your newest safety copies and files needed for Undo are kept right now.',
        variant: 'info'
      }
  }
}

const PRUNE_FAILED_NOTICE: PruneNotice = {
  title: 'Could not finish clearing old copies',
  detail: 'Sims Helper stopped to be safe. Your newest safety copies, saves, and mods are safe. Try again in a moment.',
  variant: 'warn'
}

function statusCopy(summary: BackupSummary): string {
  switch (summary.status.state) {
    case 'verified':
    case 'stale':
      return `Last verified safety copy · ${formatEntryTimestamp(summary.status.at)}`
    case 'none':
      return 'No safety copy taken yet'
    case 'unknown':
      return 'Could not check your latest safety copy'
  }
}

function reclaimableCopy(summary: BackupSummary): string {
  if (summary.reclaimableBackups > 0) {
    const noun = summary.reclaimableBackups === 1 ? 'copy' : 'copies'
    return `Free ${formatBytes(summary.reclaimableBytes)} from ${summary.reclaimableBackups.toLocaleString()} older safety ${noun}`
  }
  return `Free ${formatBytes(summary.reclaimableBytes)} from older safety files`
}

export function SafetyCopiesCard({ busy, refreshKey, onPruningChange }: SafetyCopiesCardProps) {
  const api = useOptionalApi()
  const [summary, setSummary] = useState<BackupSummary | null>(null)
  const [summaryUnavailable, setSummaryUnavailable] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [notice, setNotice] = useState<PruneNotice | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadSummary = useCallback(async () => {
    if (!api) return
    try {
      const next = await api.invoke('backup:summary')
      if (mountedRef.current && next && typeof next === 'object' && 'status' in next) {
        setSummary(next)
        setSummaryUnavailable(false)
      }
    } catch {
      if (mountedRef.current) {
        setSummaryUnavailable(true)
      }
    }
  }, [api])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary, refreshKey])

  if (!api) return null

  if (summary === null) {
    if (!summaryUnavailable) return null
    return (
      <Card className="gap-1.5 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
          <span className="text-[0.9375rem] font-semibold text-foreground">Safety copies</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Could not read safety copy details right now. Your changes below can still be undone.
        </p>
      </Card>
    )
  }

  const canShowPrune = summary.canPrune && (summary.reclaimableBytes > 0 || summary.reclaimableBackups > 0)
  const copiesLabel =
    summary.verifiedCount === 1
      ? '1 verified copy kept'
      : `${summary.verifiedCount.toLocaleString()} verified copies kept`

  const handlePrune = async () => {
    if (!api || busy || pruning) return
    setNotice(null)
    setPruning(true)
    onPruningChange?.(true)
    try {
      let result: BackupPruneResult
      try {
        result = await api.invoke('backup:prune')
      } catch {
        if (mountedRef.current) {
          setConfirming(false)
          setNotice(PRUNE_FAILED_NOTICE)
          void loadSummary()
        }
        return
      }
      if (!mountedRef.current) return

      setConfirming(false)
      if (result.status === 'done') {
        setSummary(result.summary)
        setSummaryUnavailable(false)
        const noun = result.removedBackups === 1 ? '1 older safety copy' : `${result.removedBackups.toLocaleString()} older safety copies`
        const description =
          result.removedBackups > 0
            ? `Freed ${formatBytes(result.freedBytes)} from ${noun}.`
            : `Freed ${formatBytes(result.freedBytes)} of older safety files.`
        toast('Cleared old safety copies', { description })
        return
      }

      if (result.status === 'refused') {
        setNotice(refusalNotice(result.why))
        void loadSummary()
        return
      }

      setNotice(PRUNE_FAILED_NOTICE)
      void loadSummary()
    } finally {
      if (mountedRef.current) {
        setPruning(false)
      }
      onPruningChange?.(false)
    }
  }

  const NoticeIcon = notice?.variant === 'info' ? Info : AlertTriangle

  return (
    <div className="flex flex-col gap-3">
      <Card className="gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              <span className="text-[0.9375rem] font-semibold text-foreground">Safety copies</span>
            </div>
            {summary.status.state === 'none' ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
                <span>{statusCopy(summary)}</span>
                <span>· {copiesLabel}</span>
                <span>· {formatBytes(summary.totalBytes)} used</span>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 text-sm text-muted-foreground tabular-nums">
                <span>{statusCopy(summary)}</span>
                <span>
                  {copiesLabel} · {formatBytes(summary.totalBytes)} used
                </span>
              </div>
            )}
            {canShowPrune && (
              <span className="text-sm font-medium text-foreground/80 tabular-nums">{reclaimableCopy(summary)}</span>
            )}
          </div>

          {canShowPrune && !confirming && (
            <div className="shrink-0">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || pruning}
                onClick={() => {
                  setNotice(null)
                  setConfirming(true)
                }}
              >
                Clear old safety copies
              </Button>
            </div>
          )}
        </div>

        {canShowPrune && confirming && (
          <>
            <Separator />
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Keeps your newest safety copies and everything needed for Undo. Your saves and mods are not touched.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="default" size="sm" disabled={busy || pruning} onClick={() => void handlePrune()}>
                  {pruning ? 'Clearing old copies…' : 'Clear old copies'}
                </Button>
                <Button variant="ghost" size="sm" disabled={pruning} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {notice && (
        <Alert variant={notice.variant}>
          <div className="flex items-start gap-2.5">
            <NoticeIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.detail}</AlertDescription>
            </div>
          </div>
        </Alert>
      )}
    </div>
  )
}
