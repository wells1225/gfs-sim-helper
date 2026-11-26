import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FiftyAnswer, FiftyFifty, FiftyStopResult, Progress } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { checkBack, checkFound, type BackCheck, type FoundCheck } from './back-check.tsx'
import { DamagedProgress } from './DamagedProgress.tsx'
import { AnswerStep, CloseCurseForgeStep, Ended, FoundStep, Intro, ReadyStep, TestStep, type EndedHow } from './steps.tsx'
import { StopDialog } from './StopDialog.tsx'
import {
  CURSEFORGE_OPEN,
  fiftyProgressCopy,
  groupLabel,
  isNotModsResult,
  isProgressDamaged,
  NOT_COUNTED,
  PART_WAY,
  refusalWords
} from './words.ts'

type View =
  | { kind: 'loading' }
  | { kind: 'session'; state: FiftyFifty | null }
  | { kind: 'damaged' } // the progress file is there but cannot be read
  | { kind: 'ended'; how: EndedHow; label: string; back: BackCheck }

interface Notice {
  text: string
  retry?: () => void
}

export function FiftyFiftyScreen() {
  const api = useApi()
  const { go } = useNav()
  const { scan, setScan } = useSession()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [step, setStep] = useState<'test' | 'answer'>('test')
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [asking, setAsking] = useState(false)
  const [foundCheck, setFoundCheck] = useState<FoundCheck | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!busy) {
      setProgress(null)
      return
    }
    setProgress(null)
    let live = true
    const unsubscribe = api.onProgress((next) => {
      if (live && (next.task === 'backup' || next.task === 'fix')) {
        setProgress(next)
      }
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [api, busy])

  // The found card asks History each time the session is read (every read makes a new `view`), so it never
  // says more than History shows.
  useEffect(() => {
    setFoundCheck(null)
    const found = view.kind === 'session' && view.state?.phase === 'found' ? view.state : null
    if (!found) return
    let live = true
    void checkFound(api, found).then((check) => live && setFoundCheck(check))
    return () => {
      live = false
    }
  }, [api, view])

  /** What is saved now. A failed read falls back to `fallback`. */
  const read = useCallback(
    async (fallback: FiftyFifty | null): Promise<View> => {
      try {
        const got = await api.invoke('fifty:get')
        return isProgressDamaged(got) ? { kind: 'damaged' } : { kind: 'session', state: got }
      } catch {
        return { kind: 'session', state: fallback }
      }
    },
    [api]
  )

  const reread = useCallback(
    async (fallback: FiftyFifty | null): Promise<FiftyFifty | null> => {
      const fresh = await read(fallback)
      setView(fresh)
      return fresh.kind === 'session' ? fresh.state : null
    },
    [read]
  )

  useEffect(() => {
    let live = true
    void read(null).then((fresh) => live && setView(fresh))
    return () => {
      live = false
    }
  }, [read])

  /**
   * Runs one call with every button locked. Anything but ok reads the saved state again and says why. A stop that
   * found the file damaged has no state, and the read that follows shows the damaged card in place of the notice.
   */
  const run = async (
    working: string,
    call: () => Promise<FiftyStopResult>,
    retryFor: (fresh: FiftyFifty | null) => () => void,
    onOk: (state: FiftyFifty | null) => void | Promise<void>
  ) => {
    if (busyRef.current) return
    busyRef.current = true
    setProgress(null)
    setBusy(working)
    setNotice(null)
    try {
      const result = await call()
      if (result.status === 'ok') {
        await onOk(result.state)
        return
      }
      const fresh = await reread(result.status === 'stopped-part-way' ? result.state : null)
      setStep('test')
      setNotice({ text: result.status === 'refused' ? refusalWords(result.refusal) : PART_WAY, retry: retryFor(fresh) })
    } catch {
      const current = view.kind === 'session' ? view.state : null
      setNotice({ text: 'Something went wrong. Please try again.', retry: retryFor(current) })
    } finally {
      busyRef.current = false
      setProgress(null)
      setBusy(null)
    }
  }

  /** The end card. It asks History first, so it only says every mod is back when that is so. */
  const end = async (how: EndedHow, label: string, sessionId: string | null, keep: string | null) => {
    const back = await checkBack(api, sessionId, keep)
    setView({ kind: 'ended', how, label, back })
  }

  const show = (state: FiftyFifty | null) => {
    setStep('test')
    setView({ kind: 'session', state })
  }

  const beginRound = () =>
    void run('Setting aside mods and clearing the cache…', () => api.invoke('fifty:begin-round'), () => beginRound, (state) => {
      show(state)
      if (state?.phase === 'close-curseforge') setNotice({ text: CURSEFORGE_OPEN })
    })

  const startTest = () =>
    void run('Starting the 50/50 test…', () => api.invoke('fifty:start'), () => startTest, show)

  /** `round` is the round on her screen, so main can tell a late click from an answer to the round it is on. */
  const giveAnswer = (answer: FiftyAnswer, round: number) => {
    const working = round === 0 && answer === 'crashed' ? 'Putting your mods back…' : 'Getting the next round ready…'
    const retryFor = (fresh: FiftyFifty | null) =>
      answer !== 'not-sure' && fresh?.phase === 'awaiting-answer' && fresh.round === round
        ? () => giveAnswer(answer, round)
        : beginRound
    void run(working, () => api.invoke('fifty:answer', { answer, round }), retryFor, (next) => {
      if (next && isNotModsResult(next)) return end('not-mods', '', next.id, null)
      show(next)
      // Main only hands the same round back unarranged when it found the files were not as the round set them.
      if (answer !== 'not-sure' && next?.phase === 'ready-to-test' && next.round === round && next.culprit === null) {
        setNotice({ text: NOT_COUNTED })
      }
    })
  }

  const stopTest = (session: FiftyFifty) => {
    // Close the question first, so a refusal (the game is still open) is not hidden behind it.
    setAsking(false)
    void run('Putting your mods back…', () => api.invoke('fifty:stop'), () => () => stopTest(session), (stopped) =>
      end('stopped', '', stopped?.id ?? session.id, null)
    )
  }

  const finish = (keep: 'keep-set-aside' | 'put-back', label: string, session: FiftyFifty) => {
    const again = () => finish(keep, label, session)
    const kept = keep === 'keep-set-aside'
    void run('Putting your mods back…', () => api.invoke('fifty:finish', { keep }), () => again, (ended) =>
      end(kept ? 'kept' : 'put-back', label, ended?.id ?? session.id, kept ? session.culprit : null)
    )
  }

  const checkAgain = () => {
    setScan(null)
    go({ screen: 'check-up' })
  }

  if (view.kind === 'loading') {
    return <Working text="Loading…" />
  }
  if (view.kind === 'ended') {
    return (
      <Ended
        how={view.how}
        label={view.label}
        back={view.back}
        onCheckAgain={checkAgain}
        onSendReport={() => go({ screen: 'send-to-tyler' })}
      />
    )
  }
  if (view.kind === 'damaged') {
    return (
      <main className="flex flex-col gap-4">
        <DamagedProgress
          onFixed={() => {
            // The notice of the call that found the damage is about a test that is gone now.
            setNotice(null)
            void reread(null)
          }}
        />
      </main>
    )
  }

  const state = view.state
  const locked = busy !== null
  const noticeBox = notice && (
    <Alert variant="warn">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <AlertDescription>{notice.text}</AlertDescription>
      </div>
      {notice.retry && (
        <div className="pt-1">
          <Button size="sm" onClick={notice.retry} disabled={locked}>
            Try again
          </Button>
        </div>
      )}
    </Alert>
  )

  let body
  if (!state || state.phase === 'stopped') {
    body = <Intro scan={scan} onStart={startTest} onCheckUp={() => go({ screen: 'check-up' })} locked={locked} />
  } else if (state.phase === 'close-curseforge') {
    body = <CloseCurseForgeStep state={state} onClosed={beginRound} locked={locked} />
  } else if (state.phase === 'ready-to-test') {
    body = <ReadyStep state={state} onSetUp={beginRound} locked={locked} hideButton={!!notice?.retry} />
  } else if (state.phase === 'awaiting-answer') {
    body =
      step === 'test' ? (
        <TestStep state={state} onTested={() => setStep('answer')} locked={locked} symptom={scan?.symptom} />
      ) : (
        <AnswerStep
          state={state}
          onAnswer={(answer) => giveAnswer(answer, state.round)}
          locked={locked}
          symptom={scan?.symptom}
        />
      )
  } else {
    const label = groupLabel(state, state.culprit)
    body = <FoundStep state={state} label={label} check={foundCheck} onFinish={(keep) => finish(keep, label, state)} locked={locked} />
  }

  const inProgress = !!state && state.phase !== 'found' && state.phase !== 'stopped'
  return (
    <main className="flex flex-col gap-4">
      {noticeBox}
      {body}
      {busy && <MoveProgress fallback={busy} progress={progress} />}
      {inProgress && (
        <div>
          <Button variant="link" className="h-auto p-0 text-muted-foreground" onClick={() => setAsking(true)} disabled={locked}>
            Stop the test
          </Button>
        </div>
      )}
      <StopDialog open={asking} onOpenChange={setAsking} onConfirm={() => state && stopTest(state)} busy={locked} />
    </main>
  )
}

function MoveProgress({ fallback, progress }: { fallback: string; progress: Progress | null }) {
  const copy = fiftyProgressCopy(progress, fallback)
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs"
    >
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
        <span className="flex items-center gap-2 tabular-nums">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" strokeWidth={1.75} aria-hidden />
          {copy.heading}
        </span>
        {copy.detail && <span className="tabular-nums text-muted-foreground">{copy.detail}</span>}
      </div>
      <ProgressBar value={copy.percent} aria-label={copy.heading} />
    </div>
  )
}

function Working({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} aria-hidden />
      {text}
    </p>
  )
}
