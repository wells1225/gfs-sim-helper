import { CircleCheck, FlaskConical, Gamepad2, Info, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FiftyAnswer, FiftyFifty, Scan } from '../../shared/model.ts'
import { Alert } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card } from '../components/ui/card.tsx'
import { Progress } from '../components/ui/progress.tsx'
import { ALL_BACK, groupsWord, roundHeader, roundsWord } from './words.ts'

export type EndedHow = 'stopped' | 'kept' | 'put-back'

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold leading-snug tracking-tight">{children}</h2>
}

function Text({ children }: { children: ReactNode }) {
  return <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">{children}</p>
}

/** "Round 2 of about 6 · 16 mod groups left" and a bar that fills as the rounds go by. */
function RoundHeader({ state }: { state: FiftyFifty }) {
  const done = state.roundsAtMost > 0 ? ((state.round - 1) / state.roundsAtMost) * 100 : 0
  const text = roundHeader(state)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium tabular-nums text-muted-foreground">{text}</p>
      <Progress value={done} aria-label={text} />
    </div>
  )
}

export function Intro({
  scan,
  onStart,
  onCheckUp,
  locked
}: {
  scan: Scan | null
  onStart(): void
  onCheckUp(): void
  locked: boolean
}) {
  const groups = scan?.inventory.groups.length ?? 0
  const rounds = Math.ceil(Math.log2(Math.max(groups, 1)))
  return (
    <Card>
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-1 size-6 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
        <div className="flex flex-col gap-2">
          <Heading>The 50/50 test</Heading>
          <Text>
            The 50/50 test finds a broken mod by setting aside half your mods at a time. After each round you play a
            quick test and tell us whether the game crashed.
          </Text>
          {scan && groups > 0 && (
            <Text>
              You have <span className="tabular-nums">{groupsWord(groups)}</span>
              {rounds > 0 ? (
                <>
                  , so this takes about <span className="tabular-nums">{roundsWord(rounds)}</span>. Each round is one
                  game load.
                </>
              ) : (
                ', so there is nothing to split.'
              )}
            </Text>
          )}
          {!scan && <Text>Run the check-up first, so we know which mods you have.</Text>}
          {scan && groups === 0 && <Text>There are no mods in your Mods folder to test.</Text>}
        </div>
      </div>
      <Alert variant="ok">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="text-sm">
            We make a safety copy before moving anything. Saves and Tray are never touched, and you can stop at any time
            to put every mod back.
          </span>
        </div>
      </Alert>
      <div>
        {scan ? (
          <Button size="lg" onClick={onStart} disabled={locked || groups === 0}>
            Start the 50/50 test
          </Button>
        ) : (
          <Button size="lg" onClick={onCheckUp}>
            Run the check-up
          </Button>
        )}
      </div>
    </Card>
  )
}

export function CloseCurseForgeStep({ state, onClosed, locked }: { state: FiftyFifty; onClosed(): void; locked: boolean }) {
  return (
    <Card>
      <RoundHeader state={state} />
      <Heading>First, close CurseForge</Heading>
      <Text>
        CurseForge can download or update mods in the middle of a test, and that would mix up the result. Close it, and
        check the little arrow by the clock in case it is still running there.
      </Text>
      <div>
        <Button size="lg" onClick={onClosed} disabled={locked}>
          CurseForge is closed
        </Button>
      </div>
    </Card>
  )
}

export function ReadyStep({
  state,
  onSetUp,
  locked,
  hideButton
}: {
  state: FiftyFifty
  onSetUp(): void
  locked: boolean
  hideButton: boolean
}) {
  return (
    <Card>
      <RoundHeader state={state} />
      <Heading>Get round {state.round} ready</Heading>
      <Text>
        We will set aside {groupsWord(state.parked.length)} and clear the cache. If The Sims 4 is open, save and close it
        first.
      </Text>
      {!hideButton && (
        <div>
          <Button size="lg" onClick={onSetUp} disabled={locked}>
            Set up round {state.round}
          </Button>
        </div>
      )}
    </Card>
  )
}

export function TestStep({ state, onTested, locked }: { state: FiftyFifty; onTested(): void; locked: boolean }) {
  return (
    <Card>
      <RoundHeader state={state} />
      <Heading>Time to test</Heading>
      <p className="flex items-center gap-2 text-[0.9375rem]">
        <CircleCheck className="size-4 shrink-0 text-severity-ok" strokeWidth={1.75} aria-hidden />
        We set aside {groupsWord(state.parked.length)} and cleared the cache.
      </p>
      <Alert variant="info">
        <div className="flex items-start gap-2">
          <Gamepad2 className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <p className="text-[0.9375rem] font-medium">
            Open The Sims 4, start a <strong>new</strong> test household (don't open your real save), and try the thing
            that crashed.
          </p>
        </div>
      </Alert>
      <Text>Keep CurseForge closed while you test. When you are done, close the game and come back here.</Text>
      <div>
        <Button size="lg" onClick={onTested} disabled={locked}>
          I've tested it
        </Button>
      </div>
    </Card>
  )
}

export function AnswerStep({
  state,
  onAnswer,
  locked
}: {
  state: FiftyFifty
  onAnswer(answer: FiftyAnswer): void
  locked: boolean
}) {
  return (
    <Card>
      <RoundHeader state={state} />
      <Heading>Did the game crash?</Heading>
      <Text>Close The Sims 4 before you answer, so we can set up the next round.</Text>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button size="lg" variant="outline" className="h-16 text-base" onClick={() => onAnswer('crashed')} disabled={locked}>
          It still crashed
        </Button>
        <Button size="lg" variant="outline" className="h-16 text-base" onClick={() => onAnswer('worked')} disabled={locked}>
          No crash, it worked!
        </Button>
      </div>
      <div>
        <Button variant="link" className="h-auto p-0 text-muted-foreground" onClick={() => onAnswer('not-sure')} disabled={locked}>
          Not sure, let me test again
        </Button>
      </div>
    </Card>
  )
}

export function FoundStep({
  state,
  label,
  onFinish,
  locked
}: {
  state: FiftyFifty
  label: string
  onFinish(keep: 'keep-set-aside' | 'put-back'): void
  locked: boolean
}) {
  return (
    <Card>
      <Heading>We found the most likely cause</Heading>
      <p className="text-lg leading-relaxed">
        <strong>{label}</strong> is most likely what's making your game crash.
      </p>
      <Text>
        It took {roundsWord(state.history.filter((h) => h.answer !== 'not-sure').length)}. Keeping it set aside lets you
        play while you look for an update from its creator. Some mods are still set aside from the last round until you
        choose.
      </Text>
      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={() => onFinish('keep-set-aside')} disabled={locked}>
          Keep {label} set aside and put everything else back
        </Button>
        <Button size="lg" variant="outline" onClick={() => onFinish('put-back')} disabled={locked}>
          Put everything back
        </Button>
      </div>
    </Card>
  )
}

export function Ended({ how, label, onCheckAgain }: { how: EndedHow; label: string; onCheckAgain(): void }) {
  return (
    <main>
      <Card>
        <Heading>{how === 'stopped' ? 'The 50/50 test is stopped' : 'All done'}</Heading>
        {how === 'kept' ? (
          <Text>
            {label} is set aside. Everything else is back in your Mods folder. You can turn it back on from Your mods
            whenever you like.
          </Text>
        ) : (
          <Text>{ALL_BACK}</Text>
        )}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          Every move is listed in History.
        </p>
        <div>
          <Button onClick={onCheckAgain}>Check again</Button>
        </div>
      </Card>
    </main>
  )
}
