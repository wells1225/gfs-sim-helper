import { useEffect, useRef, useState } from 'react'
import type { UpdateState } from '../../shared/model.ts'
import { Button } from '../components/ui/button.tsx'
import { useUpdateStore } from './update-store.ts'
import { OFF_NOTE, WORDS } from './words.ts'

type Result = 'newest' | 'could-not-check' | 'found-one'

function resultOf(state: UpdateState | null): Result | null {
  switch (state?.state) {
    case 'idle':
      return 'newest'
    case 'available':
    case 'downloading':
    case 'ready':
      return 'found-one'
    case 'checking':
      return null
    default:
      return 'could-not-check'
  }
}

const RESULT_WORDS: Record<Result, string> = {
  newest: WORDS.newest,
  'could-not-check': WORDS.couldNotCheck,
  'found-one': WORDS.foundOne
}

/** Under About: the version, and Check for updates. No release notes from the network. */
export function UpdateRow() {
  const { store, view } = useUpdateStore()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const lastKnown = useRef<UpdateState | null>(null) // a rejected check keeps the version on screen

  useEffect(() => {
    if (store.view().state === null) void store.refresh()
  }, [store])

  if (view.state !== null) lastKnown.current = view.state
  const state = lastKnown.current
  if (state === null) return null
  const version = 'current' in state ? state.current : null

  async function check() {
    setChecking(true)
    setResult(null)
    const answer = await store.checkByClick()
    setResult(resultOf(answer))
    setChecking(false)
  }

  const isChecking = checking || state.state === 'checking'

  return (
    <section aria-label="Updates" className="mt-6 flex flex-col items-start gap-2 border-t border-border pt-4">
      {version !== null && <p className="font-medium">{WORDS.version(version)}</p>}
      {state.state === 'off' ? (
        <p className="text-sm text-muted-foreground">{OFF_NOTE[state.why]}</p>
      ) : (
        <>
          <Button variant="outline" size="sm" disabled={isChecking} onClick={() => void check()}>
            {isChecking ? WORDS.checking : WORDS.checkForUpdates}
          </Button>
          {result !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {RESULT_WORDS[result]}
            </p>
          )}
        </>
      )}
    </section>
  )
}
