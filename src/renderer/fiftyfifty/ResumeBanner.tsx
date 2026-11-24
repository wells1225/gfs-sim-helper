import { FlaskConical } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FiftyFifty } from '../../shared/model.ts'
import { Button } from '../components/ui/button.tsx'
import { useNav } from '../nav.tsx'
import { StopDialog } from './StopDialog.tsx'
import { useOptionalApi } from './use-optional-api.ts'
import { isUncertainResult, partWayWords, refusalWords, roundOf, STOP_CONFIRM } from './words.ts'

/** The banner has no Try again button: its stop button is the way to try again. */
const AGAIN = `click ${STOP_CONFIRM} again`

export function ResumeBanner() {
  const api = useOptionalApi()
  const { route, go } = useNav()
  const onScreen = route.screen === 'fifty-fifty'
  const [state, setState] = useState<FiftyFifty | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const busyRef = useRef(false)

  // Read again on every route change: the 50/50 screen may have stopped or finished the test.
  useEffect(() => {
    if (!api || onScreen) return
    let live = true
    setProblem(null)
    api.invoke('fifty:get').then(
      (s) => live && setState(s),
      () => live && setState(null)
    )
    return () => {
      live = false
    }
  }, [api, onScreen, route])

  if (!api || onScreen || !state || state.phase === 'stopped') return null

  const stopNow = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await api.invoke('fifty:stop')
      setAsking(false)
      if (result.status === 'ok') setState(null)
      else setProblem(result.status === 'refused' ? refusalWords(result.refusal, AGAIN) : partWayWords(AGAIN))
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
    <section
      aria-label="50/50 test"
      className="flex flex-col gap-3 rounded-xl border border-severity-info-border bg-severity-info-bg px-4 py-3 sm:flex-row sm:items-center"
    >
      <div className="flex flex-1 items-start gap-2.5 text-severity-info">
        <FlaskConical className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden />
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold tabular-nums">{title}</p>
          {problem && <p className="text-sm">{problem}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => go({ screen: 'fifty-fifty' })}>Continue</Button>
        <Button variant="outline" onClick={() => setAsking(true)} disabled={busy}>
          {STOP_CONFIRM}
        </Button>
      </div>
      <StopDialog open={asking} onOpenChange={setAsking} onConfirm={stopNow} busy={busy} />
    </section>
  )
}
