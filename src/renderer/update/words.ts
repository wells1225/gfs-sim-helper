import type { UpdateState } from '../../shared/model.ts'

// Every word the update banner and the About row show. Research file fable-auto-update.md, section 4, word for word.
export const WORDS = {
  available: 'A new version of Sims Helper is ready.',
  updateNow: 'Update now',
  later: 'Later',
  downloading: (percent: number) => `Getting the update… ${percent}%`,
  ready: 'The update is ready. Sims Helper will close and open again to finish.',
  restartNow: 'Restart now',
  restarting: 'Closing Sims Helper to finish the update…',
  busy: 'Sims Helper is in the middle of a change. Wait for it to finish, then try again.',
  downloadFailed: "The update didn't download. Nothing changed.",
  tryAgain: 'Try again',
  updated: 'Sims Helper was updated.',
  version: (version: string) => `Version ${version}`,
  checkForUpdates: 'Check for updates',
  checking: 'Checking…',
  newest: 'You have the newest version.',
  couldNotCheck: "Couldn't check right now. Try again later.",
  foundOne: 'A new version is ready. You’ll find it at the top of this page.'
} as const

export const OFF_NOTE: Record<Extract<UpdateState, { state: 'off' }>['why'], string> = {
  'not-installed-app': 'Updates work only in the installed Sims Helper.',
  'switched-off': 'Updates are switched off on this PC.',
  'unsafe-install-folder':
    'Updates are off because Sims Helper is installed in a folder that isn’t safe to update, like Documents or OneDrive. Reinstall it in the folder Setup suggests to get updates.'
}
