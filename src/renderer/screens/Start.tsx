import { useEffect } from 'react'
import type { SimsHelperApi } from '../../shared/ipc.ts'
import { useApi } from '../api.tsx'
import { useNav } from '../nav.tsx'

export function Start() {
  const api = useApi()
  const { go } = useNav()

  useEffect(() => {
    let cancelled = false

    async function decideFirstScreen(client: SimsHelperApi) {
      try {
        const settings = await client.invoke('settings:get')
        if (cancelled) return

        if (settings.welcome !== 'seen') {
          go({ screen: 'welcome' })
          return
        }

        if (settings.folderPath) {
          go({ screen: 'what-happened' })
          return
        }

        const located = await client.invoke('locate:run')
        if (cancelled) return

        if (located.folders.length > 1) {
          go({ screen: 'pick-folder' })
        } else {
          go({ screen: 'what-happened' })
        }
      } catch {
        if (!cancelled) {
          go({ screen: 'welcome' })
        }
      }
    }

    void decideFirstScreen(api)
    return () => {
      cancelled = true
    }
  }, [api, go])

  return (
    <main className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
      <p>Getting things ready…</p>
    </main>
  )
}
