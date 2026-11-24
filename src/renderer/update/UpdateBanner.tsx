import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Progress } from '../components/ui/progress.tsx'
import { CHECK_AGAIN_EVERY_MS, useUpdateStore } from './update-store.ts'
import { WORDS } from './words.ts'

/**
 * Under the header, only when there is something to do. Checks when the app opens and every 24 hours; nothing
 * downloads until she clicks Update now, and nothing installs until she clicks Restart now.
 */
export function UpdateBanner() {
  const { store, view } = useUpdateStore()
  const toldUpdated = useRef(false)

  useEffect(() => {
    void store.checkOnStart()
    const timer = setInterval(() => void store.checkOnStart(), CHECK_AGAIN_EVERY_MS)
    return () => clearInterval(timer)
  }, [store])

  const { state } = view
  useEffect(() => {
    if (state?.state === 'idle' && state.justUpdated && !toldUpdated.current) {
      toldUpdated.current = true
      toast(WORDS.updated)
    }
  }, [state])

  if (state === null || view.hidden) return null

  switch (state.state) {
    case 'available':
      return (
        <Alert variant="info" role="status" aria-label="Update">
          <AlertTitle>{WORDS.available}</AlertTitle>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void store.download()}>
              {WORDS.updateNow}
            </Button>
            <Button size="sm" variant="ghost" onClick={store.later}>
              {WORDS.later}
            </Button>
          </div>
        </Alert>
      )
    case 'downloading':
      return (
        <Alert variant="info" role="status" aria-label="Update">
          <AlertTitle>{WORDS.downloading(state.percent)}</AlertTitle>
          <Progress className="mt-2" value={state.percent} aria-label={WORDS.downloading(state.percent)} />
        </Alert>
      )
    case 'ready':
      return (
        <Alert variant="info" role="status" aria-label="Update">
          <AlertTitle>{view.restarting ? WORDS.restarting : WORDS.ready}</AlertTitle>
          {view.busy && <AlertDescription>{WORDS.busy}</AlertDescription>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={view.restarting} onClick={() => void store.install()}>
              {WORDS.restartNow}
            </Button>
            <Button size="sm" variant="ghost" disabled={view.restarting} onClick={store.later}>
              {WORDS.later}
            </Button>
          </div>
        </Alert>
      )
    case 'failed':
      if (state.step !== 'download') return null // a failed check shows nothing; About says so when she asks
      return (
        <Alert variant="warn" role="status" aria-label="Update">
          <AlertTitle>{WORDS.downloadFailed}</AlertTitle>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void store.tryAgain()}>
              {WORDS.tryAgain}
            </Button>
            <Button size="sm" variant="ghost" onClick={store.later}>
              {WORDS.later}
            </Button>
          </div>
        </Alert>
      )
    default:
      return null
  }
}
