import type {
  BackupRefusal,
  FixId,
  FixRefusal,
  GateRefusal,
  IsoTime,
  JournalEntry,
  Progress
} from '../../shared/model.ts'

export const FIX_BUTTON_LABEL: Record<FixId, string> = {
  'turn-mods-on': 'Turn mods back on',
  'move-script-up': 'Move it up a folder',
  'move-package-up': 'Move it up a folder',
  'set-aside-files': 'Set aside',
  'clear-caches': 'Clear temporary cache',
  'disable-group': 'Set aside',
  'enable-group': 'Put back'
}

export interface RefusalCopy {
  title: string
  detail: string
  canRetry: boolean
  tone: 'warn' | 'destructive' | 'info'
}

function gateRefusalMessage(refusal: GateRefusal): RefusalCopy {
  switch (refusal.reason) {
    case 'game-running':
      return {
        title: 'The Sims 4 is still open',
        detail: 'The Sims 4 is still open. Save and close the game, then try again.',
        canRetry: true,
        tone: 'warn'
      }
    case 'game-state-unknown':
      return {
        title: 'Could not check whether The Sims 4 is open',
        detail:
          'We could not tell whether The Sims 4 is open right now, so nothing was changed. Make sure the game is closed, then try again.',
        canRetry: true,
        tone: 'warn'
      }
    case 'saves-or-tray':
      return {
        title: 'Stopped to protect your saves',
        detail: 'Your saves and households are never touched, so nothing was changed.',
        canRetry: false,
        tone: 'destructive'
      }
    case 'outside-allowed-area':
      return {
        title: 'File is outside your Mods folder',
        detail:
          'For safety, fixes only touch your Mods folder, temporary caches, and game settings. Nothing was changed.',
        canRetry: false,
        tone: 'destructive'
      }
    case 'link-escape':
      return {
        title: 'Skipped a linked folder',
        detail: 'One of those files points outside your Sims 4 folder, so nothing was changed.',
        canRetry: false,
        tone: 'warn'
      }
    case 'not-a-sims-folder':
      return {
        title: 'Sims 4 folder not recognized',
        detail:
          'That folder no longer looks like a Sims 4 folder, so nothing was changed. Go back and pick your Sims 4 folder again, then try again.',
        canRetry: false,
        tone: 'destructive'
      }
    case 'check-failed':
      return {
        title: 'A safety check did not finish',
        detail: 'Something got in the way of a safety check, so nothing was changed. Try again in a moment.',
        canRetry: true,
        tone: 'warn'
      }
    case 'no-verified-backup':
      return {
        title: 'A safety copy is needed first',
        detail: 'A verified safety copy is needed before any file moves. Nothing was changed, so please try again.',
        canRetry: true,
        tone: 'warn'
      }
  }
}

function backupRefusalMessage(reason: BackupRefusal | 'backup-failed'): RefusalCopy {
  switch (reason) {
    case 'game-running':
      return {
        title: 'The Sims 4 is still open',
        detail: 'The Sims 4 is still open. Save and close the game, then try again.',
        canRetry: true,
        tone: 'warn'
      }
    case 'game-state-unknown':
      return {
        title: 'Could not check whether The Sims 4 is open',
        detail:
          'We could not tell whether The Sims 4 is open right now, so nothing was changed. Make sure the game is closed, then try again.',
        canRetry: true,
        tone: 'warn'
      }
    case 'backup-folder-in-onedrive':
      return {
        title: 'Safety copy folder is inside OneDrive',
        detail:
          'Your safety copy folder is synced by OneDrive, which can interrupt backups. Nothing in your Sims folder was changed. Tell Tyler so he can move it out of OneDrive.',
        canRetry: false,
        tone: 'warn'
      }
    case 'backup-folder-in-sims-folder':
      return {
        title: 'Safety copy folder is inside your Sims folder',
        detail:
          'The safety copy cannot be kept inside your Sims 4 folder. Nothing in your Sims folder was changed. Tell Tyler so he can fix the setup.',
        canRetry: false,
        tone: 'warn'
      }
    case 'not-enough-space':
      return {
        title: 'Not enough free space for a safety copy',
        detail:
          'There is not enough free disk space to make a safety copy first. Free up a little space, then try again.',
        canRetry: true,
        tone: 'warn'
      }
    case 'sims-folder-missing':
      return {
        title: 'Could not find your Sims 4 folder',
        detail:
          'Your Sims 4 folder could not be found right now, so nothing was changed. Make sure the folder is still there, or pick it again.',
        canRetry: true,
        tone: 'warn'
      }
    case 'backup-already-running':
      return {
        title: 'A safety copy is already running',
        detail: 'Wait a moment for the current safety copy to finish, then try again.',
        canRetry: true,
        tone: 'info'
      }
    case 'backup-failed':
      return {
        title: 'Could not finish the safety copy',
        detail:
          'The safety copy did not finish cleanly, so nothing in your Sims folder was changed. Please try again.',
        canRetry: true,
        tone: 'warn'
      }
  }
}

/** Shown when a call fails with an error instead of an answer. The error text itself is never shown. */
export const UNEXPECTED_COPY: RefusalCopy = {
  title: 'Something went wrong',
  detail: 'Sims Helper could not finish that. Your saves are safe, and History shows anything that changed. Try again.',
  canRetry: true,
  tone: 'warn'
}

/** Shown when a list could not be read, so an error never looks like an empty list. */
export const LOAD_FAILED_COPY = {
  title: "Couldn't load this right now",
  detail: 'Nothing was changed. Try again in a moment.'
} as const

export function refusalMessage(refusal: FixRefusal): RefusalCopy {
  switch (refusal.why) {
    case 'gate':
      return gateRefusalMessage(refusal.refusal)
    case 'backup':
      return backupRefusalMessage(refusal.reason)
    case 'out-of-date': {
      switch (refusal.detail) {
        case 'no-scan':
          return {
            title: 'Run a check-up first',
            detail: 'Run a check-up so we have a fresh look at your Mods folder, then try again.',
            canRetry: false,
            tone: 'info'
          }
        case 'unknown-finding':
          return {
            title: 'This check-up is out of date',
            detail: 'Run a fresh check-up to see what still needs fixing.',
            canRetry: false,
            tone: 'info'
          }
        case 'unknown-group':
          return {
            title: 'That mod is no longer in the list',
            detail: 'Run a fresh check-up to refresh your mods list.',
            canRetry: false,
            tone: 'info'
          }
        case 'file-changed':
          return {
            title: 'Your files changed since the last check-up',
            detail:
              'A file moved or another file is already in that spot, so nothing was changed. Run a fresh check-up first.',
            canRetry: false,
            tone: 'warn'
          }
        case 'nothing-to-do':
          return {
            title: 'Already taken care of',
            detail: 'There is nothing left to change for this item.',
            canRetry: false,
            tone: 'info'
          }
      }
    }
    case 'fifty-fifty-running':
      return {
        title: 'A 50/50 test is in progress',
        detail: 'Finish or stop your 50/50 test before making other changes to your mods.',
        canRetry: true,
        tone: 'warn'
      }
    case 'not-started':
      // Also the answer after a set-aside stopped part way and was put straight back, so it says only what holds then.
      return {
        title: "That didn't go through",
        detail: 'Your mods are just as they were. Try again in a moment.',
        canRetry: true,
        tone: 'warn'
      }
  }
}

/** Your mods: the same words, except that a set-aside which did not go through says so by name. */
export function setAsideRefusalMessage(refusal: FixRefusal, label: string): RefusalCopy {
  const copy = refusalMessage(refusal)
  return refusal.why === 'not-started' ? { ...copy, title: `${label} was not set aside` } : copy
}

export function progressCopy(progress: Progress | null): {
  heading: string
  detail: string | null
  percent: number | null
} {
  if (!progress || progress.task === 'backup') {
    const heading = 'Making a safety copy first…'
    if (!progress) {
      return { heading, detail: null, percent: null }
    }
    const percent =
      progress.total !== null && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : null
    if (progress.total === null) {
      return { heading, detail: 'Counting files to protect…', percent: null }
    }
    const verb = progress.stage === 'checking' ? 'Checking' : 'Copying'
    return {
      heading,
      detail: `${verb} ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} files`,
      percent
    }
  }

  const percent =
    progress.total !== null && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null
  return {
    heading: progress.stage === 'moving' ? 'Moving files safely…' : 'Applying fix…',
    detail:
      progress.total !== null
        ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} steps`
        : null,
    percent
  }
}

export function formatEntryTimestamp(iso: IsoTime, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDay(date, now)) {
    return `Today at ${timePart}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) {
    return `Yesterday at ${timePart}`
  }

  const datePart = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric'
  }).format(date)
  return `${datePart} at ${timePart}`
}

export function formatStepSummary(entry: JournalEntry): string {
  const count = entry.steps.length
  if (count === 0) return 'No files changed'
  if (entry.steps.every((s) => s.kind === 'edit')) {
    return 'Game settings updated'
  }
  if (entry.steps.every((s) => s.kind === 'remove-cache')) {
    return count === 1 ? '1 cache item' : `${count.toLocaleString()} cache items`
  }
  return count === 1 ? '1 file' : `${count.toLocaleString()} files`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}
