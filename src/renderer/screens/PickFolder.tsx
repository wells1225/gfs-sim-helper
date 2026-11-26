import { Clock, Cloud, FolderOpen, FolderSearch, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SimsFolder } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'

function parseFolderTime(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  return Number.isNaN(time) ? 0 : time
}

function formatLastUsed(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

export function PickFolder() {
  const api = useApi()
  const { go } = useNav()
  const { setScan } = useSession()

  const [folders, setFolders] = useState<SimsFolder[] | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadFolders = useCallback(async () => {
    setFolders(null)
    setError(null)
    try {
      const located = await api.invoke('locate:run')
      const sorted = [...located.folders].sort(
        (a, b) => parseFolderTime(b.newestFileAt) - parseFolderTime(a.newestFileAt)
      )
      setFolders(sorted)
    } catch {
      setError("We couldn't check for Sims 4 folders right now. Please try again.")
      setFolders([])
    }
  }, [api])

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  async function handleSelect(folder: SimsFolder) {
    setBusyPath(folder.path)
    setError(null)
    try {
      await api.invoke('settings:update', { folderPath: folder.path })
      setScan(null)
      go({ screen: 'what-happened' })
    } catch {
      setError('That folder could not be saved right now. Please try again.')
    } finally {
      setBusyPath(null)
    }
  }

  if (folders === null) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 py-8 text-center text-muted-foreground">
        <p>Looking for your Sims 4 folders…</p>
      </main>
    )
  }

  if (folders.length === 0) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 py-4">
        <Card className="gap-5 p-6">
          <CardHeader className="items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <FolderSearch className="size-6" strokeWidth={1.75} />
            </div>
            <CardTitle className="text-xl">We couldn&apos;t find your Sims 4 folder</CardTitle>
          </CardHeader>

          <CardContent className="gap-3 text-foreground/90">
            <p>
              We looked in your Documents folder (and OneDrive) for a Sims 4 folder with{' '}
              <span className="font-medium">Options.ini</span>, and didn&apos;t spot one yet.
            </p>
            <div className="rounded-lg bg-muted/60 p-4 text-sm text-foreground/90">
              <p className="mb-2 font-semibold text-foreground">What to try next:</p>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>
                  Open The Sims 4 once on this PC and wait for the main menu so the game creates its folder and{' '}
                  <span className="font-medium">Options.ini</span>.
                </li>
                <li>
                  If your Documents folder is synced with OneDrive, make sure OneDrive is signed in and finished
                  syncing.
                </li>
                <li>Come back here and click Look again.</li>
              </ol>
            </div>
          </CardContent>

          <CardFooter className="justify-center">
            <Button size="lg" onClick={() => void loadFolders()}>
              <RefreshCw className="size-4" strokeWidth={1.75} />
              Look again
            </Button>
          </CardFooter>
        </Card>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Which Sims 4 folder do you play in?</h1>
        <p className="text-muted-foreground">
          {folders.length > 1
            ? 'We found more than one Sims 4 folder on this PC. Pick the one with your current saves and mods.'
            : 'Here is the Sims 4 folder we found on this PC.'}
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t pick that folder</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        {folders.map((folder, index) => {
          const isNewest = index === 0
          const isBusy = busyPath === folder.path
          return (
            <Card key={folder.path} className={`gap-3 p-4 ${isNewest ? 'border-primary/40' : ''}`}>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <FolderOpen className="size-5" strokeWidth={1.75} />
                  </div>
                  <CardTitle className="text-base">
                    {isNewest ? 'Newest Sims 4 folder' : 'Other Sims 4 folder'}
                  </CardTitle>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {isNewest && (
                    <Badge variant="ok">
                      <Sparkles className="size-3.5" strokeWidth={1.75} />
                      Most recently used
                    </Badge>
                  )}
                  {folder.inOneDrive && (
                    <Badge variant="warn">
                      <Cloud className="size-3.5" strokeWidth={1.75} />
                      In OneDrive
                    </Badge>
                  )}
                </div>
              </CardHeader>

              <CardContent className="gap-2">
                <p className="break-all rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground">{folder.path}</p>
                <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                  <Clock className="size-4 shrink-0" strokeWidth={1.75} />
                  Last used: {formatLastUsed(folder.newestFileAt)}
                </p>
              </CardContent>

              <CardFooter>
                <Button
                  variant={isNewest ? 'default' : 'outline'}
                  disabled={busyPath !== null}
                  onClick={() => void handleSelect(folder)}
                >
                  {isBusy ? 'Saving choice…' : 'Use this folder'}
                  <span className="sr-only">
                    : folder {index + 1} of {folders.length}
                    {isNewest ? ', the newest' : ''}, last used {formatLastUsed(folder.newestFileAt)}
                  </span>
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </main>
  )
}
