import type { FixRefusal, ModFolderState, ModRequestSent } from '../../shared/model.ts'
import { refusalMessage, type RefusalCopy } from '../fixes/words.ts'

export const MAX_REQUEST_CHARS = 2000

export const BROKEN_DELIVERY_COPY = "This one didn't arrive properly. Tyler has been told."
export const SCRIPT_MOD_COPY = 'This mod needs script mods turned on in Game Options.'
export const SENT_CONFIRMATION_COPY = 'Sent. Tyler will get an email.'
export const INSTALL_SYNCING_COPY =
  "This mod hasn't finished downloading. Wait a minute for Google Drive, then try again."

export function countChars(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}

export function folderProblemCopy(state: Exclude<ModFolderState, { kind: 'set' | 'not-set' }>): {
  title: string
  detail: string
} {
  switch (state.kind) {
    case 'missing':
      return {
        title: "Can't find the Sims Helper Mods folder right now",
        detail:
          'Make sure Google Drive for desktop is open and signed in, then check again or pick the folder again.'
      }
    case 'wrong-name':
      return {
        title: "That folder can't be used",
        detail:
          'Pick the Sims Helper Mods folder in Google Drive, not a link or system folder. Nothing was saved yet.'
      }
    case 'in-sims-folder':
      return {
        title: 'Pick the Google Drive folder instead',
        detail:
          'Pick the Sims Helper Mods folder from Google Drive, not a folder inside The Sims 4. Nothing was saved yet.'
      }
  }
}

export function installRefusalMessage(refusal: FixRefusal): RefusalCopy {
  if (refusal.why === 'out-of-date' && refusal.detail === 'file-changed') {
    return {
      title: "This mod hasn't finished downloading",
      detail: INSTALL_SYNCING_COPY,
      canRetry: true,
      tone: 'warn'
    }
  }
  return refusalMessage(refusal)
}

export function sendRefusalCopy(why: Extract<ModRequestSent, { kind: 'refused' }>['why']): string {
  switch (why) {
    case 'empty':
      return 'Write a short note about what you would like the mod to do first.'
    case 'too-long':
      return 'Your note is over 2,000 characters. Shorten it a little, then send again.'
    case 'no-folder':
      return 'Your Sims Helper Mods folder is not connected right now. Pick the folder again to send your request.'
    case 'error':
      return 'Could not save your request to the shared folder. Make sure Google Drive is open and try again.'
  }
}
