import { LifeBuoy } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Scan } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { useNav } from '../nav.tsx'

/** Shown under the check-up cards only when main says `offer`: a key is stored and nothing clear was found. */
export function AskEntry({ scan }: { scan: Scan }) {
  const api = useApi()
  const { go } = useNav()
  const [offer, setOffer] = useState(false)

  useEffect(() => {
    let live = true
    setOffer(false)
    api.invoke('assist:status').then(
      (status) => {
        if (live) setOffer(status.offer === 'offer')
      },
      () => {
        // No answer means no button.
      }
    )
    return () => {
      live = false
    }
  }, [api, scan.id])

  if (!offer) return null

  return (
    <Card className="gap-4 p-6">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <LifeBuoy className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1">
          <CardTitle>Still stuck? Ask for help</CardTitle>
          <CardDescription>
            Send a short summary of your error logs and mod names to an AI helper and read its best guess. You see
            exactly what is sent before anything goes.
          </CardDescription>
        </div>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" onClick={() => go({ screen: 'ask-for-help' })}>
          Ask for help
        </Button>
      </CardFooter>
    </Card>
  )
}
