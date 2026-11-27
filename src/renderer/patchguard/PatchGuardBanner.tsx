import { AlertTriangle, Info, Sparkles } from 'lucide-react'
import { useEffect } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { useOptionalApi } from '../fixes/optional-api.ts'
import { useNav } from '../nav.tsx'
import { usePatchGuardStore, type PlayNotice } from './store.ts'
import { playNoticeCopy, updateBannerText } from './words.ts'

export function PlayNoticeAlert({ notice, onDismiss }: { notice: PlayNotice; onDismiss: () => void }) {
  const copy = playNoticeCopy(notice)
  const Icon = copy.tone === 'warn' ? AlertTriangle : Info
  return (
    <Alert variant={copy.tone} role="status" aria-label="Play status">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-1">
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.detail}</AlertDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Alert>
  )
}

/**
 * PR 16, shell, under UpdateBanner: calm notice when The Sims 4 updated since last seen,
 * plus status notices from the Play button.
 */
export function PatchGuardBanner() {
  const api = useOptionalApi()
  const { go } = useNav()
  const { store, state } = usePatchGuardStore(api)

  useEffect(() => {
    if (!store) return
    const unmount = store.mountBanner()
    void store.loadWatch()
    return unmount
  }, [store])

  if (!store) return null

  const showUpdateBanner =
    state.watch !== null &&
    state.watch.changed &&
    state.watch.lastSeen !== null &&
    state.watch.current !== null &&
    !state.dismissed

  if (!showUpdateBanner && state.playNotice === null) return null

  return (
    <div className="flex flex-col gap-3">
      {showUpdateBanner && state.watch && (
        <Alert variant="info" role="status" aria-label="Game update">
          <div className="flex items-start gap-2.5">
            <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>{updateBannerText(state.watch)}</AlertTitle>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => go({ screen: 'patch-day' })}>
                  Get ready
                </Button>
                <Button size="sm" variant="ghost" onClick={() => store.dismissBanner()}>
                  Not now
                </Button>
              </div>
            </div>
          </div>
        </Alert>
      )}
      {state.playNotice && (
        <PlayNoticeAlert notice={state.playNotice} onDismiss={() => store.clearPlayNotice()} />
      )}
    </div>
  )
}
