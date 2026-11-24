import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FiftyAnswer, FiftyFifty, FiftyResult } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { AnswerStep, CloseCurseForgeStep, Ended, FoundStep, Intro, ReadyStep, TestStep, type EndedHow } from './steps.tsx'
import { StopDialog } from './StopDialog.tsx'
import { CURSEFORGE_OPEN, groupLabel, isNotModsResult, PART_WAY, refusalWords } from './words.ts'

type View = { kind: 'loading' } | { kind: 'session'; state: FiftyFifty | null } | { kind: 'ended'; how: EndedHow; label: string }

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
  const [notice, setNotice] = useState<Notice | null>(null)
  const [asking, setAsking] = useState(false)
  const busyRef = useRef(false)

  const reread = useCallback(async (fallback: FiftyFifty | null): Promise<FiftyFifty | null> => {
    const fresh = await api.invoke('fifty:get').catch(() => fallback)
    setView({ kind: 'session', state: fresh })
    return fresh
  }, [api])

  useEffect(() => {
    let live = true
    api.invoke('fifty:get').then(
      (fresh) => live && setView({ kind: 'session', state: fresh }),
      () => live && setView({ kind: 'session', state: null })
    )
    return () => {
      live = false
    }
  }, [api])

  /** Runs one call with every button locked. Anything but ok reads the saved state again and says why. */
  const run = async (
    working: string,
    call: () => Promise<FiftyResult>,
    retryFor: (fresh: FiftyFifty | null) => () => void,
    onOk: (state: FiftyFifty | null) => void
  ) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(working)
    setNotice(null)
    try {
      const result = await call()
      if (result.status === 'ok') {
        onOk(result.state)
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
      setBusy(null)
    }
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
      if (next && isNotModsResult(next)) {
        setView({ kind: 'ended', how: 'not-mods', label: '' })
        return
      }
      show(next)
    })
  }

  const stopTest = () => {
    // Close the question first, so a refusal (the game is still open) is not hidden behind it.
    setAsking(false)
    void run('Putting your mods back…', () => api.invoke('fifty:stop'), () => stopTest, () =>
      setView({ kind: 'ended', how: 'stopped', label: '' })
    )
  }

  const finish = (keep: 'keep-set-aside' | 'put-back', label: string) => {
    const again = () => finish(keep, label)
    void run('Putting your mods back…', () => api.invoke('fifty:finish', { keep }), () => again, () =>
      setView({ kind: 'ended', how: keep === 'keep-set-aside' ? 'kept' : 'put-back', label })
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
    return <Ended how={view.how} label={view.label} onCheckAgain={checkAgain} />
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
        <TestStep state={state} onTested={() => setStep('answer')} locked={locked} />
      ) : (
        <AnswerStep state={state} onAnswer={(answer) => giveAnswer(answer, state.round)} locked={locked} />
      )
  } else {
    const label = groupLabel(state, state.culprit)
    body = <FoundStep state={state} label={label} onFinish={(keep) => finish(keep, label)} locked={locked} />
  }

  const inProgress = !!state && state.phase !== 'found' && state.phase !== 'stopped'
  return (
    <main className="flex flex-col gap-4">
      {noticeBox}
      {body}
      {busy && <Working text={busy} />}
      {inProgress && (
        <div>
          <Button variant="link" className="h-auto p-0 text-muted-foreground" onClick={() => setAsking(true)} disabled={locked}>
            Stop the test
          </Button>
        </div>
      )}
      <StopDialog open={asking} onOpenChange={setAsking} onConfirm={stopTest} busy={locked} />
    </main>
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
