import type { BackupResult, BackupStatus, FixOutcome, JournalEntry } from '../../shared/model.ts'
import type { ActionPlan, OnProgress, SafetyDeps } from '../ports.ts'

export async function backupStatus(_deps: SafetyDeps, _folderPath: string): Promise<BackupStatus> {
  throw new Error('not implemented: backupStatus')
}

export async function createBackup(
  _deps: SafetyDeps,
  _folderPath: string,
  _onProgress?: OnProgress
): Promise<BackupResult> {
  throw new Error('not implemented: createBackup')
}

export async function runAction(
  _deps: SafetyDeps,
  _plan: ActionPlan,
  _onProgress?: OnProgress
): Promise<FixOutcome> {
  throw new Error('not implemented: runAction')
}

export async function undo(
  _deps: SafetyDeps,
  _entryId: string,
  _onProgress?: OnProgress
): Promise<FixOutcome> {
  throw new Error('not implemented: undo')
}

export async function listJournal(_deps: SafetyDeps): Promise<JournalEntry[]> {
  throw new Error('not implemented: listJournal')
}

export async function recover(_deps: SafetyDeps): Promise<JournalEntry[]> {
  throw new Error('not implemented: recover')
}
