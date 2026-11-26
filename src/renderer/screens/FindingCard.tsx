import {
  AlertTriangle,
  FileText,
  FileWarning,
  FlaskConical,
  Info,
  ShieldAlert,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { useState } from 'react'
import type { Certainty, Finding, Severity } from '../../shared/model.ts'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion.tsx'
import { Badge, type BadgeProps } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { FindingActions } from '../fixes/FindingActions.tsx'

const MAX_VISIBLE_FILES = 5

const SEVERITY_CARD_STYLE: Record<Severity, { border: string; iconColor: string; icon: LucideIcon }> = {
  stop: {
    border: 'border-l-4 border-l-severity-stop',
    iconColor: 'text-severity-stop',
    icon: ShieldAlert
  },
  warn: {
    border: 'border-l-4 border-l-severity-warn',
    iconColor: 'text-severity-warn',
    icon: AlertTriangle
  },
  info: {
    border: 'border-l-4 border-l-severity-info',
    iconColor: 'text-severity-info',
    icon: Info
  }
}

const CERTAINTY_META: Record<
  Certainty,
  { label: string; icon: LucideIcon; variant: NonNullable<BadgeProps['variant']> }
> = {
  'file-problem': {
    label: 'File problem found',
    icon: FileWarning,
    variant: 'destructive'
  },
  likely: {
    label: 'Likely cause',
    icon: Sparkles,
    variant: 'warn'
  },
  'worth-testing': {
    label: 'Worth testing',
    icon: FlaskConical,
    variant: 'info'
  }
}

export function FindingCard({ finding }: { finding: Finding }) {
  const [showAllFiles, setShowAllFiles] = useState(false)
  const severityStyle = SEVERITY_CARD_STYLE[finding.severity]
  const SeverityIcon = severityStyle.icon
  const certainty = CERTAINTY_META[finding.certainty]
  const CertaintyIcon = certainty.icon

  const visibleFiles = showAllFiles ? finding.files : finding.files.slice(0, MAX_VISIBLE_FILES)
  const hiddenCount = finding.files.length - visibleFiles.length

  return (
    <Card
      role={finding.severity === 'stop' ? 'alert' : undefined}
      className={`gap-3.5 ${severityStyle.border}`}
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2.5">
            <SeverityIcon className={`mt-0.5 size-5 shrink-0 ${severityStyle.iconColor}`} strokeWidth={1.75} />
            <CardTitle className="text-base font-semibold leading-snug text-foreground">
              {finding.title}
            </CardTitle>
          </div>

          <Badge variant={certainty.variant}>
            <CertaintyIcon className="size-3.5" strokeWidth={1.75} />
            {certainty.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="gap-3">
        <p className="text-[0.9375rem] leading-relaxed text-foreground/90">{finding.detail}</p>

        <FindingActions finding={finding} />

        {finding.files.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">
              <FileText className="size-3.5" strokeWidth={1.75} />
              Affected files ({finding.files.length})
            </p>
            <ul className="space-y-1 text-sm text-foreground/90">
              {visibleFiles.map((file) => (
                <li key={file} className="break-all">
                  {file}
                </li>
              ))}
            </ul>
            {finding.files.length > MAX_VISIBLE_FILES && (
              <Button
                variant="link"
                size="sm"
                className="mt-1 h-auto px-0 py-0.5 text-xs"
                onClick={() => setShowAllFiles((prev) => !prev)}
              >
                {showAllFiles ? 'Show fewer files' : `Show ${hiddenCount} more files`}
              </Button>
            )}
          </div>
        )}

        {finding.evidence.length > 0 && (
          <Accordion type="single" collapsible>
            <AccordionItem value="technical-details" className="border-t border-border border-b-0">
              <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground">
                Technical details
              </AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-1 rounded-lg bg-muted/60 p-3 font-mono text-xs text-foreground/90">
                  {finding.evidence.map((line, idx) => (
                    <li key={`${idx}-${line}`} className="break-all">
                      {line}
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </CardContent>
    </Card>
  )
}
