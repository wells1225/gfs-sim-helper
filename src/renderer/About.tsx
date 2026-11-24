import { Heart, ShieldCheck } from 'lucide-react'
import { APP_TITLE, DEDICATION } from '../shared/app'
import { Emblem } from './components/Emblem.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './components/ui/card.tsx'
import { Separator } from './components/ui/separator.tsx'

export function About() {
  return (
    <main className="mx-auto flex max-w-xl flex-col py-6">
      <Card className="gap-5 p-7 text-center">
        <CardHeader className="items-center gap-3">
          <Emblem className="size-16" />
          <CardTitle className="text-2xl font-bold tracking-tight">{APP_TITLE}</CardTitle>
          <p className="inline-flex items-center gap-1.5 text-base font-medium text-primary">
            <Heart className="size-4" strokeWidth={1.75} />
            {DEDICATION}
          </p>
        </CardHeader>

        <CardContent className="gap-4">
          <p className="text-[0.9375rem] leading-relaxed text-foreground/90">
            A calm helper for checking your mods folder, script mods, and crash logs in plain English so you can get
            back to playing.
          </p>

          <div className="inline-flex items-center justify-center gap-2 rounded-lg bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
            <span>Your Saves and Tray folders are never touched.</span>
          </div>
        </CardContent>

        <Separator />

        <CardFooter className="justify-center pt-0">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Independent helper tool for The Sims 4. Not affiliated with or endorsed by Electronic Arts or Maxis.
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}
