import { AlertTriangle, ArrowLeft, CheckCircle2, FolderOpen, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModFolderState } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { useOptionalApi } from '../fixes/optional-api.ts'
import { useNav } from '../nav.tsx'
import { folderProblemCopy } from './words.ts'

export interface AskTylerSetupScreenProps {
  initialFolder?: ModFolderState | null
  onConnected?: (state: Extract<ModFolderState, { kind: 'set' }>) => void
}

/** PR 17, route ask-tyler-setup: pick the Sims Helper Mods folder, with the one-screen guide. */
export function AskTylerSetupScreen({ initialFolder = null, onConnected }: AskTylerSetupScreenProps = {}) {
  const api = useOptionalApi()
  const { go } = useNav()

  const [folder, setFolder] = useState<ModFolderState | null>(initialFolder)
  const [checking, setChecking] = useState(initialFolder === null && api !== null)
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (initialFolder !== null) {
      setFolder(initialFolder)
      setChecking(false)
    }
  }, [initialFolder])

  const checkFolder = useCallback(async () => {
    if (!api) return
    setChecking(true)
    setPickError(null)
    try {
      const state = await api.invoke('requests:folder')
      if (!mountedRef.current) return
      setFolder(state)
      if (state.kind === 'set' && onConnected) {
        onConnected(state)
      }
    } catch {
      if (mountedRef.current) {
        setPickError("Couldn't check your folder right now. Try again in a moment.")
      }
    } finally {
      if (mountedRef.current) {
        setChecking(false)
      }
    }
  }, [api, onConnected])

  useEffect(() => {
    if (initialFolder !== null || !api) return
    void checkFolder()
  }, [initialFolder, api, checkFolder])

  const handlePick = useCallback(async () => {
    if (!api || picking) return
    setPicking(true)
    setPickError(null)
    try {
      const next = await api.invoke('requests:pick-folder')
      if (!mountedRef.current) return
      setFolder(next)
      if (next.kind === 'set') {
        if (onConnected) {
          onConnected(next)
        } else {
          go({ screen: 'ask-tyler' })
        }
      }
    } catch {
      if (mountedRef.current) {
        setPickError("Couldn't open the folder picker right now. Try again in a moment.")
      }
    } finally {
      if (mountedRef.current) {
        setPicking(false)
      }
    }
  }, [api, picking, onConnected, go])

  const problem =
    folder && folder.kind !== 'set' && folder.kind !== 'not-set' ? folderProblemCopy(folder) : null

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4">
      {folder?.kind === 'set' && !onConnected && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => go({ screen: 'ask-tyler' })}>
            <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Back to Ask Tyler
          </Button>
        </div>
      )}

      <Card className="gap-5 p-6">
        <CardHeader className="gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <Sparkles className="size-5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-xl">Ask Tyler for a mod</CardTitle>
              <CardDescription className="mt-0.5">
                Connect your shared folder once so your mod requests reach Tyler and finished mods show up here.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="gap-4">
          <ol className="flex flex-col gap-3 rounded-xl bg-muted/50 p-4 text-[0.9375rem] text-foreground">
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                1
              </span>
              <span>
                Tyler shares a Google Drive folder named <strong>Sims Helper Mods</strong> with your Google account.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                2
              </span>
              <span>
                In Google Drive on the web, right-click <strong>Sims Helper Mods</strong> in <em>Shared with me</em>{' '}
                and choose <strong>Add shortcut to Drive</strong> (into <strong>My Drive</strong>).
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                3
              </span>
              <span>
                Open <strong>Google Drive for desktop</strong> so the folder shows up right on your PC.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                4
              </span>
              <span>
                Pick the <strong>Sims Helper Mods</strong> folder below. You only need to do this once.
              </span>
            </li>
          </ol>

          {folder?.kind === 'set' && (
            <Alert variant="ok">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <AlertTitle>Sims Helper Mods is connected</AlertTitle>
                  <AlertDescription>
                    You can keep using this folder or pick a different copy of Sims Helper Mods below.
                  </AlertDescription>
                </div>
              </div>
            </Alert>
          )}

          {problem && (
            <Alert variant="warn">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <AlertTitle>{problem.title}</AlertTitle>
                  <AlertDescription>{problem.detail}</AlertDescription>
                </div>
              </div>
            </Alert>
          )}

          {pickError && (
            <Alert variant="warn">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <AlertDescription>{pickError}</AlertDescription>
              </div>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="flex-wrap gap-2">
          <Button size="lg" disabled={picking || checking} onClick={() => void handlePick()}>
            <FolderOpen className="size-4" strokeWidth={1.75} aria-hidden="true" />
            {picking ? 'Opening folder picker…' : 'Pick the Sims Helper Mods folder'}
          </Button>
          {folder?.kind === 'missing' && (
            <Button variant="outline" size="lg" disabled={checking || picking} onClick={() => void checkFolder()}>
              <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Check again
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  )
}
