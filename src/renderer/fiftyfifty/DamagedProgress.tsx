import { FlaskConical } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useApi } from '../api.tsx'
import { Button } from '../components/ui/button.tsx'
import { backWords, checkBack, HistoryButton, type BackCheck } from './back-check.tsx'
import { DAMAGED_NOT_FINISHED, DAMAGED_TITLE, DAMAGED_WHY, partWayWords, refusalWords, STOP_AGAIN, STOP_CONFIRM } from './words.ts'

type Left = Exclude<BackCheck, { kind: 'all-back' }>

/** The same look as the resume banner: one calm card, shown above every screen and on the 50/50 screen itself. */
export function BannerCard({ title, text, children }: { title: string; text?: string | null; children: ReactNode }) {
  return (
    <section
      aria-label="50/50 test"
      className="flex flex-col gap-3 rounded-xl border border-severity-info-border bg-severity-info-bg px-4 py-3 sm:flex-row sm:items-center"
    >
      <div className="flex flex-1 items-start gap-2.5 text-severity-info">
        <FlaskConical className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden />
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold tabular-nums">{title}</p>
          {text && <p className="text-sm">{text}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  )
}

/** After a stop that could not show every mod is back: says which, and where to put them back. */
export function StoppedCard({ back, onDone }: { back: Left; onDone(): void }) {
  return (
    <BannerCard title="The 50/50 test is stopped" text={backWords(back)}>
      <HistoryButton />
      <Button variant="ghost" onClick={onDone}>
        OK
      </Button>
    </BannerCard>
  )
}

/**
 * fiftyfifty.json is there but cannot be read. Fixes are refused while it is, so this is her way out: one button
 * that asks main to put back everything the test set aside and remove the file. No second question: there is
 * no test left to keep.
 */
export function DamagedProgress({ onFixed }: { onFixed(): void }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [left, setLeft] = useState<Left | null>(null)
  const busyRef = useRef(false)

  const putBack = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await api.invoke('fifty:stop')
      if (result.status === 'ok') {
        const back = await checkBack(api, null, null)
        if (back.kind === 'all-back') onFixed()
        else setLeft(back)
      } else {
        setProblem(result.status === 'refused' ? refusalWords(result.refusal, STOP_AGAIN) : partWayWords(STOP_AGAIN))
      }
    } catch {
      setProblem(DAMAGED_NOT_FINISHED)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  if (left) return <StoppedCard back={left} onDone={onFixed} />
  return (
    <BannerCard title={DAMAGED_TITLE} text={problem ?? DAMAGED_WHY}>
      <Button onClick={() => void putBack()} disabled={busy}>
        {STOP_CONFIRM}
      </Button>
    </BannerCard>
  )
}
