import type { BackupPruneResult, BackupResult, BackupStatus, BackupSummary, FixOutcome, JournalEntry } from '../../shared/model.ts'
import type { ActionPlan, OnProgress, SafetyDeps } from '../ports.ts'
import { recoverNow, runActionNow, undoNow } from './actions.ts'
import { backupInFlight, backupStatus as checkBackup, makeBackup, tracked } from './backup.ts'
import { listEntries } from './journal.ts'
import { oneAtATime } from './lock.ts'
import { pruneBackupsNow, readBackupSummary } from './prune.ts'

// backupStatus never waits for the lock: the gate asks it in the middle of runAction and undo.
export async function backupStatus(deps: SafetyDeps, folderPath: string): Promise<BackupStatus> {
  return await checkBackup(deps, folderPath)
}

export async function backupSummary(deps: SafetyDeps, folderPath: string | null): Promise<BackupSummary> {
  return await oneAtATime(deps, () => readBackupSummary(deps, folderPath))
}

export async function pruneBackups(deps: SafetyDeps, folderPath: string | null): Promise<BackupPruneResult> {
  if (backupInFlight(deps)) return { status: 'refused', why: 'busy' }
  return await oneAtATime(deps, () => pruneBackupsNow(deps, folderPath))
}

export async function createBackup(deps: SafetyDeps, folderPath: string, onProgress?: OnProgress): Promise<BackupResult> {
  if (backupInFlight(deps)) return { status: 'refused', reason: 'backup-already-running' }
  return await tracked(deps, () => oneAtATime(deps, () => makeBackup(deps, folderPath, onProgress)))
}

export async function runAction(deps: SafetyDeps, plan: ActionPlan, onProgress?: OnProgress): Promise<FixOutcome> {
  return await oneAtATime(deps, () => runActionNow(deps, plan, onProgress))
}

export async function undo(deps: SafetyDeps, entryId: string, onProgress?: OnProgress): Promise<FixOutcome> {
  return await oneAtATime(deps, () => undoNow(deps, entryId, onProgress))
}

export async function listJournal(deps: SafetyDeps): Promise<JournalEntry[]> {
  return await listEntries(deps.paths.journalDir)
}

export async function recover(deps: SafetyDeps, onProgress?: OnProgress): Promise<JournalEntry[]> {
  return await oneAtATime(deps, async () => await recoverNow(deps, await listEntries(deps.paths.journalDir), onProgress))
}
