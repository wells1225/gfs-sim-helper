import { FileWarning } from 'lucide-react'
import type { IsoTime, LogKind, LogReport } from '../../shared/model.ts'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx'

const MAX_VISIBLE_LOGS = 20
const MAX_MESSAGE_CHARS = 140
const MAX_MOD_HINTS = 3

const LOG_KIND_LABEL: Record<LogKind, string> = {
  exception: 'Last exception',
  uiException: 'UI exception',
  crash: 'Game crash log',
  betterExceptions: 'Better Exceptions report',
  mccc: 'MC Command Center log'
}

function stripDashes(text: string): string {
  return text.replace(/[\u2014\u2013]/g, '-')
}

function formatLogDate(iso: IsoTime): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return stripDashes(iso)
  }
  try {
    return stripDashes(
      new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }).format(date)
    )
  } catch {
    return stripDashes(iso)
  }
}

const OS_ROOT_PREFIX = /^(?:[A-Za-z]:\/|\/\/|\/|(?:users|documents|onedrive|electronic arts|the sims 4)\/)/i

function formatLogFile(file: string): string {
  const normalized = stripDashes(file.replaceAll('\\', '/').trim())
  if (!OS_ROOT_PREFIX.test(normalized)) return normalized
  const simsFolderMatch = /(?:^|\/)the sims 4\/(.+)$/i.exec(normalized)
  if (simsFolderMatch?.[1]) {
    return simsFolderMatch[1]
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && !/^[A-Za-z]:$/.test(part))
  return parts.slice(-2).join('/') || normalized
}

function formatFirstMessageLine(message: string | null): string | null {
  if (message === null) return null
  const firstLine = message
    .split(/\r?\n|\r/)
    .map((line) => stripDashes(line.trim()))
    .find((line) => line.length > 0)

  if (!firstLine) return null
  if (firstLine.length <= MAX_MESSAGE_CHARS) return firstLine
  return `${firstLine.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd()}…`
}

function formatModHint(rawHint: string): string {
  const normalized = stripDashes(rawHint.replaceAll('\\', '/').trim())
  if (normalized === '') return ''
  if (!OS_ROOT_PREFIX.test(normalized)) return normalized
  const modsMatch = /(?:^|\/)mods\/(.+)$/i.exec(normalized)
  if (modsMatch?.[1]) {
    return modsMatch[1]
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && !/^[A-Za-z]:$/.test(part))
  return parts.slice(-2).join('/')
}

function collectModHints(rawHints: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of rawHints) {
    const formatted = formatModHint(raw)
    if (formatted.length === 0 || seen.has(formatted)) continue
    seen.add(formatted)
    out.push(formatted)
    if (out.length >= MAX_MOD_HINTS) break
  }
  return out
}

export function RecentErrorsCard({ logs }: { logs: LogReport[] }) {
  if (logs.length === 0) return null

  const visibleLogs = logs.slice(0, MAX_VISIBLE_LOGS)
  const remainingCount = logs.length - visibleLogs.length
  const summaryText =
    logs.length === 1
      ? '1 crash or exception log found in your Sims 4 folder.'
      : `${logs.length.toLocaleString('en-US')} crash or exception logs found in your Sims 4 folder.`

  return (
    <Card className="gap-3 p-5">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileWarning className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <CardTitle className="text-base font-semibold leading-snug text-foreground">
              Recent game errors
            </CardTitle>
            <Badge variant="secondary" className="tabular-nums">
              {logs.length.toLocaleString('en-US')}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="gap-2.5">
        <p className="text-sm leading-relaxed text-foreground/90 tabular-nums">{summaryText}</p>

        <Accordion type="single" collapsible>
          <AccordionItem value="recent-logs" className="border-t border-border border-b-0">
            <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground">
              See recent logs
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-2.5 rounded-lg bg-muted/40 p-3.5">
                <ul className="space-y-2.5">
                  {visibleLogs.map((log, idx) => {
                    const kindLabel = LOG_KIND_LABEL[log.kind]
                    const formattedDate = formatLogDate(log.fileModifiedAt)
                    const messageLine = formatFirstMessageLine(log.message)
                    const modHints = collectModHints(log.modHints)

                    return (
                      <li
                        key={`${idx}-${log.file}-${log.kind}-${log.categoryId ?? ''}`}
                        className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary" className="px-2 py-0 text-[0.6875rem] font-semibold">
                              {kindLabel}
                            </Badge>
                            <span className="break-all font-mono text-xs text-foreground/90">
                              {formatLogFile(log.file)}
                            </span>
                            {log.count > 1 && (
                              <Badge variant="outline" className="px-2 py-0 text-[0.6875rem] tabular-nums">
                                {log.count.toLocaleString('en-US')} times
                              </Badge>
                            )}
                            {log.completeness === 'cut-off' && (
                              <Badge
                                variant="outline"
                                className="px-2 py-0 text-[0.6875rem] font-normal text-muted-foreground"
                              >
                                Cut off
                              </Badge>
                            )}
                          </div>

                          <span className="text-xs text-muted-foreground tabular-nums">{formattedDate}</span>
                        </div>

                        {messageLine && (
                          <p className="truncate font-mono text-xs text-muted-foreground" title={messageLine}>
                            {messageLine}
                          </p>
                        )}

                        {modHints.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            <span className="text-xs text-muted-foreground">Mentioned in log:</span>
                            {modHints.map((hint, hintIdx) => (
                              <Badge
                                key={`${hintIdx}-${hint}`}
                                variant="secondary"
                                className="px-2 py-0 font-mono text-[0.6875rem] font-normal"
                              >
                                {hint}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>

                {remainingCount > 0 && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    and {remainingCount.toLocaleString('en-US')} more
                  </p>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  )
}
