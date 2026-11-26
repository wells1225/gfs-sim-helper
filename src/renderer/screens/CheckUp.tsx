import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Gamepad2,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Finding, Progress, Severity, Symptom } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { AskEntry } from '../assist/AskEntry.tsx'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { FiftyEntry } from '../fiftyfifty/FiftyEntry.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { ChangesCard } from './ChangesCard.tsx'
import { FindingCard } from './FindingCard.tsx'

const SEVERITY_ORDER: readonly {
  severity: Severity
  heading: string
  icon: LucideIcon
  iconColor: string
}[] = [
  { severity: 'stop', heading: 'Do this first', icon: ShieldAlert, iconColor: 'text-severity-stop' },
  { severity: 'warn', heading: 'Worth fixing', icon: AlertTriangle, iconColor: 'text-severity-warn' },
  { severity: 'info', heading: 'Good to know', icon: Info, iconColor: 'text-severity-info' }
]

const SCAN_STAGES: readonly { id: 'counting' | 'mods' | 'logs' | 'rules'; label: string }[] = [
  { id: 'counting', label: 'Counting files in your mods folder' },
  { id: 'mods', label: 'Checking your mods' },
  { id: 'logs', label: 'Reading crash logs' },
  { id: 'rules', label: 'Putting your check-up together' }
]

function stageIndex(stage: Progress['stage'] | null): number {
  if (!stage || stage === 'counting') return 0
  if (stage === 'mods') return 1
  if (stage === 'logs') return 2
  return 3
}

function progressLabel(progress: Progress | null): string {
  if (!progress || progress.stage === 'counting') {
    return 'Counting files…'
  }
  if (progress.stage === 'mods') {
    if (progress.total !== null && progress.total > 0) {
      return `Checking mod ${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')}`
    }
    return 'Checking your mods…'
  }
  if (progress.stage === 'logs') {
    return 'Reading crash and last exception logs…'
  }
  return 'Putting your check-up together…'
}

function progressValue(progress: Progress | null): number | null {
  if (!progress || progress.stage === 'counting') return null
  if (progress.stage === 'mods') {
    if (progress.total !== null && progress.total > 0) {
      return Math.round((progress.done / progress.total) * 100)
    }
    return null
  }
  if (progress.stage === 'logs') return null
  return 95
}

/** The all-clear subtext, fitted to what she said happened. */
function healthySubtext(symptom: Symptom): string {
  if (symptom === 'wont-load') {
    return 'If your game still will not open, a recent game update may be the reason. You can try Repair in the EA app, or send a report to Tyler so he can take a closer look.'
  }
  if (symptom === 'freezes') {
    return 'If your game still freezes or gets stuck, you can try the 50/50 test or send a report to Tyler so he can take a closer look.'
  }
  if (symptom === 'one-save-or-lot') {
    return 'If one save or lot still has trouble, sending a report to Tyler is the easiest next step so he can take a closer look.'
  }
  return 'If your game is still crashing, you can try the 50/50 test or send a report to Tyler so he can take a closer look.'
}

function verdictSummary(
  findings: Finding[],
  symptom: Symptom
): {
  variant: 'destructive' | 'warn' | 'info' | 'ok'
  icon: LucideIcon
  headline: string
  subtext: string
} {
  const stopCount = findings.filter((f) => f.severity === 'stop').length
  const warnCount = findings.filter((f) => f.severity === 'warn').length
  const infoCount = findings.filter((f) => f.severity === 'info').length

  if (stopCount > 0) {
    const firstPart = stopCount === 1 ? 'Found 1 thing to do first' : `Found ${stopCount} things to do first`
    const extra = warnCount > 0 ? `, plus ${warnCount} more worth fixing` : ''
    return {
      variant: 'destructive',
      icon: ShieldAlert,
      headline: `${firstPart}${extra}`,
      subtext: 'Start with the top card below before you play or save your game.'
    }
  }

  if (warnCount > 0) {
    return {
      variant: 'warn',
      icon: AlertTriangle,
      headline: warnCount === 1 ? 'Found 1 thing worth fixing' : `Found ${warnCount} things worth fixing`,
      subtext: 'These could be why your game has been acting up. Start with the first one.'
    }
  }

  if (infoCount > 0) {
    return {
      variant: 'info',
      icon: Info,
      headline: 'No urgent mod problems found, plus a few helpful notes',
      subtext: 'Nothing looks broken right away, though a quick cleanup below may still help.'
    }
  }

  return {
    variant: 'ok',
    icon: CheckCircle2,
    headline: "Your mods folder looks healthy. We didn't spot any obvious problems.",
    subtext: healthySubtext(symptom)
  }
}

export function CheckUp() {
  const api = useApi()
  const { go } = useNav()
  const { scan, setScan, symptom } = useSession()

  const [progress, setProgress] = useState<Progress | null>(null)
  const [scanError, setScanError] = useState<{ why: string; detail: string } | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (scan !== null) return

    let cancelled = false
    setScanError(null)
    setProgress({ task: 'scan', stage: 'counting', done: 0, total: null })

    const unsubscribe = api.onProgress((next) => {
      if (!cancelled && next.task === 'scan') {
        setProgress(next)
      }
    })

    async function run() {
      try {
        const settings = await api.invoke('settings:get')
        if (cancelled) return

        let folderPath = settings.folderPath
        if (!folderPath) {
          const located = await api.invoke('locate:run')
          if (cancelled) return

          if (located.folders.length === 0 || located.folders.length > 1) {
            go({ screen: 'pick-folder' })
            return
          }
          folderPath = located.folders[0]!.path
        }

        const result = await api.invoke('scan:run', { folderPath, symptom })
        if (cancelled) return

        if (result.status === 'done') {
          setScan(result.scan)
        } else {
          setScanError({ why: result.why, detail: result.detail })
        }
      } catch (err) {
        if (!cancelled) {
          setScanError({
            why: 'unexpected',
            detail: err instanceof Error ? err.message : 'Something went wrong while running the check-up.'
          })
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api, go, retryCount, scan, setScan, symptom])

  if (scanError) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 py-6">
        <Card className="p-6">
          <CardHeader>
            <CardTitle>We couldn&apos;t finish the check-up</CardTitle>
          </CardHeader>
          <CardContent className="gap-3">
            <p className="text-foreground/90">
              {scanError.why === 'folder-not-found'
                ? "We couldn't find the Sims 4 folder you picked earlier. It may have moved or OneDrive may be paused."
                : 'Something unexpected interrupted the scan. Nothing in your game folder was changed.'}
            </p>
            <p className="text-sm text-muted-foreground">
              You can try again. If it keeps happening, tell Tyler and show him the technical details below.
            </p>
            <Accordion type="single" collapsible>
              <AccordionItem value="technical-details" className="border-t border-border border-b-0">
                <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground">
                  Technical details
                </AccordionTrigger>
                <AccordionContent>
                  <p className="break-all rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs text-foreground/90">
                    {scanError.detail}
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
          <CardFooter className="gap-2">
            <Button onClick={() => setRetryCount((n) => n + 1)}>
              <RefreshCw className="size-4" strokeWidth={1.75} />
              Try again
            </Button>
            {scanError.why === 'folder-not-found' && (
              <Button variant="outline" onClick={() => go({ screen: 'pick-folder' })}>
                <FolderOpen className="size-4" strokeWidth={1.75} />
                Pick another folder
              </Button>
            )}
          </CardFooter>
        </Card>
      </main>
    )
  }

  if (scan === null) {
    const activeStage = stageIndex(progress?.stage ?? null)
    const pct = progressValue(progress)

    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 py-6">
        <p role="status" className="sr-only">
          {SCAN_STAGES[activeStage]?.label}
        </p>
        <Card className="gap-5 p-6">
          <CardHeader className="items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <Search className="size-6" strokeWidth={1.75} />
            </div>
            <div className="flex flex-col gap-1">
              <CardTitle className="text-xl">Checking your Sims 4 folder</CardTitle>
              <p className="text-base font-medium text-primary tabular-nums">{progressLabel(progress)}</p>
            </div>
          </CardHeader>

          <CardContent className="gap-5">
            <div className="flex flex-col gap-1.5">
              <ProgressBar value={pct} aria-label="Check-up progress" />
              {pct !== null && (
                <p className="text-right text-xs text-muted-foreground tabular-nums">{pct}%</p>
              )}
            </div>

            <ol className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
              {SCAN_STAGES.map((stage, idx) => {
                const isDone = idx < activeStage
                const isActive = idx === activeStage
                return (
                  <li
                    key={stage.id}
                    className={`flex items-center gap-2.5 ${
                      isDone || isActive ? 'font-medium text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
                    ) : isActive ? (
                      <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" strokeWidth={1.75} />
                    ) : (
                      <span className="size-4 shrink-0 rounded-full border border-border" aria-hidden="true" />
                    )}
                    <span>{stage.label}</span>
                  </li>
                )
              })}
            </ol>

            <p className="text-center text-sm text-muted-foreground">
              Reading files only. Nothing in your game folder is being changed.
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  const verdict = verdictSummary(scan.findings, scan.symptom)
  const oneSave = scan.symptom === 'one-save-or-lot'
  const VerdictIcon = verdict.icon
  const groupedFindings = SEVERITY_ORDER.map((group) => ({
    ...group,
    items: scan.findings.filter((f) => f.severity === group.severity)
  })).filter((group) => group.items.length > 0)
  const sendCard = <SendCard onSend={() => go({ screen: 'send-to-tyler' })} />

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 py-1">
      {scan.gameRunning === 'running' && (
        <Alert variant="info">
          <div className="flex items-start gap-2.5">
            <Gamepad2 className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} />
            <div className="flex flex-col gap-0.5">
              <AlertTitle>The Sims 4 is open right now. Looking is completely safe.</AlertTitle>
              <AlertDescription>
                This check-up only reads files and changes nothing. If you want to fix anything later, we&apos;ll ask
                you to close the game first.
              </AlertDescription>
            </div>
          </div>
        </Alert>
      )}

      <Alert variant={verdict.variant} className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <VerdictIcon className="mt-0.5 size-6 shrink-0" strokeWidth={1.75} />
            <div className="flex flex-col gap-1">
              <h1 className="text-lg font-bold leading-snug">{verdict.headline}</h1>
              <p className="text-sm opacity-95">{verdict.subtext}</p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="shrink-0 bg-card text-foreground"
            onClick={() => setScan(null)}
          >
            <RefreshCw className="size-4" strokeWidth={1.75} />
            Check again
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs opacity-90 tabular-nums">
          <span>
            {scan.inventory.files.length.toLocaleString('en-US')}{' '}
            {scan.inventory.files.length === 1 ? 'mod file checked' : 'mod files checked'}
          </span>
          <span>·</span>
          <span>
            {scan.logs.length.toLocaleString('en-US')}{' '}
            {scan.logs.length === 1 ? 'crash log read' : 'crash logs read'}
          </span>
          {scan.game && (
            <>
              <span>·</span>
              <span>Game {scan.game.version}</span>
            </>
          )}
        </div>
      </Alert>

      <ChangesCard changes={scan.changes} />

      {groupedFindings.map((group) => {
        const GroupIcon = group.icon
        return (
          <section key={group.severity} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <GroupIcon className={`size-5 ${group.iconColor}`} strokeWidth={1.75} />
              <h2 className="text-base font-bold tracking-tight text-foreground">{group.heading}</h2>
              <Badge variant="secondary" className="tabular-nums">
                {group.items.length}
              </Badge>
            </div>

            <div className="flex flex-col gap-3">
              {group.items.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </div>
          </section>
        )
      })}

      <div className="flex flex-col gap-3 pt-1">
        {oneSave && (
          <Alert variant="info">
            <div className="flex items-start gap-2.5">
              <Info className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden />
              <div className="flex flex-col gap-0.5">
                <AlertTitle>When the trouble is in one save or lot</AlertTitle>
                <AlertDescription>
                  The 50/50 test plays in a brand new test household, so a problem that only happens on one save or lot
                  may never show up there. Sending a report to Tyler is the easiest first step.
                </AlertDescription>
              </div>
            </div>
          </Alert>
        )}
        {oneSave && sendCard}
        <FiftyEntry scan={scan} />
        <AskEntry scan={scan} />
        {!oneSave && sendCard}
      </div>
    </main>
  )
}

function SendCard({ onSend }: { onSend(): void }) {
  return (
    <Card className="flex-col gap-4 bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">Want Tyler to take a look?</h3>
        <p className="text-sm text-muted-foreground">
          Save one clean report zip to your Desktop with your crash logs and mod list (never your saves).
        </p>
      </div>
      <Button className="shrink-0" onClick={onSend}>
        <Send className="size-4" strokeWidth={1.75} />
        Send to Tyler
      </Button>
    </Card>
  )
}
