import { CircleCheck, FlaskConical, Gamepad2, Info, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FiftyAnswer, FiftyFifty, Scan, Symptom } from '../../shared/model.ts'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card } from '../components/ui/card.tsx'
import { Progress } from '../components/ui/progress.tsx'
import { backWords, HistoryButton, type BackCheck, type FoundCheck } from './back-check.tsx'
import {
  ALL_BACK,
  displayRound,
  expectedRounds,
  groupLabel,
  groupsWord,
  isControlRound,
  isUncertainResult,
  roundHeader,
  roundsWord
} from './words.ts'

export type EndedHow = 'stopped' | 'kept' | 'put-back' | 'not-mods'

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold leading-snug tracking-tight">{children}</h2>
}

function Text({ children }: { children: ReactNode }) {
  return <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">{children}</p>
}

/** "Round 2 of about 7 · 32 mod groups left" and a bar that fills as the rounds go by. */
function RoundHeader({ state }: { state: FiftyFifty }) {
  const done = state.roundsAtMost > 0 ? Math.min(100, Math.max(0, (state.round / state.roundsAtMost) * 100)) : 0
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
  const rounds = expectedRounds(groups)
  return (
    <Card>
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-1 size-6 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
        <div className="flex flex-col gap-2">
          <Heading>The 50/50 test</Heading>
          <Text>
            The 50/50 test first checks whether the game still crashes with all mods set aside, then narrows your mods
            down half at a time. After each round you play a quick test and tell us whether the game crashed.
          </Text>
          {scan && groups > 0 && (
            <Text>
              You have <span className="tabular-nums">{groupsWord(groups)}</span>, so this takes about{' '}
              <span className="tabular-nums">{roundsWord(rounds)}</span>. Each round is one game load.
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
            We make a safety copy before moving anything. Your saves and households are never touched, and you can stop at any time
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
  if (state.culprit !== null) {
    const label = groupLabel(state, state.culprit)
    return (
      <Card>
        <RoundHeader state={state} />
        <Heading>Finish setting up your mods</Heading>
        <Text>
          We will put your other mods back and leave {label} set aside so your game is ready to play. If The Sims 4 is
          open, save and close it first.
        </Text>
        {!hideButton && (
          <div>
            <Button size="lg" onClick={onSetUp} disabled={locked}>
              Put the other mods back
            </Button>
          </div>
        )}
      </Card>
    )
  }

  const roundNum = displayRound(state.round)
  const control = isControlRound(state)
  return (
    <Card>
      <RoundHeader state={state} />
      <Heading>Get round {roundNum} ready</Heading>
      <Text>
        {control
          ? `We will set aside all ${groupsWord(state.parked.length)} and clear the cache so you can check whether the crash still happens with no mods at all. If The Sims 4 is open, save and close it first.`
          : `We will set aside ${groupsWord(state.parked.length)} and clear the cache. If The Sims 4 is open, save and close it first.`}
      </Text>
      {!hideButton && (
        <div>
          <Button size="lg" onClick={onSetUp} disabled={locked}>
            Set up round {roundNum}
          </Button>
        </div>
      )}
    </Card>
  )
}

export function TestStep({
  state,
  onTested,
  locked,
  symptom
}: {
  state: FiftyFifty
  onTested(): void
  locked: boolean
  symptom?: Symptom
}) {
  const control = isControlRound(state)
  return (
    <Card>
      <RoundHeader state={state} />
      <Heading>{control ? 'Test without mods first' : 'Time to test'}</Heading>
      <p className="flex items-center gap-2 text-[0.9375rem]">
        <CircleCheck className="size-4 shrink-0 text-severity-ok" strokeWidth={1.75} aria-hidden />
        We set aside {control ? `all ${groupsWord(state.parked.length)}` : groupsWord(state.parked.length)} and cleared
        the cache.
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
      {symptom === 'one-save-or-lot' && (
        <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <span>
            If the problem only happens on one save or lot, it may not show up in a new test household. That is okay. You
            can choose Stop the test below and send a report to Tyler instead.
          </span>
        </p>
      )}
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
      <Heading>{isControlRound(state) ? 'Did the game crash without mods?' : 'Did the game crash?'}</Heading>
      <Text>Close The Sims 4 before you answer, so we can move your mods safely.</Text>
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

/**
 * `check` decides the words: null until History has answered. Only a check that found every other mod back and
 * the cause set aside may say so.
 */
export function FoundStep({
  state,
  label,
  check,
  onFinish,
  locked
}: {
  state: FiftyFifty
  label: string
  check: FoundCheck | null
  onFinish(keep: 'keep-set-aside' | 'put-back'): void
  locked: boolean
}) {
  const rounds = state.history.filter((h) => h.answer !== 'not-sure').length
  const uncertain = isUncertainResult(state)
  const othersLeft = check !== null && check.others.kind !== 'all-back' ? check.others : null
  const aside = check?.causeAside ?? null
  const asShown = check !== null && othersLeft === null && aside === true
  const inMods = aside === false && `${label} is in your Mods folder right now.`
  return (
    <Card>
      <Heading>{uncertain ? 'The result is uncertain' : 'We found the most likely cause'}</Heading>
      {uncertain ? (
        <>
          <p className="text-lg leading-relaxed">
            The game crashed in every split round, so we can't be sure whether <strong>{label}</strong> is the only cause.
          </p>
          <Text>
            {asShown
              ? `It's the last group left, and we've already put your other mods back with ${label} set aside so you can try playing once with just it out. `
              : "It's the last group left. "}
            If the game still crashes{!asShown && ` with ${label} set aside`}, more than one mod may be involved, or two
            mods may be clashing.{inMods && ` ${inMods}`}
          </Text>
        </>
      ) : (
        <>
          <p className="text-lg leading-relaxed">
            <strong>{label}</strong> is most likely what's making your game crash.
          </p>
          {(rounds > 0 || aside !== null) && (
            <Text>
              {rounds > 0 && <>It took {roundsWord(rounds)}. </>}
              {asShown
                ? `We already put your other mods back and left ${label} set aside, so you can play while you look for an update from its creator.`
                : aside === true
                  ? `${label} is set aside, so you can play while you look for an update from its creator.`
                  : inMods}
            </Text>
          )}
        </>
      )}
      {othersLeft && (
        <Alert variant="warn">
          <AlertDescription>{backWords(othersLeft)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          size="lg"
          className="h-auto min-h-11 whitespace-normal py-2 text-left"
          onClick={() => onFinish('keep-set-aside')}
          disabled={locked}
        >
          Keep {label} set aside
        </Button>
        <Button size="lg" variant="outline" onClick={() => onFinish('put-back')} disabled={locked}>
          Put everything back
        </Button>
        {othersLeft && <HistoryButton />}
      </div>
    </Card>
  )
}

/** `back` decides the words: only a check that found every mod back may say so. */
export function Ended({
  how,
  label,
  back,
  onCheckAgain
}: {
  how: EndedHow
  label: string
  back: BackCheck
  onCheckAgain(): void
}) {
  const heading =
    how === 'not-mods'
      ? 'Mods are unlikely to be the cause'
      : how === 'stopped'
        ? 'The 50/50 test is stopped'
        : 'All done'
  const allBack = back.kind === 'all-back'
  return (
    <main>
      <Card>
        <Heading>{heading}</Heading>
        {how === 'not-mods' ? (
          <>
            <Text>
              The game still crashed with all your mods set aside, so a mod is unlikely to be behind it.
              {allBack && ` ${ALL_BACK}`}
            </Text>
            <Text>
              Try repairing the game in the EA app: open the EA app, find The Sims 4, click Manage, and choose Repair.
            </Text>
          </>
        ) : how === 'kept' ? (
          <Text>
            {label} is set aside.{allBack && ' Everything else is back in your Mods folder.'} You can turn it back on
            from Your mods whenever you like.
          </Text>
        ) : (
          allBack && <Text>{ALL_BACK}</Text>
        )}
        {!allBack && (
          <Alert variant="warn">
            <AlertDescription>{backWords(back)}</AlertDescription>
          </Alert>
        )}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          Every move is listed in History.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onCheckAgain}>Check again</Button>
          {!allBack && <HistoryButton />}
        </div>
      </Card>
    </main>
  )
}
