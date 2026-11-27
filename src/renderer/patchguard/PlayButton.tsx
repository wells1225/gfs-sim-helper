import { Loader2, Play } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '../components/ui/button.tsx'
import { useOptionalApi } from '../fixes/optional-api.ts'
import { useNav } from '../nav.tsx'
import { PlayNoticeAlert } from './PatchGuardBanner.tsx'
import { usePatchGuardStore } from './store.ts'

/** PR 16, shell header, beside the main menu: the Play button (patchguard:play). */
export function PlayButton() {
  const api = useOptionalApi()
  const { go } = useNav()
  const { store, state } = usePatchGuardStore(api)

  useEffect(() => {
    if (!store) return
    return store.mountPlayButton()
  }, [store])

  if (!store) return null

  const onPlay = async () => {
    const answer = await store.play(false)
    if (answer.kind === 'stopped' && answer.why === 'game-updated') {
      go({ screen: 'patch-day' })
    }
  }

  return (
    <>
      <Button size="sm" disabled={state.starting} onClick={() => void onPlay()}>
        {state.starting ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Play className="size-3.5" aria-hidden="true" />
        )}
        {state.starting ? 'Starting…' : 'Play'}
      </Button>
      {!state.bannerMounted && state.playNotice && (
        <PlayNoticeAlert notice={state.playNotice} onDismiss={() => store.clearPlayNotice()} />
      )}
    </>
  )
}
