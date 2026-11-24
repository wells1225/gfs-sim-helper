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

/** An absolute Windows folder in one spelling, to compare by text. Null for an empty or relative path. */
function folderKey(folder: unknown): string | null {
  if (typeof folder !== 'string' || folder.trim() === '' || !win32.isAbsolute(folder)) return null
  return win32.normalize(folder).replace(/\\+$/, '').toLowerCase()
}

function isInside(folder: string, parent: string): boolean {
  return folder === parent || folder.startsWith(`${parent}\\`)
}

/**
 * True unless the install folder is known to be clear of Documents and OneDrive. An update empties the install
 * folder, and the wizard let her choose it, so in or over her documents an update could delete her files.
 */
function isUnsafeInstallFolder(installDir: string, keepOutOf: readonly string[]): boolean {
  const install = folderKey(installDir)
  const keepOut = keepOutOf.map(folderKey).filter((key) => key !== null)
  if (install === null || keepOut.length === 0) return true
  if (install.split('\\').some((part) => part.startsWith('onedrive'))) return true
  return keepOut.some((folder) => isInside(install, folder) || isInside(folder, install))
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

function alwaysOff(why: OffReason): Updater {
  const off: UpdateState = { state: 'off', why }
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
  if (isSwitchedOff(input.env)) return alwaysOff('switched-off')
  if (!input.isPackaged || input.platform !== 'win32' || parsed === null) return alwaysOff('not-installed-app')
  if (isUnsafeInstallFolder(input.installDir, input.keepOutOf)) return alwaysOff('unsafe-install-folder')
  const currentParts: [number, number, number] = parsed

  const now = seams.now ?? (() => new Date())
  const justUpdated = input.argv.includes('--updated')
  const idle = (checkedAt: string | null): UpdateState => ({ state: 'idle', current, checkedAt, justUpdated })

  let state = idle(null)
  let restarting = false

  // The engine is first touched here, after every reason to stay off, and only on an installed Windows app.
  let engine: UpdateEngine
  try {
    const loaded = seams.engine ? seams.engine() : packagedEngine()
    if (loaded === null || loaded === undefined) return alwaysOff('not-installed-app')
    engine = loaded
    lockDown(engine)
    engine.on('download-progress', (info) => {
      if (state.state !== 'downloading') return
      const percent = Math.floor(Number(info?.percent))
      if (percent > state.percent) state = { ...state, percent: Math.min(percent, 100) }
    })
  } catch {
    return alwaysOff('not-installed-app') // no engine, no updates: outside Electron, or a build that lost it
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
    try {
      engine.quitAndInstall(true, true) // silent, then open the app again
    } catch {
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
