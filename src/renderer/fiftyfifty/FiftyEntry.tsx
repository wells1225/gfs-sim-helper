import { FlaskConical } from 'lucide-react'
import type { Scan } from '../../shared/model.ts'
import { Button } from '../components/ui/button.tsx'
import { Card } from '../components/ui/card.tsx'
import { useNav } from '../nav.tsx'
import { expectedRounds, groupsWord, roundsWord } from './words.ts'

export function FiftyEntry({ scan }: { scan: Scan }) {
  const { go } = useNav()
  const groups = scan.inventory.groups.length
  if (groups === 0) return null
  const open = () => go({ screen: 'fifty-fifty' })

  if (!scan.findings.some((f) => f.next === 'fifty-fifty')) {
    return (
      <p className="text-[0.9375rem] text-muted-foreground">
        Still crashing and not sure why?{' '}
        <Button variant="link" className="h-auto p-0" onClick={open}>
          Try the 50/50 test
        </Button>
      </p>
    )
  }

  const rounds = expectedRounds(groups)
  return (
    <Card>
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-0.5 size-5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold leading-snug">Not sure which mod it is?</h3>
          <p className="text-[0.9375rem] text-muted-foreground">
            The 50/50 test first checks with all mods set aside, then narrows them down half at a time until one is left.
            For your <span className="tabular-nums">{groupsWord(groups)}</span> that takes about{' '}
            <span className="tabular-nums">{roundsWord(rounds)}</span>, one game load each.
          </p>
        </div>
      </div>
      <div>
        <Button size="lg" onClick={open}>
          Find it with the 50/50 test
        </Button>
      </div>
    </Card>
  )
}
