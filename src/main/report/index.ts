import type { ReportResult, Scan } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'

export function planReport(
  _scan: Scan,
  _redact: (text: string) => string
): { name: string; source: { file: string } | { json: unknown } }[] {
  throw new Error('not implemented: planReport')
}

export async function buildReport(
  _deps: Pick<AppContext, 'gate' | 'paths' | 'clock' | 'redact'>,
  _scan: Scan
): Promise<{ result: ReportResult; file: string | null }> {
  throw new Error('not implemented: buildReport')
}
