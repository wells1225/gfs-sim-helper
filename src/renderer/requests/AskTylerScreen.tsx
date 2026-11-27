import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FolderCog,
  Gift,
  History as HistoryIcon,
  Info,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import type { FixOutcome, FixRefusal, JournalEntry, ModFolderState, ModRequest, Progress } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { useOptionalApi } from '../fixes/optional-api.ts'
import {
  LOAD_FAILED_COPY,
  UNEXPECTED_COPY,
  formatBytes,
  formatEntryTimestamp,
  progressCopy
} from '../fixes/words.ts'
import { useNav } from '../nav.tsx'
import { AskTylerSetupScreen } from './AskTylerSetupScreen.tsx'
import {
  BROKEN_DELIVERY_COPY,
  MAX_REQUEST_CHARS,
  SCRIPT_MOD_COPY,
  SENT_CONFIRMATION_COPY,
  countChars,
  installRefusalMessage,
  sendRefusalCopy
} from './words.ts'

const REQUEST_GROUP_PREFIX = 'request:'

function unsettledRequestIds(entries: readonly JournalEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.action !== 'install-mod') continue
    if (entry.status !== 'needs-attention' && entry.status !== 'in-progress') continue
    if (entry.groupId && entry.groupId.startsWith(REQUEST_GROUP_PREFIX)) {
      ids.add(entry.groupId.slice(REQUEST_GROUP_PREFIX.length))
    }
  }
  return ids
}

function formatDeliveryFiles(files: readonly { name: string; bytes: number }[]): string {
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0)
  const countLabel = files.length === 1 ? '1 file' : `${files.length} files`
  return `${countLabel} · ${formatBytes(totalBytes)}`
}

/** PR 17, route ask-tyler: the send box, her requests and "Tyler made you a mod". */
export function AskTylerScreen() {
  const api = useOptionalApi()
  const { go } = useNav()

  const [folder, setFolder] = useState<ModFolderState | null>(null)
  const [loading, setLoading] = useState(api !== null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [requests, setRequests] = useState<ModRequest[]>([])
  const [needsAttentionIds, setNeedsAttentionIds] = useState<Set<string>>(() => new Set())
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sentNotice, setSentNotice] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const [installingId, setInstallingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [installedBanner, setInstalledBanner] = useState<{ title: string; hasScript: boolean } | null>(null)
  const [installError, setInstallError] = useState<{
    requestId: string
    refusal: FixRefusal | 'unexpected'
  } | null>(null)
  const [partWayMessage, setPartWayMessage] = useState<string | null>(null)

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadAll = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadFailed(false)
    try {
      const folderState = await api.invoke('requests:folder')
      if (!mountedRef.current) return
      setFolder(folderState)
      if (folderState.kind === 'set') {
        const [list, journal] = await Promise.all([
          api.invoke('requests:list'),
          api.invoke('journal:list').catch((): JournalEntry[] => [])
        ])
        if (!mountedRef.current) return
        setRequests(list)
        setNeedsAttentionIds(unsettledRequestIds(journal))
      } else {
        setRequests([])
        setNeedsAttentionIds(new Set())
      }
    } catch {
      if (mountedRef.current) {
        setLoadFailed(true)
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [api])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (!api || !installingId) {
      setProgress(null)
      return
    }
    return api.onProgress((p) => {
      if (mountedRef.current && (p.task === 'backup' || p.task === 'fix')) {
        setProgress(p)
      }
    })
  }, [api, installingId])

  const handleFolderConnected = useCallback(
    (connected: Extract<ModFolderState, { kind: 'set' }>) => {
      setFolder(connected)
      void loadAll()
    },
    [loadAll]
  )

  const charLength = countChars(text)
  const overLimit = charLength > MAX_REQUEST_CHARS
  const canSend = !sending && text.trim().length > 0 && !overLimit && installingId === null

  const handleSend = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (!api || !canSend) return
      setSending(true)
      setSendError(null)
      setSentNotice(false)
      try {
        const res = await api.invoke('requests:send', { text })
        if (!mountedRef.current) return
        if (res.kind === 'sent') {
          setText('')
          setSentNotice(true)
          setRequests((prev) => [res.request, ...prev.filter((r) => r.id !== res.request.id)])
        } else {
          setSendError(sendRefusalCopy(res.why))
          if (res.why === 'no-folder') {
            void loadAll()
          }
        }
      } catch {
        if (mountedRef.current) {
          setSendError(sendRefusalCopy('error'))
        }
      } finally {
        if (mountedRef.current) {
          setSending(false)
        }
      }
    },
    [api, canSend, text, loadAll]
  )

  const handleInstall = useCallback(
    async (req: ModRequest) => {
      if (!api || installingId !== null || !req.delivery) return
      setInstallError(null)
      setPartWayMessage(null)
      setInstalledBanner(null)
      setProgress(null)
      setInstallingId(req.id)
      const deliveryTitle = req.delivery.title
      const deliveryHasScript = req.delivery.hasScript

      try {
        let outcome: FixOutcome
        try {
          outcome = await api.invoke('requests:install', { requestId: req.id })
        } catch {
          if (mountedRef.current) {
            setInstallError({ requestId: req.id, refusal: 'unexpected' })
          }
          return
        }
        if (!mountedRef.current) return

        if (outcome.status === 'done') {
          setInstalledBanner({ title: deliveryTitle, hasScript: deliveryHasScript })
          toast(`Installed ${deliveryTitle}`, {
            description: 'Added to your Mods folder. You can undo this anytime in History.'
          })
          const refreshed = await api.invoke('requests:list').catch(() => null)
          if (mountedRef.current) {
            if (refreshed) {
              setRequests(refreshed)
            } else {
              setRequests((prev) =>
                prev.map((item) => (item.id === req.id ? { ...item, status: 'installed' } : item))
              )
            }
          }
          return
        }

        if (outcome.status === 'refused') {
          setInstallError({ requestId: req.id, refusal: outcome.refusal })
          return
        }

        setPartWayMessage(outcome.detail || 'Installing stopped partway through. You can undo what moved in History.')
        const journal = await api.invoke('journal:list').catch((): JournalEntry[] => [])
        if (mountedRef.current) {
          setNeedsAttentionIds(unsettledRequestIds(journal))
        }
      } finally {
        if (mountedRef.current) {
          setInstallingId(null)
        }
      }
    },
    [api, installingId]
  )

  if (loading && folder === null) {
    return (
      <main className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Ask Tyler for a mod</h1>
          <p className="text-[0.9375rem] text-muted-foreground">Checking your shared folder…</p>
        </div>
      </main>
    )
  }

  if (!loadFailed && folder !== null && folder.kind !== 'set') {
    return <AskTylerSetupScreen initialFolder={folder} onConnected={handleFolderConnected} />
  }

  const progressText = progressCopy(progress)
  const readyRequests = requests.filter((r) => r.status === 'ready')

  return (
    <main className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Ask Tyler for a mod</h1>
          <p className="text-[0.9375rem] text-muted-foreground">
            Describe the mod you want in your own words. Tyler will get an email and build it for you.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || installingId !== null}
            onClick={() => void loadAll()}
          >
            <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={installingId !== null}
            onClick={() => go({ screen: 'ask-tyler-setup' })}
          >
            <FolderCog className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Change folder
          </Button>
        </div>
      </div>

      {loadFailed && (
        <Alert variant="warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>{LOAD_FAILED_COPY.title}</AlertTitle>
              <AlertDescription>
                We could not read your shared folder right now. {LOAD_FAILED_COPY.detail}
              </AlertDescription>
              <div>
                <Button variant="outline" size="sm" onClick={() => void loadAll()}>
                  Try again
                </Button>
              </div>
            </div>
          </div>
        </Alert>
      )}

      {installingId && (
        <div
          aria-live="polite"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs"
        >
          <div className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
            <span>{progress ? progressText.heading : 'Installing mod safely…'}</span>
            {progressText.detail && (
              <span className="tabular-nums text-muted-foreground">{progressText.detail}</span>
            )}
          </div>
          <ProgressBar value={progressText.percent} aria-label="Install progress" />
        </div>
      )}

      {installedBanner && (
        <Alert variant="ok" className="gap-3 p-4">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-1.5">
              <AlertTitle>Installed {installedBanner.title}</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>
                  Added to your Mods folder with a backup made first. You can undo this anytime in History.
                </p>
                {installedBanner.hasScript && (
                  <p className="font-medium text-foreground">{SCRIPT_MOD_COPY}</p>
                )}
              </AlertDescription>
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-card text-foreground"
                  onClick={() => go({ screen: 'history' })}
                >
                  <HistoryIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  View in History
                </Button>
              </div>
            </div>
          </div>
        </Alert>
      )}

      {installError && (() => {
        const copy =
          installError.refusal === 'unexpected' ? UNEXPECTED_COPY : installRefusalMessage(installError.refusal)
        const variant =
          copy.tone === 'destructive' ? 'destructive' : copy.tone === 'info' ? 'info' : 'warn'
        const Icon =
          copy.tone === 'destructive' ? ShieldAlert : copy.tone === 'info' ? Info : AlertTriangle
        const targetReq = requests.find((r) => r.id === installError.requestId)
        return (
          <Alert variant={variant}>
            <div className="flex items-start gap-2.5">
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="flex flex-1 flex-col gap-2">
                <AlertTitle>{copy.title}</AlertTitle>
                <AlertDescription>{copy.detail}</AlertDescription>
                {copy.canRetry && targetReq && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={installingId !== null}
                      onClick={() => void handleInstall(targetReq)}
                    >
                      Try again
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </Alert>
        )
      })()}

      {partWayMessage && (
        <Alert variant="warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>Install stopped partway through</AlertTitle>
              <AlertDescription>{partWayMessage}</AlertDescription>
              <div>
                <Button variant="outline" size="sm" onClick={() => go({ screen: 'history' })}>
                  <HistoryIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  Go to History
                </Button>
              </div>
            </div>
          </div>
        </Alert>
      )}

      {readyRequests.length > 0 && (
        <section aria-label="Mods ready to install" className="flex flex-col gap-3">
          {readyRequests.map((req) => {
            const delivery = req.delivery!
            const needsHistoryAttention = needsAttentionIds.has(req.id)
            return (
              <Card
                key={`ready-${req.id}`}
                className={
                  needsHistoryAttention
                    ? 'gap-4 border-severity-warn-border bg-card p-5 shadow-xs'
                    : 'gap-4 border-severity-ok-border bg-card p-5 shadow-xs'
                }
              >
                <CardHeader className="gap-2 p-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div
                        className={
                          needsHistoryAttention
                            ? 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-severity-warn-bg text-severity-warn'
                            : 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-severity-ok-bg text-severity-ok'
                        }
                      >
                        {needsHistoryAttention ? (
                          <AlertTriangle className="size-5" strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <Gift className="size-5" strokeWidth={1.75} aria-hidden="true" />
                        )}
                      </div>
                      <div>
                        <CardTitle className="text-lg">Tyler made you a mod: {delivery.title}</CardTitle>
                        <CardDescription className="tabular-nums">
                          {formatDeliveryFiles(delivery.files)}
                        </CardDescription>
                      </div>
                    </div>
                    {needsHistoryAttention ? (
                      <Badge variant="warn">Needs attention</Badge>
                    ) : (
                      <Badge variant="ok">Ready to install</Badge>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="gap-3 p-0">
                  {needsHistoryAttention && (
                    <Alert variant="warn">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <AlertDescription>
                          A previous install of this mod stopped partway through. Open History to finish putting things
                          back before installing again.
                        </AlertDescription>
                      </div>
                    </Alert>
                  )}

                  {delivery.note && (
                    <div className="rounded-lg bg-muted/50 px-4 py-3 text-[0.9375rem] leading-relaxed text-foreground">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Note from Tyler
                      </p>
                      <p className="whitespace-pre-line">{delivery.note}</p>
                    </div>
                  )}

                  {delivery.hasScript && (
                    <Alert variant="info">
                      <div className="flex items-start gap-2">
                        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <AlertDescription>{SCRIPT_MOD_COPY}</AlertDescription>
                      </div>
                    </Alert>
                  )}

                  <p className="text-sm text-muted-foreground">
                    Your request: &ldquo;{req.text}&rdquo;
                  </p>
                </CardContent>

                <CardFooter className="flex-wrap items-center justify-between gap-3 p-0">
                  {needsHistoryAttention ? (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Undo the earlier install in History first so your Mods folder stays clean.
                      </span>
                      <Button variant="outline" size="lg" onClick={() => go({ screen: 'history' })}>
                        <HistoryIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                        Go to History
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-muted-foreground">
                        A backup is made first. You can undo this anytime in History.
                      </span>
                      <Button
                        size="lg"
                        disabled={installingId !== null}
                        onClick={() => void handleInstall(req)}
                      >
                        <Download className="size-4" strokeWidth={1.75} aria-hidden="true" />
                        {installingId === req.id ? 'Installing…' : 'Install'}
                      </Button>
                    </>
                  )}
                </CardFooter>
              </Card>
            )
          })}
        </section>
      )}

      <Card className="gap-4 p-5">
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSend(e)}>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ask-tyler-text" className="text-base font-semibold text-foreground">
              Tell Tyler what you&apos;d like the mod to do
            </label>
            <span
              id="ask-tyler-count"
              aria-live="polite"
              className={
                overLimit
                  ? 'text-xs font-semibold tabular-nums text-severity-stop'
                  : 'text-xs tabular-nums text-muted-foreground'
              }
            >
              {charLength.toLocaleString()} / {MAX_REQUEST_CHARS.toLocaleString()}
            </span>
          </div>

          <textarea
            id="ask-tyler-text"
            rows={4}
            value={text}
            aria-describedby={overLimit ? 'ask-tyler-count ask-tyler-over-limit' : 'ask-tyler-count'}
            aria-invalid={overLimit || undefined}
            onChange={(e) => {
              setText(e.target.value)
              if (sentNotice) setSentNotice(false)
              if (sendError) setSendError(null)
            }}
            placeholder="Example: Make Sims get a happy moodlet when they put on a brand new outfit..."
            disabled={sending}
            className="w-full resize-y rounded-xl border border-input bg-background px-3.5 py-2.5 text-[0.9375rem] leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          />

          {overLimit && (
            <p id="ask-tyler-over-limit" className="text-sm font-medium text-severity-stop">
              Please keep your note to {MAX_REQUEST_CHARS.toLocaleString()} characters or fewer.
            </p>
          )}

          {sentNotice && (
            <Alert variant="ok">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                <AlertTitle>{SENT_CONFIRMATION_COPY}</AlertTitle>
              </div>
            </Alert>
          )}

          {sendError && (
            <Alert variant="warn">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <AlertDescription>{sendError}</AlertDescription>
              </div>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 text-primary" strokeWidth={1.75} aria-hidden="true" />
              Sends only your note, game version, packs, and mod names. Never your saves.
            </span>
            <Button type="submit" size="lg" disabled={!canSend}>
              <Send className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {sending ? 'Sending…' : 'Send to Tyler'}
            </Button>
          </div>
        </form>
      </Card>

      <section aria-label="Your mod requests" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">Your requests</h2>

        {requests.length === 0 ? (
          <Card className="p-5">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Sparkles className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <p className="text-sm">
                No requests yet. Write what you&apos;d like above and click Send to Tyler.
              </p>
            </div>
          </Card>
        ) : (
          requests.map((req) => (
            <Card key={req.id} className="gap-2.5 px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.9375rem] font-semibold text-foreground">
                      {req.delivery ? req.delivery.title : 'Mod request'}
                    </span>
                    {req.status === 'ready' && <Badge variant="ok">Ready to install</Badge>}
                    {req.status === 'sent' && <Badge variant="info">Sent</Badge>}
                    {req.status === 'installed' && <Badge variant="secondary">Installed</Badge>}
                    {req.status === 'broken' && <Badge variant="warn">Didn&apos;t arrive properly</Badge>}
                  </div>
                  <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-line">{req.text}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3.5" aria-hidden="true" />
                      {formatEntryTimestamp(req.at)}
                    </span>
                    {req.delivery && <span>· {formatDeliveryFiles(req.delivery.files)}</span>}
                  </div>
                </div>

                {req.status === 'installed' && (
                  <Button variant="ghost" size="sm" onClick={() => go({ screen: 'history' })}>
                    <HistoryIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    History
                  </Button>
                )}
              </div>

              {req.status === 'installed' && req.delivery && (
                <div className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {req.delivery.note && <p className="text-foreground/90">{req.delivery.note}</p>}
                  {req.delivery.hasScript && (
                    <p className="mt-1 font-medium text-foreground">{SCRIPT_MOD_COPY}</p>
                  )}
                </div>
              )}

              {req.status === 'broken' && (
                <Alert variant="warn" className="py-2.5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div className="flex flex-col gap-0.5">
                      <AlertTitle className="text-sm">{BROKEN_DELIVERY_COPY}</AlertTitle>
                      <AlertDescription className="text-xs">
                        Nothing was installed into your Mods folder.
                      </AlertDescription>
                    </div>
                  </div>
                </Alert>
              )}
            </Card>
          ))
        )}
      </section>
    </main>
  )
}
