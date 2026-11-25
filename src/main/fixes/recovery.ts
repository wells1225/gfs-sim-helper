import type { JournalEntry } from '../../shared/model.ts'
import type { Safety } from '../ports.ts'

/** What the start-up recovery did: the entries it settled, or that it could not run at all. */
export type StartupRecovery = { status: 'finished'; touched: JournalEntry[] } | { status: 'failed' }

const started = new WeakMap<object, Promise<StartupRecovery>>()

/**
 * Puts back a change that a crash cut off, once per context, when main starts (AGENTS.md: the one thing the app
 * does without a click). safety.recover() checks the backup first, holds busy() and takes the safety lock, so any
 * later action or undo waits behind it. Never throws and never rejects: a failed run leaves the entries in
 * progress, and History still lists them.
 */
export function startRecovery(safety: Pick<Safety, 'recover'>): Promise<StartupRecovery> {
  const already = started.get(safety)
  if (already) return already
  let run: Promise<JournalEntry[]>
  try {
    run = safety.recover()
  } catch (err) {
    run = Promise.reject(err)
  }
  const kept = run.then(
    (touched): StartupRecovery => ({ status: 'finished', touched }),
    (): StartupRecovery => ({ status: 'failed' })
  )
  started.set(safety, kept)
  return kept
}
