import { AlertTriangle, CheckCircle2, Code2, Info, Package, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DisabledGroup, FixOutcome, FixRefusal, JournalEntry, Progress } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { useOptionalApi } from '../fixes/optional-api.ts'
import {
  LOAD_FAILED_COPY,
  UNEXPECTED_COPY,
  formatBytes,
  progressCopy,
  refusalMessage,
  setAsideRefusalMessage,
  type RefusalCopy
} from '../fixes/words.ts'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'

type ScriptStatus = 'in-mods' | 'set-aside' | 'needs-attention'
type BulkMode = 'set-aside' | 'put-back'

interface ScriptItem {
  groupId: string
  label: string
  status: ScriptStatus
  /** Who set it aside: only 'fix' can be put back from this screen. Null while it is still in Mods. */
  origin: DisabledGroup['origin'] | null
  fileCount: number | null
  bytes: number | null
  olderThanUpdate: boolean
}

interface BusyState {
  mode: BulkMode
  index: number
  total: number
  label: string
}

type Problem =
  | { kind: 'refused'; mode: BulkMode; label: string; refusal: FixRefusal; doneCount: number }
  | { kind: 'stopped'; mode: BulkMode; label: string; detail: string; doneCount: number }
  | { kind: 'unexpected'; mode: BulkMode; doneCount: number }

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count.toLocaleString()} ${many}`
}

function alreadyDoneNote(mode: BulkMode, doneCount: number): string | null {
  if (doneCount === 0) return null
  return mode === 'set-aside'
    ? `${plural(doneCount, 'script mod was', 'script mods were')} already set aside before this stopped. History can undo them anytime.`
    : `${plural(doneCount, 'script mod was', 'script mods were')} already put back before this stopped.`
}

export function PatchDayScreen() {
  const api = useOptionalApi()
  const { scan } = useSession()
  const { go } = useNav()

  const [disabled, setDisabled] = useState<DisabledGroup[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<BusyState | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [success, setSuccess] = useState<{ mode: BulkMode; count: number } | null>(null)

  const mountedRef = useRef(true)
  const busyRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const hasScan = scan !== null

  // Reads only. Nothing on this screen changes a file until she clicks a button.
  const load = useCallback(async () => {
    if (!api || !hasScan) {
      setLoading(false)
      return
    }
    try {
      // Each half is kept on its own: a failed load must never look like an empty list.
      const [list, journal] = await Promise.allSettled([api.invoke('groups:disabled'), api.invoke('journal:list')])
      if (!mountedRef.current) return
      if (list.status === 'fulfilled') setDisabled(list.value)
      if (journal.status === 'fulfilled') setEntries(journal.value)
      setLoadFailed(list.status === 'rejected' || journal.status === 'rejected')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api, hasScan])

  useEffect(() => {
    void load()
  }, [load])

  const isBusy = busy !== null
  useEffect(() => {
    if (!api || !isBusy) {
      setProgress(null)
      return
    }
    return api.onProgress((p) => {
      if (mountedRef.current && (p.task === 'backup' || p.task === 'fix')) setProgress(p)
    })
  }, [api, isBusy])

  const items = useMemo<ScriptItem[]>(() => {
    if (!scan) return []
    const folderPath = scan.folder.path
    const disabledById = new Map(disabled.map((d) => [d.groupId, d]))
    const entriesById = new Map(entries.map((e) => [e.id, e]))
    const stuckById = new Map<string, JournalEntry>()
    for (const entry of entries) {
      if (entry.action !== 'disable-group' || entry.groupId === null) continue
      if (entry.status !== 'needs-attention' && entry.status !== 'in-progress') continue
      if (!sameFolder(entry.folderPath, folderPath) || stuckById.has(entry.groupId)) continue
      stuckById.set(entry.groupId, entry)
    }

    const updatedAt = scan.facts.gameUpdatedAt ? Date.parse(scan.facts.gameUpdatedAt) : Number.NaN
    const newestByGroup = new Map<string, number>()
    for (const file of scan.inventory.files) {
      const at = Date.parse(file.modifiedAt)
      if (Number.isNaN(at)) continue
      newestByGroup.set(file.groupId, Math.max(newestByGroup.get(file.groupId) ?? at, at))
    }

    const result: ScriptItem[] = []
    const seen = new Set<string>()

    for (const group of scan.inventory.groups) {
      if (!group.hasScript) continue
      seen.add(group.id)
      const disabledEntry = disabledById.get(group.id) ?? null
      let newest = newestByGroup.get(group.id) ?? Number.NaN
      const cfAt = group.curseForge ? Date.parse(group.curseForge.fileDate) : Number.NaN
      if (!Number.isNaN(cfAt)) newest = Number.isNaN(newest) ? cfAt : Math.max(newest, cfAt)
      result.push({
        groupId: group.id,
        label: group.label,
        status: stuckById.has(group.id) ? 'needs-attention' : disabledEntry ? 'set-aside' : 'in-mods',
        origin: disabledEntry?.origin ?? null,
        fileCount: group.files.length,
        bytes: group.bytes,
        olderThanUpdate: !Number.isNaN(updatedAt) && !Number.isNaN(newest) && newest < updatedAt
      })
    }

    // Set aside after the last check-up: still listed here so she can put them back.
    for (const entry of disabled) {
      if (seen.has(entry.groupId)) continue
      const journalEntry = entriesById.get(entry.entryId)
      if (!journalEntry || !journalEntry.hasScript || !sameFolder(journalEntry.folderPath, folderPath)) continue
      seen.add(entry.groupId)
      result.push({
        groupId: entry.groupId,
        label: entry.label,
        status: stuckById.has(entry.groupId) ? 'needs-attention' : 'set-aside',
        origin: entry.origin,
        fileCount: null,
        bytes: null,
        olderThanUpdate: false
      })
    }

    for (const [groupId, entry] of stuckById) {
      if (seen.has(groupId) || !entry.hasScript) continue
      seen.add(groupId)
      result.push({
        groupId,
        label: entry.groupLabel ?? 'A script mod',
        status: 'needs-attention',
        origin: null,
        fileCount: null,
        bytes: null,
        olderThanUpdate: false
      })
    }

    return result.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }, [scan, disabled, entries])

  const inMods = items.filter((i) => i.status === 'in-mods')
  const setAside = items.filter((i) => i.status === 'set-aside')
  const canPutBack = setAside.filter((i) => i.origin === 'fix')
  const byFiftyFifty = setAside.filter((i) => i.origin === 'fifty-fifty')
  const needsAttention = items.filter((i) => i.status === 'needs-attention')

  const runAll = useCallback(
    async (mode: BulkMode, targets: ScriptItem[]) => {
      if (!api || busyRef.current || targets.length === 0) return
      busyRef.current = true
      setProblem(null)
      setSuccess(null)
      let doneCount = 0
      try {
        for (const [i, target] of targets.entries()) {
          if (!mountedRef.current) return
          setProgress(null)
          setBusy({ mode, index: i + 1, total: targets.length, label: target.label })
          let outcome: FixOutcome
          try {
            outcome = await api.invoke('fix:apply', {
              via: 'group',
              fix: mode === 'set-aside' ? 'disable-group' : 'enable-group',
              groupId: target.groupId
            })
          } catch {
            if (mountedRef.current) setProblem({ kind: 'unexpected', mode, doneCount })
            return
          }
          if (!mountedRef.current) return
          if (outcome.status === 'done') {
            doneCount++
            continue
          }
          if (outcome.status === 'refused') {
            setProblem({ kind: 'refused', mode, label: target.label, refusal: outcome.refusal, doneCount })
            return
          }
          setProblem({ kind: 'stopped', mode, label: target.label, detail: outcome.detail, doneCount })
          return
        }
        setSuccess({ mode, count: doneCount })
      } finally {
        busyRef.current = false
        if (mountedRef.current) {
          setBusy(null)
          await load()
        }
      }
    },
    [api, load]
  )

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Patch-day script check</h1>
      <p className="text-[0.9375rem] text-muted-foreground">
        After a Sims 4 update, set your script mods aside in one click, then update them in CurseForge when they are
        ready.
      </p>
    </div>
  )

  const safety = (
    <Card role="note" aria-label="Before you play" className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
          Before you play
        </CardTitle>
        <CardDescription>
          Script mods (files ending in .ts4script) hook into the game&apos;s own code, so they are usually the first
          things a game update breaks. Hair, clothes, furniture and other custom content usually keeps working just
          fine.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p className="font-semibold text-foreground">
          Do not save over your main household while mods are turned off or set aside. Test in a brand new save or exit
          without saving so your Sims keep their items.
        </p>
        <p className="text-muted-foreground">
          A safety copy is made before any mod moves, and every change can be undone from here or History.
        </p>
      </CardContent>
    </Card>
  )

  if (!scan) {
    return (
      <main className="flex flex-col gap-5">
        {header}
        {safety}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" aria-hidden="true" />
              A quick check-up comes first
            </CardTitle>
            <CardDescription>
              We need a quick, read-only check-up first to find your script mods. It only looks at your files and
              changes nothing.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={() => go({ screen: 'check-up' })}>Run a check-up</Button>
            <Button variant="ghost" onClick={() => go({ screen: 'what-happened' })}>
              Back
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  const progressText = progressCopy(progress)
  const summaryParts = [plural(inMods.length, 'script mod in Mods', 'script mods in Mods'), `${setAside.length} set aside`]
  if (needsAttention.length > 0) summaryParts.push(`${needsAttention.length} need attention`)

  const problemCopy: RefusalCopy | null = problem
    ? problem.kind === 'unexpected'
      ? UNEXPECTED_COPY
      : problem.kind === 'stopped'
        ? {
            title:
              problem.mode === 'set-aside'
                ? `Stopped partway while setting aside ${problem.label}`
                : `Stopped partway while putting ${problem.label} back`,
            detail: problem.detail || 'Open History to review or undo what moved.',
            canRetry: false,
            tone: 'warn'
          }
        : problem.mode === 'set-aside'
          ? setAsideRefusalMessage(problem.refusal, problem.label)
          : refusalMessage(problem.refusal)
    : null

  const setAsideDisabled = isBusy || loading || loadFailed || inMods.length === 0

  return (
    <main className="flex flex-col gap-5">
      {header}
      {safety}

      {loadFailed && (
        <Alert variant="warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>{LOAD_FAILED_COPY.title}</AlertTitle>
              <AlertDescription>
                We could not check which script mods are set aside. {LOAD_FAILED_COPY.detail}
              </AlertDescription>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || isBusy}
                  onClick={() => {
                    setLoading(true)
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

      {problem && problemCopy && (
        <Alert variant={problemCopy.tone === 'destructive' ? 'destructive' : problemCopy.tone === 'info' ? 'info' : 'warn'}>
          <div className="flex items-start gap-2.5">
            {problemCopy.tone === 'destructive' ? (
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : problemCopy.tone === 'info' ? (
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>{problemCopy.title}</AlertTitle>
              <AlertDescription>{problemCopy.detail}</AlertDescription>
              {alreadyDoneNote(problem.mode, problem.doneCount) && (
                <AlertDescription>{alreadyDoneNote(problem.mode, problem.doneCount)}</AlertDescription>
              )}
              {(problem.kind === 'stopped' || problem.doneCount > 0) && (
                <div>
                  <Button variant="outline" size="sm" onClick={() => go({ screen: 'history' })}>
                    Go to History
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Alert>
      )}

      {success && !isBusy && (
        <Alert variant="ok">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-1">
              <AlertTitle>
                {success.mode === 'set-aside'
                  ? `Set aside ${plural(success.count, 'script mod', 'script mods')}`
                  : `Put ${plural(success.count, 'script mod', 'script mods')} back in Mods`}
              </AlertTitle>
              <AlertDescription>
                {success.mode === 'set-aside'
                  ? 'You can open the game to test in a new save without saving over your main household, or update these mods in CurseForge first.'
                  : 'Your script mods are back in Mods. If the game acts up, you can set them aside again from here.'}
              </AlertDescription>
            </div>
          </div>
        </Alert>
      )}

      {busy && (
        <div
          aria-live="polite"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs"
        >
          <p className="text-sm font-semibold text-foreground">
            {busy.mode === 'set-aside'
              ? `Setting aside script mod ${busy.index} of ${busy.total}: ${busy.label}`
              : `Putting script mod ${busy.index} of ${busy.total} back: ${busy.label}`}
          </p>
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>{progressText.heading}</span>
            {progressText.detail && <span className="tabular-nums">{progressText.detail}</span>}
          </div>
          <ProgressBar value={progressText.percent} aria-label={progressText.heading} />
        </div>
      )}

      {!loading && !loadFailed && items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="size-5 text-muted-foreground" aria-hidden="true" />
              No script mods found
            </CardTitle>
            <CardDescription>
              No script mods were found in this Sims 4 folder, so there is nothing to set aside for patch day. Your
              custom content can stay right where it is.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => go({ screen: 'check-up' })}>
              Check-up
            </Button>
            <Button variant="outline" onClick={() => go({ screen: 'mods' })}>
              Your mods
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground tabular-nums" data-testid="patch-day-summary">
              {summaryParts.join(' · ')}
              {scan.game && ` · Game version ${scan.game.version}`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={setAsideDisabled} onClick={() => void runAll('set-aside', inMods)}>
                Set aside all script mods
              </Button>
              {canPutBack.length > 0 && (
                <Button
                  variant="outline"
                  disabled={isBusy || loading || loadFailed}
                  onClick={() => void runAll('put-back', canPutBack)}
                >
                  Put script mods back
                </Button>
              )}
            </div>
          </div>

          {byFiftyFifty.length > 0 && (
            <Alert variant="info">
              <div className="flex items-start gap-2.5">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="flex flex-1 flex-col gap-2">
                  <AlertDescription>
                    Some script mods were set aside by your 50/50 test. Finish or stop that test to put them back.
                  </AlertDescription>
                  <div>
                    <Button variant="outline" size="sm" onClick={() => go({ screen: 'fifty-fifty' })}>
                      Open 50/50 test
                    </Button>
                  </div>
                </div>
              </div>
            </Alert>
          )}

          <section aria-label="Script mods" className="flex flex-col gap-2.5">
            {items.map((item) => (
              <Card key={item.groupId} className="gap-0 px-4 py-3.5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[0.9375rem] font-semibold text-foreground">{item.label}</span>
                      <Badge variant="info">
                        <Code2 className="size-3.5" aria-hidden="true" />
                        Script mod
                      </Badge>
                      {item.status === 'in-mods' && <Badge variant="ok">In Mods</Badge>}
                      {item.status === 'set-aside' && (
                        <Badge variant="warn">
                          {item.origin === 'fifty-fifty' ? 'Set aside by 50/50 test' : 'Set aside'}
                        </Badge>
                      )}
                      {item.status === 'needs-attention' && <Badge variant="warn">Needs attention</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground tabular-nums">
                      {item.fileCount !== null && <span>{plural(item.fileCount, 'file', 'files')}</span>}
                      {item.bytes !== null && <span>· {formatBytes(item.bytes)}</span>}
                      {item.olderThanUpdate && <span>· Older than game update</span>}
                      {item.status === 'needs-attention' && (
                        <span>A change to this mod stopped partway. History can put it right.</span>
                      )}
                    </div>
                  </div>
                  {item.status === 'needs-attention' && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Open History for ${item.label}`}
                      onClick={() => go({ screen: 'history' })}
                    >
                      History
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </section>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => go({ screen: 'mods' })}>
          Open Your mods
        </Button>
        <Button variant="ghost" onClick={() => go({ screen: 'history' })}>
          Open History
        </Button>
        <Button variant="ghost" onClick={() => go({ screen: 'what-happened' })}>
          Back
        </Button>
      </div>
    </main>
  )
}
