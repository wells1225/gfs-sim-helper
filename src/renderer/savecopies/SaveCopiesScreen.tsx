import {
  AlertTriangle,
  ArchiveRestore,
  ArrowLeft,
  CheckCircle2,
  Copy,
  FolderClock,
  Info,
  Loader2,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SaveCopy, SaveCopyFile, SaveCopyMade, SavePutBack } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { useOptionalApi } from '../fixes/optional-api.ts'
import { formatBytes } from '../fixes/words.ts'
import {
  BROKEN_COPY,
  PUT_BACK_DONE,
  REASON_LABEL,
  formatWhen,
  makeRefusalWords,
  plural,
  putBackRefusalWords,
  type Words
} from './words.ts'

/** A save she put back while the app was open. Put back has no journal entry, so this screen shows the record. */
export interface PutBackRecord {
  newSlot: string
  copyAt: string
  savedAt: string
  at: string
}

// Kept for as long as the app is open, so leaving the screen and coming back still shows what was put back.
const putBacksThisSession: PutBackRecord[] = []

/** Tests only: forget the put backs of earlier tests. */
export function resetPutBacksForTests(): void {
  putBacksThisSession.length = 0
}

type Notice =
  | { kind: 'made'; copy: SaveCopy }
  | { kind: 'make-refused'; why: Extract<SaveCopyMade, { kind: 'refused' }>['why'] }
  | { kind: 'put-back-done'; newSlot: string }
  | { kind: 'put-back-refused'; why: Extract<SavePutBack, { kind: 'refused' }>['why'] }
  | { kind: 'unexpected' }

function ProblemAlert({ words }: { words: Words }) {
  const Icon = words.tone === 'destructive' ? ShieldAlert : words.tone === 'info' ? Info : AlertTriangle
  return (
    <Alert variant={words.tone}>
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-1">
          <AlertTitle>{words.title}</AlertTitle>
          <AlertDescription>{words.detail}</AlertDescription>
        </div>
      </div>
    </Alert>
  )
}

function NoticeView({ notice }: { notice: Notice }) {
  if (notice.kind === 'made') {
    if (notice.copy.status === 'broken') {
      return (
        <ProblemAlert
          words={{
            title: 'A copy was made, but it did not check out',
            detail: `${BROKEN_COPY} This can happen when a save changes while it is copied. Make sure the game is closed and try again.`,
            tone: 'warn'
          }}
        />
      )
    }
    return (
      <Alert variant="ok">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-1">
            <AlertTitle>Copy made and checked</AlertTitle>
            <AlertDescription>
              {plural(notice.copy.saves.length, 'save', 'saves')} and your households are safe in it.
            </AlertDescription>
          </div>
        </div>
      </Alert>
    )
  }
  if (notice.kind === 'put-back-done') {
    return (
      <Alert variant="ok">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-1">
            <AlertTitle>Your save is back</AlertTitle>
            <AlertDescription>{PUT_BACK_DONE}</AlertDescription>
            <AlertDescription className="text-sm opacity-80">Added as file {notice.newSlot}</AlertDescription>
          </div>
        </div>
      </Alert>
    )
  }
  if (notice.kind === 'make-refused') return <ProblemAlert words={makeRefusalWords(notice.why)} />
  if (notice.kind === 'put-back-refused') return <ProblemAlert words={putBackRefusalWords(notice.why)} />
  return (
    <ProblemAlert
      words={{
        title: 'Something went wrong',
        detail: 'Nothing of yours was changed. Try again in a moment.',
        tone: 'warn'
      }}
    />
  )
}

function CopyCard({ copy, busy, onPick }: { copy: SaveCopy; busy: boolean; onPick: () => void }) {
  const broken = copy.status === 'broken'
  return (
    <Card className="gap-3" data-testid="save-copy">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FolderClock className="size-5 text-primary" aria-hidden="true" />
          {formatWhen(copy.at)}
          <Badge variant="secondary">{REASON_LABEL[copy.reason]}</Badge>
          {broken ? (
            <Badge variant="destructive">Didn&apos;t check out</Badge>
          ) : (
            <Badge variant="ok">Checked</Badge>
          )}
        </CardTitle>
        <CardDescription className="tabular-nums">
          {plural(copy.saves.length, 'save', 'saves')} · {plural(copy.trayFiles, 'household file', 'household files')}{' '}
          · {formatBytes(copy.bytes)}
          {copy.gameVersion !== null && ` · Game version ${copy.gameVersion}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {broken ? (
          <p className="flex items-start gap-2 text-sm text-severity-stop">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {BROKEN_COPY}
          </p>
        ) : (
          <div>
            <Button variant="outline" disabled={busy || copy.saves.length === 0} onClick={onPick}>
              <ArchiveRestore aria-hidden="true" />
              Put a save back
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SaveRow({
  save,
  busy,
  working,
  onPutBack
}: {
  save: SaveCopyFile
  busy: boolean
  working: boolean
  onPutBack: () => void
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-col">
        <span className="font-semibold text-foreground">Saved {formatWhen(save.savedAt)}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{formatBytes(save.bytes)}</span>
      </div>
      <Button disabled={busy} onClick={onPutBack}>
        {working ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
        {working ? 'Putting it back…' : 'Put this one back'}
      </Button>
    </li>
  )
}

export function SaveCopiesScreen() {
  const api = useOptionalApi()
  const [copies, setCopies] = useState<SaveCopy[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [making, setMaking] = useState(false)
  const [picking, setPicking] = useState<SaveCopy | null>(null)
  const [puttingBack, setPuttingBack] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [putBacks, setPutBacks] = useState<PutBackRecord[]>(() => [...putBacksThisSession])
  const mounted = useRef(true)
  const busyRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Reads only. Nothing here changes a file until she clicks.
  const load = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }
    try {
      const list = await api.invoke('savecopies:list')
      if (!mounted.current) return
      setCopies(list)
      setLoadFailed(false)
    } catch {
      if (mounted.current) setLoadFailed(true)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const busy = making || puttingBack !== null

  const makeCopy = useCallback(async () => {
    if (!api || busyRef.current) return
    busyRef.current = true
    setMaking(true)
    setNotice(null)
    try {
      const made = await api.invoke('savecopies:make', { reason: 'by-hand' })
      if (!mounted.current) return
      setNotice(made.kind === 'done' ? { kind: 'made', copy: made.copy } : { kind: 'make-refused', why: made.why })
      await load()
    } catch {
      if (mounted.current) setNotice({ kind: 'unexpected' })
    } finally {
      busyRef.current = false
      if (mounted.current) setMaking(false)
    }
  }, [api, load])

  const putBack = useCallback(
    async (copy: SaveCopy, save: SaveCopyFile) => {
      if (!api || busyRef.current) return
      busyRef.current = true
      setPuttingBack(save.name)
      setNotice(null)
      try {
        const answer = await api.invoke('savecopies:put-back', { copyId: copy.id, save: save.name })
        if (!mounted.current) return
        if (answer.kind === 'done') {
          putBacksThisSession.unshift({
            newSlot: answer.newSlot,
            copyAt: copy.at,
            savedAt: save.savedAt,
            at: new Date().toISOString()
          })
          setPutBacks([...putBacksThisSession])
          setPicking(null)
          setNotice({ kind: 'put-back-done', newSlot: answer.newSlot })
        } else {
          setNotice({ kind: 'put-back-refused', why: answer.why })
        }
      } catch {
        if (mounted.current) setNotice({ kind: 'unexpected' })
      } finally {
        busyRef.current = false
        if (mounted.current) setPuttingBack(null)
      }
    },
    [api]
  )

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Save copies</h1>
      <p className="text-[0.9375rem] text-muted-foreground">
        Sims Helper keeps dated copies of your saves and households. Putting one back adds it as a new save. It never
        replaces one of yours.
      </p>
    </div>
  )

  const makingStatus = making && (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs"
    >
      <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold text-foreground">Making a copy of your saves…</p>
        <p className="text-sm text-muted-foreground">
          This can take a minute. Keep The Sims 4 closed until it&apos;s done.
        </p>
      </div>
    </div>
  )

  const history = putBacks.length > 0 && (
    <Card className="gap-3" role="region" aria-label="Saves you put back">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
          Saves you put back
        </CardTitle>
        <CardDescription>Each one was added as a new save. Nothing was replaced.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5 text-sm">
          {putBacks.map((record) => (
            <li key={`${record.newSlot}-${record.at}`} className="text-foreground">
              The save from {formatWhen(record.savedAt)} was added as file{' '}
              <span className="font-medium">{record.newSlot}</span>
              <span className="text-muted-foreground"> · put back {formatWhen(record.at)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )

  if (picking !== null) {
    const saves = [...picking.saves].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
    return (
      <main className="flex flex-col gap-5">
        {header}
        {notice && <NoticeView notice={notice} />}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArchiveRestore className="size-5 text-primary" aria-hidden="true" />
              Put a save back
            </CardTitle>
            <CardDescription>
              From the copy made {formatWhen(picking.at)}. Pick the save to add to the game&apos;s Load menu. The game
              keeps save names where we can&apos;t read them, so they are shown by when they were saved and their size.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2" aria-label="Saves in this copy">
              {saves.map((save) => (
                <SaveRow
                  key={save.name}
                  save={save}
                  busy={busy}
                  working={puttingBack === save.name}
                  onPutBack={() => void putBack(picking, save)}
                />
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Your other saves stay just as they are. Close The Sims 4 before you put a save back.
            </p>
            <div>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPicking(null)
                  setNotice(null)
                }}
              >
                <ArrowLeft aria-hidden="true" />
                Back to all copies
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="flex flex-col gap-5">
      {header}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground tabular-nums" data-testid="save-copies-summary">
          {loading ? 'Looking for your copies…' : plural(copies.length, 'copy kept', 'copies kept')}
        </p>
        <Button disabled={busy || !api} onClick={() => void makeCopy()}>
          {making ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {making ? 'Making a copy…' : 'Save a copy now'}
        </Button>
      </div>
      {makingStatus}
      {notice && <NoticeView notice={notice} />}
      {history}

      {loadFailed && (
        <ProblemAlert
          words={{
            title: "We couldn't read your save copies",
            detail: 'Your copies and saves were not changed. Try again in a moment.',
            tone: 'warn'
          }}
        />
      )}

      {!loading && !loadFailed && copies.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderClock className="size-5 text-muted-foreground" aria-hidden="true" />
              No save copies yet
            </CardTitle>
            <CardDescription>
              Make one now with Save a copy now. Sims Helper also makes one by itself before it changes your mods (once
              a day) and when the game updates.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {copies.map((copy) => (
            <CopyCard
              key={copy.id}
              copy={copy}
              busy={busy}
              onPick={() => {
                setNotice(null)
                setPicking(copy)
              }}
            />
          ))}
        </div>
      )}
    </main>
  )
}
