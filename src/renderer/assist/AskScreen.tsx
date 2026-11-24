import { ArrowLeft, Lightbulb, LoaderCircle, RefreshCw, Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistPreview } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { useNav } from '../nav.tsx'
import { NO_ANSWER_WORDS, type NoAnswerWhy } from './words.ts'

type Step =
  | { step: 'loading' }
  | { step: 'no-scan' }
  | { step: 'preview'; preview: AssistPreview; sending: boolean }
  | { step: 'answered'; text: string }
  | { step: 'no-answer'; why: NoAnswerWhy }

export function AskScreen() {
  const api = useApi()
  const { go } = useNav()
  const [state, setState] = useState<Step>({ step: 'loading' })
  const live = useRef(true)

  const loadPreview = useCallback(() => {
    setState({ step: 'loading' })
    api.invoke('assist:preview').then(
      (preview) => {
        if (!live.current) return
        setState(preview === null ? { step: 'no-scan' } : { step: 'preview', preview, sending: false })
      },
      () => {
        if (live.current) setState({ step: 'no-answer', why: 'error' })
      }
    )
  }, [api])

  useEffect(() => {
    live.current = true
    loadPreview()
    return () => {
      live.current = false
    }
  }, [loadPreview])

  const send = (preview: AssistPreview) => {
    setState({ step: 'preview', preview, sending: true })
    api.invoke('assist:send', { previewId: preview.id }).then(
      (answer) => {
        if (!live.current) return
        setState(answer.status === 'answered' ? { step: 'answered', text: answer.text } : { step: 'no-answer', why: answer.why })
      },
      () => {
        if (live.current) setState({ step: 'no-answer', why: 'error' })
      }
    )
  }

  const backToCheckUp = () => go({ screen: 'check-up' })

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 py-6">
      {state.step === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Getting the summary ready…
        </p>
      )}

      {state.step === 'no-scan' && (
        <Card className="gap-4 p-6">
          <CardHeader>
            <CardTitle>Run a check-up first</CardTitle>
            <CardDescription>Ask for help sends a summary of your last check-up, and there isn't one yet.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={backToCheckUp}>Go to the check-up</Button>
          </CardFooter>
        </Card>
      )}

      {state.step === 'preview' && (
        <Card className="gap-4 p-6">
          <CardHeader>
            <CardTitle>Here is exactly what will be sent</CardTitle>
            <CardDescription>
              Only the text below is sent: your game version, your newest error logs and your mod names. Your saves
              and Tray files stay on this PC. It goes to Claude, an AI helper, only when you click Send.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre
              data-testid="assist-preview"
              aria-label="What will be sent"
              tabIndex={0}
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/60 p-3 font-mono text-sm text-foreground/90"
            >
              {state.preview.text}
            </pre>
          </CardContent>
          <CardFooter className="gap-2">
            <Button onClick={() => send(state.preview)} disabled={state.sending}>
              {state.sending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="size-4" strokeWidth={1.75} aria-hidden="true" />
              )}
              {state.sending ? 'Sending…' : 'Send'}
            </Button>
            <Button variant="outline" onClick={backToCheckUp} disabled={state.sending}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      )}

      {state.step === 'answered' && (
        <Card className="gap-4 p-6">
          <CardHeader className="gap-2">
            <Badge variant="info" className="self-start">
              <Lightbulb aria-hidden="true" />
              This is a guess
            </Badge>
            <CardTitle>What the AI helper thinks</CardTitle>
          </CardHeader>
          <CardContent className="gap-3">
            <div data-testid="assist-answer" className="whitespace-pre-wrap leading-relaxed">
              {state.text}
            </div>
            <p className="text-sm text-muted-foreground">
              Ask for help only reads. It never changes your files. If it points to a fix, use that button on your
              check-up.
            </p>
          </CardContent>
          <CardFooter>
            <Button onClick={backToCheckUp}>
              <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Back to the check-up
            </Button>
          </CardFooter>
        </Card>
      )}

      {state.step === 'no-answer' && (
        <>
          <Alert variant="info">
            <AlertTitle>{NO_ANSWER_WORDS[state.why].title}</AlertTitle>
            <AlertDescription>{NO_ANSWER_WORDS[state.why].detail}</AlertDescription>
          </Alert>
          <div className="flex gap-2">
            {NO_ANSWER_WORDS[state.why].canRetry && (
              <Button onClick={loadPreview}>
                <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
                Try again
              </Button>
            )}
            <Button variant="outline" onClick={backToCheckUp}>
              Back to the check-up
            </Button>
          </div>
        </>
      )}
    </main>
  )
}
