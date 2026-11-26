import { AlertTriangle, Info } from 'lucide-react'
import type { Inventory, ModFile } from '../../shared/model.ts'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'

const MAX_ITEMS_PER_LIST = 20

type UnreadableReason =
  | 'Package could not be read'
  | 'Script mod could not be read'
  | 'Could not compare duplicate file'

interface UnreadableItem {
  relPath: string
  reason: UnreadableReason
}

interface SkippedItem {
  relPath: string
  reason: 'Skipped folder or file'
}

const OS_ROOT_PREFIX = /^(?:[A-Za-z]:\/|\/\/|\/|(?:users|documents|onedrive|electronic arts|the sims 4)\/)/i

function safeRelPath(relPath: string): string {
  const normalized = relPath.replaceAll('\\', '/').replace(/[\u2014\u2013]/g, '-').trim()
  if (normalized === '') return 'Mods'
  if (!OS_ROOT_PREFIX.test(normalized)) return normalized
  const modsMatch = /(?:^|\/)mods\/(.+)$/i.exec(normalized)
  if (modsMatch?.[1]) {
    return modsMatch[1]
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && !/^[A-Za-z]:$/.test(part))
  return parts.slice(-2).join('/') || 'Mods'
}

function unreadableReasonFor(file: ModFile): UnreadableReason | null {
  if (file.kind === 'package' && file.dbpf.status === 'unreadable') {
    return 'Package could not be read'
  }
  if (file.kind === 'script' && file.script.status === 'unreadable') {
    return 'Script mod could not be read'
  }
  if (file.hash.status === 'unreadable') {
    return 'Could not compare duplicate file'
  }
  return null
}

function collectUnreadableFiles(files: readonly ModFile[]): UnreadableItem[] {
  const seen = new Set<string>()
  const out: UnreadableItem[] = []

  for (const file of files) {
    const reason = unreadableReasonFor(file)
    if (reason === null) continue
    const cleanPath = safeRelPath(file.relPath)
    if (seen.has(cleanPath)) continue
    seen.add(cleanPath)
    out.push({ relPath: cleanPath, reason })
  }

  return out
}

function collectSkipped(skipped: Inventory['skipped']): SkippedItem[] {
  return skipped.map((entry) => ({
    relPath: safeRelPath(entry.relPath),
    reason: 'Skipped folder or file'
  }))
}

function formatSkippedCount(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'folder or file skipped' : 'folders or files skipped'}`
}

function formatUnreadableCount(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'mod file could not be read' : 'mod files could not be read'}`
}

export function CoverageNotice({ inventory }: { inventory: Inventory }) {
  const skippedItems = collectSkipped(inventory.skipped)
  const unreadableItems = collectUnreadableFiles(inventory.files)
  const hasCoverageGaps = skippedItems.length > 0 || unreadableItems.length > 0

  if (inventory.modsDirState === 'present' && !hasCoverageGaps) {
    return null
  }

  if (inventory.modsDirState === 'missing' && !hasCoverageGaps) {
    return (
      <Alert variant="info">
        <div className="flex items-start gap-2.5">
          <Info className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <AlertTitle>No Mods folder was found in this Sims 4 folder yet</AlertTitle>
            <AlertDescription>
              The game makes a Mods folder the first time it opens. Because there is no Mods folder here yet, no mod
              files were checked. If your mods live in another Sims 4 folder, pick that folder instead.
            </AlertDescription>
          </div>
        </div>
      </Alert>
    )
  }

  const summaryParts: string[] = []
  if (skippedItems.length > 0) {
    summaryParts.push(formatSkippedCount(skippedItems.length))
  }
  if (unreadableItems.length > 0) {
    summaryParts.push(formatUnreadableCount(unreadableItems.length))
  }

  const visibleSkipped = skippedItems.slice(0, MAX_ITEMS_PER_LIST)
  const remainingSkipped = skippedItems.length - visibleSkipped.length
  const visibleUnreadable = unreadableItems.slice(0, MAX_ITEMS_PER_LIST)
  const remainingUnreadable = unreadableItems.length - visibleUnreadable.length

  return (
    <Alert variant="warn" className="gap-2">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <AlertTitle>Some items could not be checked</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            <p className="font-medium tabular-nums">{summaryParts.join(' · ')}</p>
            <p>
              A clean check-up only covers the files that could be read.
              {inventory.modsDirState === 'missing'
                ? ' No Mods folder was found in this Sims 4 folder either.'
                : ' If another program or OneDrive is using them, close it and check again.'}
            </p>
          </AlertDescription>
        </div>
      </div>

      <Accordion type="single" collapsible>
        <AccordionItem value="coverage-items" className="border-t border-current/20 border-b-0">
          <AccordionTrigger className="py-2 text-xs font-medium text-current/85 hover:text-current">
            See what could not be checked
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3 rounded-lg bg-card/85 p-3.5 text-foreground">
              {visibleSkipped.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">
                    Skipped ({skippedItems.length.toLocaleString('en-US')})
                  </p>
                  <ul className="space-y-1.5 text-sm text-foreground/90">
                    {visibleSkipped.map((item, idx) => (
                      <li key={`${idx}-${item.relPath}`} className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-xs">{item.relPath}</span>
                        <Badge variant="secondary" className="px-2 py-0 text-[0.6875rem] font-medium">
                          {item.reason}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {remainingSkipped > 0 && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      and {remainingSkipped.toLocaleString('en-US')} more
                    </p>
                  )}
                </div>
              )}

              {visibleUnreadable.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">
                    Could not be read ({unreadableItems.length.toLocaleString('en-US')})
                  </p>
                  <ul className="space-y-1.5 text-sm text-foreground/90">
                    {visibleUnreadable.map((item, idx) => (
                      <li key={`${idx}-${item.relPath}`} className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-xs">{item.relPath}</span>
                        <Badge variant="secondary" className="px-2 py-0 text-[0.6875rem] font-medium">
                          {item.reason}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {remainingUnreadable > 0 && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      and {remainingUnreadable.toLocaleString('en-US')} more
                    </p>
                  )}
                </div>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Alert>
  )
}
