import { AlertTriangle, ChevronDown, ChevronRight, Code2, Info, Package, Search, ShieldAlert, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DisabledGroup, FixRefusal, IsoTime, JournalEntry, ModFile, ModGroup, Progress } from '../../shared/model.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Input } from '../components/ui/input.tsx'
import { Progress as ProgressBar } from '../components/ui/progress.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { useNav } from '../nav.tsx'
import { useSession } from '../session.tsx'
import { FILE_LIST_CAP, applyModsView, summarizeMods, type ModsFilter, type ModsSort } from './mods-filter.ts'
import { useOptionalApi } from './optional-api.ts'
import {
  LOAD_FAILED_COPY,
  UNEXPECTED_COPY,
  formatBytes,
  formatEntryTimestamp,
  progressCopy,
  refusalMessage,
  setAsideRefusalMessage
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
  /** The group's files from the check-up. Empty for a row known only from History. */
  files: ModFile[]
}

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

const FILTER_LABELS: Record<ModsFilter, string> = {
  all: 'All',
  scripts: 'Script mods',
  'older-than-update': 'Older than game update',
  'set-aside': 'Set aside'
}

const SORT_LABELS: Record<ModsSort, string> = {
  name: 'Name (A-Z)',
  largest: 'Largest first',
  oldest: 'Oldest first'
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function formatFileDate(iso: IsoTime): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

/** A safe piece of an element id: group ids hold colons, slashes and spaces. */
function idPart(groupId: string): string {
  return groupId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function ModsScreen() {
  const api = useOptionalApi()
  const { scan } = useSession()
  const { go } = useNav()

  const [disabled, setDisabled] = useState<DisabledGroup[]>([])
  /** Every set-aside entry for one group: the stuck ones get a row, and the done ones give a script mark. */
  const [groupEntries, setGroupEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ModsFilter>('all')
  const [sort, setSort] = useState<ModsSort>('name')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
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
        setGroupEntries(journal.value.filter((e) => e.action === 'disable-group' && e.groupId !== null))
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
  }, [busyGroupId, loading, loadFailed, disabled, groupEntries])

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

    const entriesById = new Map(groupEntries.map((e) => [e.id, e]))
    const stuckById = new Map<string, JournalEntry>()
    for (const entry of groupEntries) {
      if (entry.status !== 'needs-attention' && entry.status !== 'in-progress') continue
      if (entry.groupId === null || stuckById.has(entry.groupId)) continue
      if (scan && !sameFolder(entry.folderPath, scan.folder.path)) continue
      stuckById.set(entry.groupId, entry)
    }

    const combined: ModListItem[] = []
    const seen = new Set<string>()

    if (scan) {
      const filesByGroup = new Map<string, ModFile[]>()
      for (const file of scan.inventory.files) {
        const list = filesByGroup.get(file.groupId)
        if (list) list.push(file)
        else filesByGroup.set(file.groupId, [file])
      }
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
          needsAttention: stuckById.has(group.id),
          files: filesByGroup.get(group.id) ?? []
        })
      }
    }

    for (const entry of disabled) {
      if (seen.has(entry.groupId)) continue
      combined.push({
        groupId: entry.groupId,
        label: entry.label,
        enabled: false,
        hasScript: entriesById.get(entry.entryId)?.hasScript ?? false,
        source: entry.groupId.startsWith('cf:') ? 'curseforge' : null,
        fileCount: null,
        bytes: null,
        disabledEntry: entry,
        needsAttention: stuckById.has(entry.groupId),
        files: []
      })
      seen.add(entry.groupId)
    }

    for (const [groupId, entry] of stuckById) {
      if (seen.has(groupId)) continue
      combined.push({
        groupId,
        label: entry.groupLabel ?? 'A mod',
        enabled: false,
        hasScript: entry.hasScript,
        source: groupId.startsWith('cf:') ? 'curseforge' : null,
        fileCount: null,
        bytes: null,
        disabledEntry: null,
        needsAttention: true,
        files: []
      })
    }

    return combined
  }, [disabled, scan, groupEntries])

  const gameUpdatedAt = scan?.facts.gameUpdatedAt ?? null
  // The update filter is only offered when the update date is known; a filter that went away falls back to All.
  const activeFilter: ModsFilter = filter === 'older-than-update' && gameUpdatedAt === null ? 'all' : filter
  const filterChoices: ModsFilter[] =
    gameUpdatedAt === null ? ['all', 'scripts', 'set-aside'] : ['all', 'scripts', 'older-than-update', 'set-aside']

  const rows = useMemo(
    () => applyModsView(items, { query, filter: activeFilter, sort, gameUpdatedAt }),
    [items, query, activeFilter, sort, gameUpdatedAt]
  )
  const summary = useMemo(() => summarizeMods(items), [items])

  const toggleFiles = useCallback((groupId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

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
                label: entry.groupLabel ?? item.label,
                entryId: entry.id,
                at: entry.at,
                origin: entry.origin.by
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
          refusalState.refusal === 'unexpected'
            ? UNEXPECTED_COPY
            : refusalState.targetEnabled
              ? refusalMessage(refusalState.refusal)
              : setAsideRefusalMessage(refusalState.refusal, refusalState.label)
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
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground tabular-nums">
            {[
              plural(summary.groups, 'mod', 'mods'),
              plural(summary.scripts, 'script mod', 'script mods'),
              ...(scan ? [formatBytes(summary.bytes)] : []),
              `${summary.setAside.toLocaleString()} set aside`
            ].join(' · ')}
          </p>

          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your mods or paste a file name…"
              aria-label="Search your mods"
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
              {filterChoices.map((choice) => (
                <Button
                  key={choice}
                  variant={activeFilter === choice ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={activeFilter === choice}
                  onClick={() => setFilter(choice)}
                >
                  {FILTER_LABELS[choice]}
                </Button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Sort by</span>
              <select
                aria-label="Sort your mods"
                value={sort}
                onChange={(e) => setSort(e.target.value as ModsSort)}
                className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground shadow-xs"
              >
                {(Object.keys(SORT_LABELS) as ModsSort[]).map((choice) => (
                  <option key={choice} value={choice}>
                    {SORT_LABELS[choice]}
                  </option>
                ))}
              </select>
            </label>
          </div>
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

      {rows.length > 0 && (
        <section
          aria-label={!scan ? 'Mods currently set aside' : 'Installed and set-aside mods'}
          className="flex flex-col gap-2.5"
        >
          {!scan && (
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              Currently set aside
            </h2>
          )}

          {rows.map(({ item, matchedFile }) => {
            const isBusy = busyGroupId === item.groupId
            const isOpen = expanded.has(item.groupId)
            const listId = `mods-files-${idPart(item.groupId)}`
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

                    {matchedFile !== null && (
                      <p className="text-sm text-muted-foreground">Matched file: {matchedFile}</p>
                    )}
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

                {item.files.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-2 text-muted-foreground"
                        aria-expanded={isOpen}
                        aria-controls={listId}
                        aria-label={`Files (${item.files.length.toLocaleString()}) in ${item.label}`}
                        onClick={() => toggleFiles(item.groupId)}
                      >
                        {isOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                        Files ({item.files.length.toLocaleString()})
                      </Button>
                    </div>
                    {isOpen && (
                      <div id={listId} className="flex flex-col gap-1 pl-6">
                        <ul aria-label={`Files in ${item.label}`} className="flex flex-col gap-1">
                          {item.files.slice(0, FILE_LIST_CAP).map((file) => (
                            <li
                              key={file.relPath}
                              className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm"
                            >
                              <span className="min-w-0 break-all text-foreground">{file.relPath}</span>
                              <span className="shrink-0 text-muted-foreground tabular-nums">
                                {`${formatBytes(file.bytes)} · ${formatFileDate(file.modifiedAt)}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {item.files.length > FILE_LIST_CAP && (
                          <p className="text-sm text-muted-foreground">
                            and {(item.files.length - FILE_LIST_CAP).toLocaleString()} more
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )
          })}
        </section>
      )}

      {items.length > 0 && rows.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {query.trim() ? `No mods match “${query.trim()}”.` : 'No mods match this filter.'}
        </p>
      )}
    </main>
  )
}
