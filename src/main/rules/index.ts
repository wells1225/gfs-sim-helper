import type { Finding, Scan } from '../../shared/model.ts'
import { runAllRules } from './rules.ts'

export { readFolderFacts } from './facts.ts'

/** Pure: the findings for a scan, sorted stop, warn, info, then rule order. */
export function runRules(scan: Omit<Scan, 'findings'>): Finding[] {
  return runAllRules(scan)
}
