import { useEffect, useRef, useState } from 'react'
import type { FiftyFifty } from '../../shared/model.ts'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { checkBack, type BackCheck } from './back-check.tsx'
import { BannerCard, DamagedProgress, StoppedCard } from './DamagedProgress.tsx'
import { StopDialog } from './StopDialog.tsx'
import { useOptionalApi } from './use-optional-api.ts'
import {
  damagedPartWayWords,
  isProgressDamaged,
  isUncertainResult,
  partWayWords,
  refusalWords,
  roundOf,
  STOP_AGAIN,
  STOP_CONFIRM
} from './words.ts'

export function ResumeBanner() {
  const api = useOptionalApi()
  const { route, go } = useNav()
  const onScreen = route.screen === 'fifty-fifty'
  const [state, setState] = useState<FiftyFifty | null>(null)
  const [damaged, setDamaged] = useState(false)
  const [left, setLeft] = useState<Exclude<BackCheck, { kind: 'all-back' }> | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const busyRef = useRef(false)

  // Read again on every route change: the 50/50 screen may have stopped or finished the test.
  useEffect(() => {
    if (!api || onScreen) return
    let live = true
    setProblem(null)
    setLeft(null)
    api.invoke('fifty:get').then(
      (got) => {
        if (!live) return
        const isDamaged = isProgressDamaged(got)
        setState(isDamaged ? null : got)
        setDamaged(isDamaged)
      },
      () => {
        if (!live) return
        setState(null)
        setDamaged(false)
      }
    )
    return () => {
      live = false
    }
  }, [api, onScreen, route])

  if (!api || onScreen) return null
  if (damaged) return <DamagedProgress onFixed={() => setDamaged(false)} startWith={problem} />
  if (left) return <StoppedCard back={left} onDone={() => setLeft(null)} />
  if (!state || state.phase === 'stopped') return null

  const stopNow = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await api.invoke('fifty:stop')
      setAsking(false)
      if (result.status === 'ok') {
        // Going quiet reads as "all back", so only go quiet when History agrees.
        const back = await checkBack(api, result.state?.id ?? state.id, null)
        setState(null)
        if (back.kind !== 'all-back') setLeft(back)
      } else if (result.status === 'refused') {
        setProblem(refusalWords(result.refusal, STOP_AGAIN))
      } else if (result.state === null) {
        // The stop found the progress file damaged: there is no test to continue, only the way out.
        setState(null)
        setDamaged(true)
        setProblem(damagedPartWayWords(result.notBack))
      } else {
        setProblem(partWayWords(STOP_AGAIN))
      }
    } catch {
      setAsking(false)
      setProblem('Something went wrong. Please try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const title =
    state.phase === 'found'
      ? isUncertainResult(state)
        ? '50/50 test: result is uncertain'
        : '50/50 test: we found the most likely cause'
      : `50/50 test in progress · ${roundOf(state)}`

  return (
    <BannerCard title={title} text={problem}>
      <Button onClick={() => go({ screen: 'fifty-fifty' })}>Continue</Button>
      <Button variant="outline" onClick={() => setAsking(true)} disabled={busy}>
        {STOP_CONFIRM}
      </Button>
      <StopDialog open={asking} onOpenChange={setAsking} onConfirm={stopNow} busy={busy} />
    </BannerCard>
  )
}
