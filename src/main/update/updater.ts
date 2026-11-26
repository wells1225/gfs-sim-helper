// The only file that loads electron-updater (contracts.md, section 1, the named exception). The app is unsigned,
// so nothing but GitHub vouches for an update, and this file decides whether one is fetched and whether its
// installer is started. The rules, each with a test in updater.test.ts:
//   - Nothing is downloaded until download() is called, and nothing is installed until install() is called.
//   - The feed is the one baked into the installed app (resources/app-update.yml: the GitHub provider for
//     wells1225/gfs-sim-helper). Nothing here can point it anywhere else; SIMS_HELPER_UPDATES=off only switches it off.
//   - Only a published, plain x.y.z version higher than this one is offered.
//   - No state and no thrown error holds text from the network or from an error.
//   - A check that gets no answer in two minutes is a failed check, and a later answer changes nothing.
// Written against electron-updater 6.8.11 as installed (docs/research/fable-auto-update.md, section 0).
import electronUpdater from 'electron-updater'
import { win32 } from 'node:path'
import type { UpdateInstall, UpdateState } from '../../shared/model.ts'
import type { Updater, UpdaterInput } from '../ports.ts'

/** The part of electron-updater's autoUpdater this file uses. Tests pass a fake. */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  disableWebInstaller: boolean
  disableDifferentialDownload: boolean
  forceDevUpdateConfig: boolean
  requestHeaders: Record<string, number | string | string[] | undefined> | null
  logger: { info(message?: unknown): void; warn(message?: unknown): void; error(message?: unknown): void } | null
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export interface UpdaterSeams {
  engine?: () => UpdateEngine // tests only; the default is electron-updater's autoUpdater
  busy?: () => boolean // AppContext.busy(): true while a fix, backup or 50/50 step runs
  now?: () => Date
}

type OffReason = Extract<UpdateState, { state: 'off' }>['why']
type FailReason = Extract<UpdateState, { state: 'failed' }>['why']

// The engine sends a random id, kept in a file on her PC, as this header on every check. Setting the header here
// replaces the value, so the id never leaves her PC. The name must stay lower-case: the engine merges by exact name.
const REQUEST_HEADERS = { 'x-user-staging-id': '0' } as const

const SILENT_LOGGER = { info(): void {}, warn(): void {}, error(): void {} }

// A check with no answer by then is a failed check, so she can try again instead of watching it check for ever.
const CHECK_GIVES_UP_AFTER_MS = 2 * 60 * 1000

const PLAIN_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

const BAD_FILE_CODES: readonly unknown[] = ['ERR_CHECKSUM_MISMATCH', 'ERR_UPDATER_INVALID_SIGNATURE']
const OFFLINE_CODES: readonly unknown[] = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH'
]
// Chromium's network errors and the engine's own timeout. An error from the check can wrap the first one in its text.
const OFFLINE_TEXT =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_|ADDRESS_UNREACHABLE|CONNECTION_|TIMED_OUT|PROXY_CONNECTION_FAILED)|^Request timed out$/

/** The three numbers of a plain x.y.z version, or null for anything else: a prerelease, a 'v', a missing part. */
function versionParts(version: unknown): [number, number, number] | null {
  const match = typeof version === 'string' ? PLAIN_VERSION.exec(version) : null
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function isHigher(next: [number, number, number], current: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (next[i]! !== current[i]!) return next[i]! > current[i]!
  }
  return false
}

// The only two shapes a folder may have: a drive letter (C:\...) or a network share (\\server\share\...).
const DRIVE_FOLDER = /^[a-z]:(\\|$)/
const SHARE_FOLDER = /^\\\\[^\\?.*<>|":][^\\*<>|":]*\\[^\\*?<>|":]+(\\|$)/
const LONG_PATH_PREFIX = '\\\\?\\'
const LONG_SHARE_PREFIX = '\\\\?\\unc\\'
// A folder name Windows reads as some other name, so the text does not say which folder it is: one ending in a dot
// or a space (Windows drops them), or a short name (DOCUME~1).
const OTHER_NAME = /[. ]$|~\d/

interface FolderKey {
  key: string // lower case, backslashes, no long-path prefix, no backslash at the end
  onShare: boolean
}

/**
 * A Windows folder in one spelling, to compare by text. Null for anything that is not plainly one folder on a drive
 * or a share: empty, relative, no drive letter (\Users\...), a device path (\\.\...), a volume id, a name Windows
 * reads as another name (OTHER_NAME), or a colon anywhere but after the drive letter (a file stream).
 * The long-path spelling (\\?\C:\... and \\?\UNC\server\share\...) is the same folder, so its prefix is dropped once.
 */
function folderKey(folder: unknown): FolderKey | null {
  if (typeof folder !== 'string' || folder.trim() === '' || !win32.isAbsolute(folder)) return null
  let key = win32.normalize(folder).toLowerCase()
  if (key.startsWith(LONG_SHARE_PREFIX)) key = `\\\\${key.slice(LONG_SHARE_PREFIX.length)}`
  else if (key.startsWith(LONG_PATH_PREFIX)) key = key.slice(LONG_PATH_PREFIX.length)
  const onShare = SHARE_FOLDER.test(key)
  if (!onShare && !DRIVE_FOLDER.test(key)) return null
  key = key.replace(/\\+$/, '')
  if (key.slice(onShare ? 0 : 2).includes(':')) return null
  if (key.split('\\').some((part) => OTHER_NAME.test(part))) return null
  return { key, onShare }
}

function isInside(folder: string, parent: string): boolean {
  return folder === parent || folder.startsWith(`${parent}\\`)
}

/**
 * True unless the install folder is known to be clear of Documents and OneDrive. An update empties the install
 * folder, and the wizard let her choose it, so in or over her documents an update could delete her files.
 * Every folder must be readable: one that is not (the install folder, or any folder to keep out of) means it
 * cannot be known, and then updates stay off.
 * An install folder on a share is never known to be clear: \\localhost\c$\Users\... is her own drive by another
 * name, and no text tells which shares are. A folder to keep out of may be on a share (Documents moved to a NAS).
 */
function isUnsafeInstallFolder(installDir: unknown, keepOutOf: unknown): boolean {
  const install = folderKey(installDir)
  if (install === null || install.onShare || !Array.isArray(keepOutOf) || keepOutOf.length === 0) return true
  const keepOut: string[] = []
  for (const folder of keepOutOf) {
    const kept = folderKey(folder)
    if (kept === null) return true
    keepOut.push(kept.key)
  }
  if (install.key.split('\\').some((part) => part.startsWith('onedrive'))) return true
  return keepOut.some((folder) => isInside(install.key, folder) || isInside(folder, install.key))
}

function isSwitchedOff(env: UpdaterInput['env']): boolean {
  return Object.entries(env).some(
    ([name, value]) => name.toUpperCase() === 'SIMS_HELPER_UPDATES' && value?.trim().toLowerCase() === 'off'
  )
}

/** Sets every option that decides what the engine may do by itself. Called again before each check and download. */
function lockDown(engine: UpdateEngine): void {
  engine.autoDownload = false
  engine.autoInstallOnAppQuit = false
  engine.allowDowngrade = false
  engine.allowPrerelease = false
  engine.disableWebInstaller = true
  engine.disableDifferentialDownload = true
  engine.forceDevUpdateConfig = false
  engine.requestHeaders = { ...REQUEST_HEADERS }
  engine.logger = SILENT_LOGGER
}

/** Sorts an engine error into one of three fixed answers. The error's text is read here and kept nowhere. */
function failReason(error: unknown, step: 'check' | 'download'): FailReason {
  try {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
    if (step === 'download' && BAD_FILE_CODES.includes(code)) return 'bad-file'
    if (OFFLINE_CODES.includes(code)) return 'offline'
    return typeof message === 'string' && OFFLINE_TEXT.test(message) ? 'offline' : 'error'
  } catch {
    return 'error'
  }
}

/**
 * electron-updater's autoUpdater, built on first read. Null outside Electron (a unit test, a debug command), where
 * reading it would load the electron package, which can start a download of Electron itself.
 */
function packagedEngine(): UpdateEngine | null {
  return typeof process.versions['electron'] === 'string' ? electronUpdater.autoUpdater : null
}

function alwaysOff(why: OffReason, current: string): Updater {
  const off: UpdateState = { state: 'off', why, current } // About shows the version even with updates off
  return {
    state: () => off,
    check: async () => off,
    download: async () => off,
    install: () => ({ status: 'refused', why: 'not-ready' })
  }
}

export function createUpdater(input: UpdaterInput, seams: UpdaterSeams = {}): Updater {
  const current = input.version
  const parsed = versionParts(current)
  if (isSwitchedOff(input.env)) return alwaysOff('switched-off', current)
  if (!input.isPackaged || input.platform !== 'win32' || parsed === null) return alwaysOff('not-installed-app', current)
  if (isUnsafeInstallFolder(input.installDir, input.keepOutOf)) return alwaysOff('unsafe-install-folder', current)
  const currentParts: [number, number, number] = parsed

  const now = seams.now ?? (() => new Date())
  const justUpdated = input.argv.includes('--updated')
  const idle = (checkedAt: string | null): UpdateState => ({ state: 'idle', current, checkedAt, justUpdated })

  let state = idle(null)
  let restarting = false
  // The engine does not throw when it cannot start the installer: it tells its 'error' listeners and returns.
  // So install() listens only for the length of its one call. The error itself is never read.
  let startingInstall = false
  let installFailed = false

  // The engine is first touched here, after every reason to stay off, and only on an installed Windows app.
  let engine: UpdateEngine
  try {
    const loaded = seams.engine ? seams.engine() : packagedEngine()
    if (loaded === null || loaded === undefined) return alwaysOff('not-installed-app', current)
    engine = loaded
    lockDown(engine)
    engine.on('download-progress', (info) => {
      if (state.state !== 'downloading') return
      const percent = Math.floor(Number(info?.percent))
      if (percent > state.percent) state = { ...state, percent: Math.min(percent, 100) }
    })
    engine.on('error', () => {
      if (startingInstall) installFailed = true
    })
  } catch {
    return alwaysOff('not-installed-app', current) // no engine, no updates: outside Electron, or a build that lost it
  }

  // Anything but a plain "no" counts as busy, a throw included: a restart in the middle of a change is a power cut.
  const isBusy = (): boolean => {
    try {
      return seams.busy ? seams.busy() !== false : false
    } catch {
      return true
    }
  }

  // Each check gets a number. An answer counts only while its number is still the running one, so an answer that
  // comes after the check was given up, or after a newer check began, changes nothing.
  let checkRun = 0
  let checkStartedAt = 0

  function giveUpCheck(): void {
    checkRun += 1
    state = { state: 'failed', current, step: 'check', why: 'error' }
  }

  /** Gives up a check that has waited the full time. Run before every read, so no caller sees it stuck. */
  function expireCheck(): void {
    if (state.state !== 'checking') return
    const waited = now().getTime() - checkStartedAt
    if (!(waited < CHECK_GIVES_UP_AFTER_MS)) giveUpCheck() // a clock that gives no number gives up too
  }

  async function check(): Promise<UpdateState> {
    expireCheck()
    if (restarting || state.state === 'checking' || state.state === 'downloading' || state.state === 'ready') return state
    checkRun += 1
    const run = checkRun
    const isCurrent = (): boolean => run === checkRun && state.state === 'checking'
    checkStartedAt = now().getTime()
    state = { state: 'checking', current }
    // The clock above is only read when someone asks. This timer ends the wait when nobody does.
    let timer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<'gave-up'>((resolve) => {
      timer = setTimeout(() => resolve('gave-up'), CHECK_GIVES_UP_AFTER_MS)
      timer.unref() // never the reason the app stays open
    })
    try {
      lockDown(engine)
      const result = await Promise.race([engine.checkForUpdates(), gaveUp])
      if (!isCurrent()) return state
      if (result === 'gave-up') {
        giveUpCheck()
        return state
      }
      if (result === null || result === undefined) {
        state = { state: 'failed', current, step: 'check', why: 'error' }
        return state
      }
      // The engine's answer is not enough: the version must also be plain and higher by this file's own count.
      const next: unknown = result.isUpdateAvailable === true ? result.updateInfo?.version : null
      const nextParts = versionParts(next)
      state =
        typeof next === 'string' && nextParts !== null && isHigher(nextParts, currentParts)
          ? { state: 'available', current, next }
          : idle(now().toISOString())
    } catch (error) {
      if (isCurrent()) state = { state: 'failed', current, step: 'check', why: failReason(error, 'check') }
    } finally {
      clearTimeout(timer)
    }
    return state
  }

  async function download(): Promise<UpdateState> {
    expireCheck()
    if (restarting || state.state !== 'available') return state
    const { next } = state
    state = { state: 'downloading', current, next, percent: 0 }
    try {
      lockDown(engine)
      // Resolves only after the engine compared the file's SHA-512 with the one in the release's latest.yml.
      await engine.downloadUpdate()
      state = { state: 'ready', current, next }
    } catch (error) {
      state = { state: 'failed', current, step: 'download', why: failReason(error, 'download') }
    }
    return state
  }

  function install(): UpdateInstall {
    if (restarting) return { status: 'restarting' }
    expireCheck()
    if (state.state !== 'ready') return { status: 'refused', why: 'not-ready' }
    if (isBusy()) return { status: 'refused', why: 'busy' }
    installFailed = false
    startingInstall = true
    try {
      engine.quitAndInstall(true, true) // silent, then open the app again
    } catch {
      installFailed = true
    } finally {
      startingInstall = false
    }
    if (installFailed) {
      state = { state: 'failed', current, step: 'download', why: 'error' }
      return { status: 'refused', why: 'not-ready' }
    }
    restarting = true
    return { status: 'restarting' }
  }

  function read(): UpdateState {
    expireCheck()
    return state
  }

  return { state: read, check, download, install }
}
