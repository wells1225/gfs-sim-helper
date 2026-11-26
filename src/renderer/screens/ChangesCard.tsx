import { History } from 'lucide-react'
import type { ChangedModItem, IsoTime, ScanChanges } from '../../shared/model.ts'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx'

const MAX_ITEMS_PER_CATEGORY = 15

export function hasScanChanges(changes: ScanChanges | null | undefined): changes is ScanChanges {
  if (!changes) return false
  return (
    changes.gameVersion !== null ||
    changes.added.length > 0 ||
    changes.updated.length > 0 ||
    changes.removed.length > 0
  )
}

function formatSinceDate(iso: IsoTime): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

function formatModCount(count: number, verb: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'mod' : 'mods'} ${verb}`
}

function buildSummaryParts(changes: ScanChanges): string[] {
  const parts: string[] = []
  if (changes.gameVersion) {
    parts.push(`Game updated from ${changes.gameVersion.from} to ${changes.gameVersion.to}`)
  }
  if (changes.added.length > 0) {
    parts.push(formatModCount(changes.added.length, 'added'))
  }
  if (changes.updated.length > 0) {
    parts.push(formatModCount(changes.updated.length, 'updated'))
  }
  if (changes.removed.length > 0) {
    parts.push(formatModCount(changes.removed.length, 'removed'))
  }
  return parts
}

export function ChangesCard({ changes }: { changes?: ScanChanges | null }) {
  if (!hasScanChanges(changes)) return null

  const sinceDate = formatSinceDate(changes.sinceAt)
  const summaryParts = buildSummaryParts(changes)
  const categories: Array<{ key: string; title: string; items: ChangedModItem[] }> = [
    { key: 'added', title: 'Added', items: changes.added },
    { key: 'updated', title: 'Updated', items: changes.updated },
    { key: 'removed', title: 'Removed', items: changes.removed }
  ].filter((category) => category.items.length > 0)

  return (
    <Card className="gap-3 p-5">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <CardTitle className="text-base font-semibold leading-snug text-foreground">
              What changed since your last check-up
            </CardTitle>
          </div>
          {sinceDate && (
            <span className="text-xs text-muted-foreground tabular-nums">Since your check-up on {sinceDate}</span>
          )}
        </div>
      </CardHeader>

      <CardContent className="gap-2.5">
        <p className="text-sm leading-relaxed text-foreground/90 tabular-nums">{summaryParts.join(' · ')}</p>

        {categories.length > 0 && (
          <Accordion type="single" collapsible>
            <AccordionItem value="changed-mods" className="border-t border-border border-b-0">
              <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground">
                See changed mods
              </AccordionTrigger>
              <AccordionContent>
                <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3.5">
                  {categories.map((category) => {
                    const visible = category.items.slice(0, MAX_ITEMS_PER_CATEGORY)
                    const remaining = category.items.length - visible.length
                    return (
                      <div key={category.key} className="flex flex-col gap-1.5">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">
                          {category.title} ({category.items.length.toLocaleString('en-US')})
                        </p>
                        <ul className="space-y-1 text-sm text-foreground/90">
                          {visible.map((item) => (
                            <li key={item.groupId} className="flex flex-wrap items-center gap-2">
                              <span className="break-words">{item.label}</span>
                              {item.hasScript && (
                                <Badge variant="secondary" className="px-2 py-0 text-[0.6875rem] font-medium">
                                  Script mod
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                        {remaining > 0 && (
                          <p className="text-xs text-muted-foreground tabular-nums">
                            and {remaining.toLocaleString('en-US')} more
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </CardContent>
    </Card>
  )
}
