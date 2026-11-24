import { ArrowLeft, CheckCircle2, FileArchive, FolderOpen, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ReportResult } from '../../shared/model.ts'
import { useApi } from '../api.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'

export function SendToTyler() {
  const api = useApi()
  const { go } = useNav()
  const { scan } = useSession()

  const [building, setBuilding] = useState(false)
  const [result, setResult] = useState<ReportResult | null>(null)

  async function handleBuild() {
    setBuilding(true)
    setResult(null)
    try {
      const res = await api.invoke('report:build')
      setResult(res)
    } catch (err) {
      setResult({
        status: 'failed',
        why: 'unexpected',
        detail: err instanceof Error ? err.message : 'Could not create the report zip.'
      })
    } finally {
      setBuilding(false)
    }
  }

  async function handleReveal() {
    await api.invoke('report:reveal').catch(() => null)
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-3">
      <div>
        <Button variant="ghost" size="sm" onClick={() => go({ screen: 'check-up' })}>
          <ArrowLeft className="size-4" strokeWidth={1.75} />
          Back to check-up
        </Button>
      </div>

      <Card className="gap-4 p-5">
        <CardHeader className="gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <FileArchive className="size-5" strokeWidth={1.75} />
            </div>
            <CardTitle className="text-xl">Send a report to Tyler</CardTitle>
          </div>
          <p className="text-[0.9375rem] leading-relaxed text-foreground/90">
            This zip holds your crash logs and mod list, never your saves or Tray files. Your Windows user name is
            removed.
          </p>
        </CardHeader>

        <CardContent className="gap-4">
          <div className="grid gap-3 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-2">
            <div>
              <p className="mb-1.5 font-semibold text-foreground">What&apos;s inside</p>
              <ul className="space-y-1 text-muted-foreground">
                <li>Crash &amp; last exception logs</li>
                <li>Options.ini &amp; GameVersion.txt</li>
                <li>Your mod list &amp; CurseForge list</li>
              </ul>
            </div>

            <div>
              <p className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
                <ShieldCheck className="size-4 text-primary" strokeWidth={1.75} />
                Never included
              </p>
              <ul className="space-y-1 text-muted-foreground">
                <li>Your Saves or Tray folders</li>
                <li>Passwords or sign-in tokens</li>
                <li>Your Windows user name</li>
              </ul>
            </div>
          </div>

          {!scan && (
            <Alert variant="info">
              <AlertTitle>Run a check-up first</AlertTitle>
              <AlertDescription>
                We need a quick check-up so we know which logs and mods to pack into the zip.
              </AlertDescription>
            </Alert>
          )}

          {result?.status === 'saved' && (
            <Alert variant="ok" className="gap-3 p-4">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} />
                <div className="flex flex-col gap-1">
                  <AlertTitle>Report saved on your Desktop</AlertTitle>
                  <AlertDescription className="space-y-1">
                    <p className="font-mono text-xs font-semibold">{result.fileName}</p>
                    <p className="tabular-nums">
                      Packed {result.entries.length} {result.entries.length === 1 ? 'file' : 'files'}, ready to send to
                      Tyler.
                    </p>
                  </AlertDescription>
                </div>
              </div>
              <div>
                <Button variant="outline" size="sm" className="bg-card text-foreground" onClick={() => void handleReveal()}>
                  <FolderOpen className="size-4" strokeWidth={1.75} />
                  Show on Desktop
                </Button>
              </div>
            </Alert>
          )}

          {result?.status === 'failed' && (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t save the report</AlertTitle>
              <AlertDescription>
                {result.why === 'no-scan'
                  ? 'Run a check-up first before creating a report.'
                  : result.why === 'write-refused'
                    ? result.detail === 'check-failed'
                      ? "We couldn't make sure your Desktop was safe to save to, so we stopped. Nothing was saved or changed. It is safe to try again."
                      : "We couldn't write the report file to your Desktop right now. Nothing was saved or changed."
                    : 'Something went wrong while building the zip. Nothing was changed. Try again in a moment.'}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="gap-2">
          {scan ? (
            <Button size="lg" disabled={building} onClick={() => void handleBuild()}>
              <FileArchive className="size-4" strokeWidth={1.75} />
              {building ? 'Creating report…' : result?.status === 'saved' ? 'Create another report zip' : 'Create report zip'}
            </Button>
          ) : (
            <Button size="lg" onClick={() => go({ screen: 'check-up' })}>
              Go to check-up
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  )
}
