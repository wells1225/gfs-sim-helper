import { AlertTriangle, Code2, Info, Package, Search, ShieldAlert, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DisabledGroup, FixRefusal, JournalEntry, ModGroup, Progress } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Input } from '../components/ui/input.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { useOptionalApi } from './optional-api.ts'
import {
  LOAD_FAILED_COPY,
  UNEXPECTED_COPY,
  formatBytes,
  formatEntryTimestamp,
  groupLabelFromEntry,
  progressCopy,
  refusalMessage
} from './words.ts'

interface ModListItem {
  groupId: string
  label: string
  enabled: boolean
  hasScript: boolean
  source: ModGroup['source'] | null
  fileCount: number | null
  bytes: number | null
  disabledEntry: DisabledGroup | null
  /** A set-aside or put-back of this mod stopped partway: History sorts it out, so there is no switch. */
  needsAttention: boolean
}

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function ModsScreen() {
  const api = useOptionalApi()
  const { scan } = useSession()
  const { go } = useNav()

  const [disabled, setDisabled] = useState<DisabledGroup[]>([])
  const [stuck, setStuck] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [refusalState, setRefusalState] = useState<{
    groupId: string
    targetEnabled: boolean
    entryId?: string
    label: string
    refusal: FixRefusal | 'unexpected' // 'unexpected': the call failed with an error
  } | null>(null)

  const mountedRef = useRef(true)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusAfterRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadDisabled = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }
    try {
      // Each half is kept on its own: a failed load must never look like an empty list, or hide the half that loaded.
      const [list, journal] = await Promise.allSettled([api.invoke('groups:disabled'), api.invoke('journal:list')])
      if (!mountedRef.current) return
      if (list.status === 'fulfilled') {
        setDisabled(list.value)
      }
      if (journal.status === 'fulfilled') {
        setStuck(
          journal.value.filter(
            (e) =>
              e.action === 'disable-group' &&
              e.groupId !== null &&
              (e.status === 'needs-attention' || e.status === 'in-progress')
          )
        )
      }
      setLoadFailed(list.status === 'rejected' || journal.status === 'rejected')
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [api])

  useEffect(() => {
    void loadDisabled()
  }, [loadDisabled])

  // A button that was just used can go away (Try again, a row that moved back to Mods), so keep keyboard focus.
  useEffect(() => {
    const target = focusAfterRef.current
    if (target === null || busyGroupId !== null || loading) return
    focusAfterRef.current = null
    const active = document.activeElement
    if (active && active !== document.body) return
    const control = target ? document.getElementById(`mods-control-${target}`) : null
    if (control instanceof HTMLElement && !control.hasAttribute('disabled')) control.focus()
    else headingRef.current?.focus()
  }, [busyGroupId, loading, loadFailed, disabled, stuck])

  useEffect(() => {
    if (!api || !busyGroupId) {
      setProgress(null)
      return
    }
    return api.onProgress((p) => {
      if (mountedRef.current && (p.task === 'backup' || p.task === 'fix')) {
        setProgress(p)
      }
    })
  }, [api, busyGroupId])

  const items = useMemo<ModListItem[]>(() => {
    const disabledById = new Map<string, DisabledGroup>()
    for (const entry of disabled) {
      disabledById.set(entry.groupId, entry)
    }

    const stuckById = new Map<string, JournalEntry>()
    for (const entry of stuck) {
      if (entry.groupId === null || stuckById.has(entry.groupId)) continue
      if (scan && !sameFolder(entry.folderPath, scan.folder.path)) continue
      stuckById.set(entry.groupId, entry)
    }

    const combined: ModListItem[] = []
    const seen = new Set<string>()

    if (scan) {
      for (const group of scan.inventory.groups) {
        seen.add(group.id)
        const disabledEntry = disabledById.get(group.id) ?? null
        combined.push({
          groupId: group.id,
          label: group.label,
          enabled: disabledEntry === null,
          hasScript: group.hasScript,
          source: group.source,
          fileCount: group.files.length,
          bytes: group.bytes,
          disabledEntry,
          needsAttention: stuckById.has(group.id)
        })
      }
    }

    for (const entry of disabled) {
      if (seen.has(entry.groupId)) continue
      combined.push({
        groupId: entry.groupId,
        label: entry.label,
        enabled: false,
        hasScript: false,
        source: entry.groupId.startsWith('cf:') ? 'curseforge' : null,
        fileCount: null,
        bytes: null,
        disabledEntry: entry,
        needsAttention: stuckById.has(entry.groupId)
      })
      seen.add(entry.groupId)
    }

    for (const [groupId, entry] of stuckById) {
      if (seen.has(groupId)) continue
      combined.push({
        groupId,
        label: groupLabelFromEntry(entry),
        enabled: false,
        hasScript: false,
        source: groupId.startsWith('cf:') ? 'curseforge' : null,
        fileCount: null,
        bytes: null,
        disabledEntry: null,
        needsAttention: true
      })
    }

    return combined.sort((a, b) => {
      if (a.hasScript !== b.hasScript) return a.hasScript ? -1 : 1
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    })
  }, [disabled, scan, stuck])

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return items
    return items.filter((item) => item.label.toLowerCase().includes(trimmed))
  }, [items, query])

  const activeCount = items.filter((i) => i.enabled).length
  const setAsideCount = items.filter((i) => !i.enabled).length

  const toggleGroup = useCallback(
    async (item: {
      groupId: string
      label: string
      targetEnabled: boolean
      entryId?: string
    }) => {
      if (!api) return
      setRefusalState(null)
      setProgress(null)
      focusAfterRef.current = item.groupId
      setBusyGroupId(item.groupId)

      try {
        if (!item.targetEnabled) {
          const outcome = await api.invoke('fix:apply', {
            via: 'group',
            fix: 'disable-group',
            groupId: item.groupId
          })
          if (!mountedRef.current) return

          if (outcome.status === 'done') {
            const entry = outcome.entry
            setDisabled((prev) => [
              {
                groupId: item.groupId,
                label: item.label,
                entryId: entry.id,
                at: entry.at
              },
              ...prev.filter((d) => d.groupId !== item.groupId)
            ])
            toast(`Set aside ${item.label}`, {
              description: 'Moved safely out of Mods. You can turn it back on anytime.',
              action: {
                label: 'Undo',
                onClick: () => {
                  void toggleGroup({
                    groupId: item.groupId,
                    label: item.label,
                    targetEnabled: true,
                    entryId: entry.id
                  })
                }
              }
            })
            return
          }

          if (outcome.status === 'refused') {
            setRefusalState({
              groupId: item.groupId,
              targetEnabled: false,
              label: item.label,
              refusal: outcome.refusal
            })
            return
          }

          toast.warning(`Stopped partway while setting aside ${item.label}`, {
            description: outcome.detail || 'Open History to review or undo what moved.'
          })
          await loadDisabled()
        } else {
          const outcome = item.entryId
            ? await api.invoke('journal:undo', { entryId: item.entryId })
            : await api.invoke('fix:apply', {
                via: 'group',
                fix: 'enable-group',
                groupId: item.groupId
              })
          if (!mountedRef.current) return

          if (outcome.status === 'done') {
            setDisabled((prev) => prev.filter((d) => d.groupId !== item.groupId))
            toast(`Put ${item.label} back in Mods`)
            return
          }

          if (outcome.status === 'refused') {
            setRefusalState({
              groupId: item.groupId,
              targetEnabled: true,
              entryId: item.entryId,
              label: item.label,
              refusal: outcome.refusal
            })
            return
          }

          toast.warning(`Stopped partway while putting ${item.label} back`, {
            description: outcome.detail || 'Open History to review what moved.'
          })
          await loadDisabled()
        }
      } catch {
        if (mountedRef.current) {
          setRefusalState({
            groupId: item.groupId,
            targetEnabled: item.targetEnabled,
            entryId: item.entryId,
            label: item.label,
            refusal: 'unexpected'
          })
        }
      } finally {
        if (mountedRef.current) {
          setBusyGroupId(null)
        }
      }
    },
    [api, loadDisabled]
  )

  const progressText = progressCopy(progress)

  return (
    <main className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-foreground outline-none"
          >
            Your mods
          </h1>
          <p className="text-[0.9375rem] text-muted-foreground">
            Switch any mod off to set it aside safely outside your Sims folder. Nothing is ever deleted.
          </p>
        </div>

        {!loading && items.length > 0 && (
          <div className="flex items-center gap-2 tabular-nums">
            {scan && (
              <Badge variant="ok">
                {activeCount} active
              </Badge>
            )}
            {setAsideCount > 0 && (
              <Badge variant="warn">{setAsideCount} set aside</Badge>
            )}
          </div>
        )}
      </div>

      {!scan && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" aria-hidden="true" />
              Run a check-up to see all your mods
            </CardTitle>
            <CardDescription>
              Run a quick check-up first so we can list every mod in your Mods folder. Any mods you already set
              aside are listed below so you can put them back anytime.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              <Button onClick={() => go({ screen: 'check-up' })}>Run check-up</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {busyGroupId && (
        <div
          aria-live="polite"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs"
        >
          <div className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
            <span>{progressText.heading}</span>
            {progressText.detail && (
              <span className="tabular-nums text-muted-foreground">{progressText.detail}</span>
            )}
          </div>
          <ProgressBar value={progressText.percent} aria-label={progressText.heading} />
        </div>
      )}

      {refusalState && (() => {
        const copy =
          refusalState.refusal === 'unexpected' ? UNEXPECTED_COPY : refusalMessage(refusalState.refusal)
        const variant =
          copy.tone === 'destructive' ? 'destructive' : copy.tone === 'info' ? 'info' : 'warn'
        const Icon =
          copy.tone === 'destructive' ? ShieldAlert : copy.tone === 'info' ? Info : AlertTriangle
        return (
          <Alert variant={variant}>
            <div className="flex items-start gap-2.5">
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="flex flex-1 flex-col gap-2">
                <AlertTitle>{copy.title}</AlertTitle>
                <AlertDescription>{copy.detail}</AlertDescription>
                {copy.canRetry && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void toggleGroup({
                          groupId: refusalState.groupId,
                          label: refusalState.label,
                          targetEnabled: refusalState.targetEnabled,
                          entryId: refusalState.entryId
                        })
                      }
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

      {loadFailed && (
        <Alert variant="warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-2">
              <AlertTitle>{LOAD_FAILED_COPY.title}</AlertTitle>
              <AlertDescription>
                We could not check which mods are set aside. {LOAD_FAILED_COPY.detail}
              </AlertDescription>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => {
                    focusAfterRef.current = ''
                    setLoading(true)
                    void loadDisabled()
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          </div>
        </Alert>
      )}

      {items.length > 0 && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your mods…"
            aria-label="Search your mods"
            className="pl-9"
          />
        </div>
      )}

      {!loading && !loadFailed && items.length === 0 && scan && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="size-5 text-muted-foreground" aria-hidden="true" />
              No mods found in this check-up
            </CardTitle>
            <CardDescription>
              Your Mods folder had no mod packages or scripts during the last check-up.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {!loading && !loadFailed && !scan && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No mods are currently set aside.</p>
      )}

      {filtered.length > 0 && (
        <section
          aria-label={!scan ? 'Mods currently set aside' : 'Installed and set-aside mods'}
          className="flex flex-col gap-2.5"
        >
          {!scan && (
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              Currently set aside
            </h2>
          )}

          {filtered.map((item) => {
            const isBusy = busyGroupId === item.groupId
            return (
              <Card key={item.groupId} className="gap-0 px-4 py-3.5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[0.9375rem] font-semibold text-foreground">
                        {item.label}
                      </span>
                      {item.hasScript && (
                        <Badge variant="info">
                          <Code2 className="size-3.5" aria-hidden="true" />
                          Script mod
                        </Badge>
                      )}
                      {item.source === 'curseforge' && (
                        <Badge variant="secondary">CurseForge</Badge>
                      )}
                      {item.needsAttention ? (
                        <Badge variant="warn">Needs attention</Badge>
                      ) : (
                        !item.enabled && <Badge variant="warn">Set aside</Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground tabular-nums">
                      {item.fileCount !== null && (
                        <span>
                          {item.fileCount === 1 ? '1 file' : `${item.fileCount.toLocaleString()} files`}
                        </span>
                      )}
                      {item.bytes !== null && <span>· {formatBytes(item.bytes)}</span>}
                      {item.needsAttention ? (
                        <span>A change to this mod stopped partway. History can put it right.</span>
                      ) : (
                        item.disabledEntry && (
                          <span>Set aside {formatEntryTimestamp(item.disabledEntry.at)}</span>
                        )
                      )}
                    </div>
                  </div>

                  {item.needsAttention ? (
                    <Button
                      id={`mods-control-${item.groupId}`}
                      variant="outline"
                      size="sm"
                      aria-label={`Open History for ${item.label}`}
                      onClick={() => go({ screen: 'history' })}
                    >
                      Open History
                    </Button>
                  ) : (
                    <Switch
                      id={`mods-control-${item.groupId}`}
                      checked={item.enabled}
                      disabled={busyGroupId !== null}
                      aria-label={item.enabled ? `Set ${item.label} aside` : `Turn ${item.label} back on`}
                      onCheckedChange={(checked) => {
                        if (isBusy) return
                        void toggleGroup({
                          groupId: item.groupId,
                          label: item.label,
                          targetEnabled: checked,
                          entryId: item.disabledEntry?.entryId
                        })
                      }}
                    />
                  )}
                </div>
              </Card>
            )
          })}
        </section>
      )}

      {items.length > 0 && filtered.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          No mods match “{query.trim()}”.
        </p>
      )}
    </main>
  )
}
