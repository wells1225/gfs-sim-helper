import { ArrowRight, Heart, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { DEDICATION } from '../../shared/app.ts'
import { useApi } from '../api.tsx'
import { Emblem } from '../components/Emblem.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader } from '../components/ui/card.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { useNav } from '../nav.tsx'

export function Welcome() {
  const api = useApi()
  const { go } = useNav()
  const [starting, setStarting] = useState(false)

  async function handleStart() {
    setStarting(true)
    try {
      await api.invoke('settings:update', { welcome: 'seen' }).catch(() => null)
      const located = await api.invoke('locate:run').catch(() => null)
      if (located && located.folders.length > 1) {
        go({ screen: 'pick-folder' })
      } else {
        go({ screen: 'what-happened' })
      }
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col py-1">
      <Card className="gap-4 p-6">
        <CardHeader className="items-center gap-3 text-center">
          <Emblem className="size-14" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Welcome to Sims Helper</h1>
            <p className="text-base leading-relaxed text-foreground/90">
              Hi Lila! Tyler made this so your game can stop crashing. Let&apos;s take a look at your mods.
            </p>
          </div>
        </CardHeader>

        <CardContent className="gap-2.5">
          <div className="flex items-start gap-3 rounded-lg bg-muted/60 px-4 py-2.5">
            <Search className="mt-0.5 size-5 shrink-0 text-primary" strokeWidth={1.75} />
            <div>
              <p className="font-medium text-foreground">Looks without changing anything</p>
              <p className="text-sm text-muted-foreground">
                Checks your mods folder, script mods, and recent crash logs safely.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg bg-muted/60 px-4 py-2.5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" strokeWidth={1.75} />
            <div>
              <p className="font-medium text-foreground">Your saves always come first</p>
              <p className="text-sm text-muted-foreground">
                Never changes your saves or households.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg bg-muted/60 px-4 py-2.5">
            <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" strokeWidth={1.75} />
            <div>
              <p className="font-medium text-foreground">Plain answers, step by step</p>
              <p className="text-sm text-muted-foreground">
                Shows what to check first in plain English, and lets you send a clean report to Tyler.
              </p>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex-col gap-3 pt-0">
          <Button size="lg" className="w-full" disabled={starting} onClick={() => void handleStart()}>
            {starting ? 'Opening your check-up…' : "Let's take a look"}
            <ArrowRight className="size-4" strokeWidth={1.75} />
          </Button>

          <Separator />

          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Heart className="size-3.5 text-primary" strokeWidth={1.75} />
            {DEDICATION}
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}
