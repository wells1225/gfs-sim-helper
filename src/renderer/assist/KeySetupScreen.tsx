import { KeyRound, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { KeySetResult, KeyStatus } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Input } from '../components/ui/input.tsx'
import { KEY_STATUS_WORDS } from './words.ts'

const NOT_SAVED = 'That key was not saved. Check it and paste it again.'
const OLD_KEY_KEPT = 'That key was not saved. The key stored before is still there.'

/**
 * Tyler's hidden setup screen (Ctrl+Shift+K). The key is read from the field through a ref and the field is
 * emptied at once: it never sits in React state, and only its status comes back.
 */
export function KeySetupScreen() {
  const api = useApi()
  const field = useRef<HTMLInputElement>(null)
  const live = useRef(true)
  const reqId = useRef(0)
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    live.current = true
    const id = ++reqId.current
    api.invoke('assist:status').then(
      (answer) => {
        if (live.current && reqId.current === id) setStatus(answer.key)
      },
      () => {
        if (live.current && reqId.current === id) setStatus('not-set')
      }
    )
    return () => {
      live.current = false
      reqId.current += 1
      if (field.current) field.current.value = ''
    }
  }, [api])

  const finish = (id: number, next: KeyStatus, note: string | null = null) => {
    if (!live.current || reqId.current !== id) return
    setStatus(next)
    setNote(note)
    setBusy(false)
  }

  const saved = (id: number, result: KeySetResult) => {
    // not-saved: the new key was refused and the one stored before stays, so the status is still 'set'
    if (result === 'not-saved') finish(id, 'set', OLD_KEY_KEPT)
    else finish(id, result, result === 'not-set' ? NOT_SAVED : null)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const input = field.current
    if (input === null) return
    const key = input.value
    input.value = ''
    if (busy || status === null || status === 'encryption-unavailable' || key.trim() === '') return
    const prior = status
    const id = ++reqId.current
    setBusy(true)
    api.invoke('assist:set-key', { key }).then(
      (result) => saved(id, result),
      () => finish(id, prior, prior === 'set' ? OLD_KEY_KEPT : NOT_SAVED)
    )
  }

  const remove = () => {
    const prior = status
    const id = ++reqId.current
    setBusy(true)
    api.invoke('assist:clear-key').then(
      (next) => finish(id, next),
      () => finish(id, prior ?? 'not-set')
    )
  }

  const entryDisabled = busy || status === null || status === 'encryption-unavailable'

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 py-6">
      <Card className="gap-5 p-6">
        <CardHeader className="flex-row items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <KeyRound className="size-5" strokeWidth={1.75} aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-1">
            <CardTitle>Ask for help setup</CardTitle>
            <CardDescription>
              For Tyler. Paste the Anthropic API key once. It is stored encrypted on this PC and is never shown again.
              Set a monthly spending cap on the key in the Anthropic console first.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="gap-4">
          {status !== null && (
            <Alert variant={status === 'set' ? 'ok' : status === 'encryption-unavailable' ? 'warn' : 'default'}>
              {status === 'set' ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
              <AlertDescription>{KEY_STATUS_WORDS[status]}</AlertDescription>
            </Alert>
          )}
          {note !== null && <p className="text-sm text-muted-foreground">{note}</p>}

          <form id="key-setup-form" className="flex flex-col gap-2" onSubmit={save}>
            <label htmlFor="assist-key" className="text-sm font-medium">
              Anthropic API key
            </label>
            <Input
              id="assist-key"
              ref={field}
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={entryDisabled}
            />
          </form>
        </CardContent>

        <CardFooter className="gap-2">
          <Button type="submit" form="key-setup-form" disabled={entryDisabled}>
            Save
          </Button>
          <Button variant="outline" onClick={remove} disabled={busy || status !== 'set'}>
            <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Remove key
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
