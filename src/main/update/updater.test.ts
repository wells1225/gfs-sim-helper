// @vitest-environment node
// Every test drives a fake engine. The real electron-updater is replaced below, so no test reaches GitHub.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../shared/model.ts'
import type { UpdaterInput } from '../ports.ts'
import { createUpdater, type UpdateEngine, type UpdaterSeams } from './updater.ts'

const packaged = vi.hoisted(() => ({ reads: 0, engine: null as unknown, broken: false }))

vi.mock('electron-updater', () => ({
  default: {
    get autoUpdater() {
      packaged.reads += 1
      if (packaged.broken) throw new Error('Cannot read properties of undefined (reading getVersion)')
      return packaged.engine
    }
  }
}))

const INSTALL_DIR = 'C:\\Users\\Lila\\AppData\\Local\\Programs\\Sims Helper'
const DOCUMENTS = 'C:\\Users\\Lila\\Documents'
const ONEDRIVE = 'C:\\Users\\Lila\\OneDrive'
const NOW = new Date('2026-11-24T20:00:00.000Z')
const HEADERS = { 'x-user-staging-id': '0' }

function input(over: Partial<UpdaterInput> = {}): UpdaterInput {
  return {
    isPackaged: true,
    version: '0.2.0',
    installDir: INSTALL_DIR,
    argv: ['C:\\Users\\Lila\\AppData\\Local\\Programs\\Sims Helper\\Sims Helper.exe'],
    env: {},
    keepOutOf: [DOCUMENTS, ONEDRIVE],
    platform: 'win32',
    ...over
  }
}

interface Settings {
  autoDownload: unknown
  autoInstallOnAppQuit: unknown
  allowDowngrade: unknown
  allowPrerelease: unknown
  disableWebInstaller: unknown
  disableDifferentialDownload: unknown
  forceDevUpdateConfig: unknown
  requestHeaders: unknown
}

const SAFE_SETTINGS: Settings = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowDowngrade: false,
  allowPrerelease: false,
  disableWebInstaller: true,
  disableDifferentialDownload: true,
  forceDevUpdateConfig: false,
  requestHeaders: HEADERS
}

/** What the wrapper may read or set on the engine. Anything else (setFeedURL, channel, addAuthHeader) fails a test. */
const MAY_TOUCH = [
  'autoDownload',
  'autoInstallOnAppQuit',
  'allowDowngrade',
  'allowPrerelease',
  'disableWebInstaller',
  'disableDifferentialDownload',
  'forceDevUpdateConfig',
  'requestHeaders',
  'logger',
  'on',
  'checkForUpdates',
  'downloadUpdate',
  'quitAndInstall'
]

type CheckResult = Awaited<ReturnType<UpdateEngine['checkForUpdates']>>

function found(version: unknown): CheckResult {
  return { isUpdateAvailable: true, updateInfo: { version } } as CheckResult
}

function nothingNew(version = '0.2.0'): CheckResult {
  return { isUpdateAvailable: false, updateInfo: { version } }
}

/** An engine with electron-updater's own unsafe defaults, so a test fails unless the wrapper changes them. */
function fakeEngine() {
  const touched = new Set<string>()
  const atCheck: Settings[] = []
  const atDownload: Settings[] = []
  const progress: ((info: { percent: number }) => void)[] = []
  const logged: unknown[] = []
  const loud = { info: (m?: unknown) => logged.push(m), warn: (m?: unknown) => logged.push(m), error: (m?: unknown) => logged.push(m) }

  const raw = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    disableWebInstaller: false,
    disableDifferentialDownload: false,
    forceDevUpdateConfig: true,
    requestHeaders: null as Record<string, number | string | string[] | undefined> | null,
    logger: loud as UpdateEngine['logger'],
    channel: null as string | null,
    updateConfigPath: null as string | null,
    setFeedURL: vi.fn(),
    addAuthHeader: vi.fn(),
    checkForUpdates: vi.fn(async (): Promise<CheckResult> => nothingNew()),
    downloadUpdate: vi.fn(async (): Promise<unknown> => ['C:\\cache\\Sims-Helper-Setup-0.3.0.exe']),
    quitAndInstall: vi.fn((_isSilent?: boolean, _isForceRunAfter?: boolean): void => {}),
    on(_event: 'download-progress', listener: (info: { percent: number }) => void) {
      progress.push(listener)
      return raw
    }
  }
  const settings = (): Settings => ({
    autoDownload: raw.autoDownload,
    autoInstallOnAppQuit: raw.autoInstallOnAppQuit,
    allowDowngrade: raw.allowDowngrade,
    allowPrerelease: raw.allowPrerelease,
    disableWebInstaller: raw.disableWebInstaller,
    disableDifferentialDownload: raw.disableDifferentialDownload,
    forceDevUpdateConfig: raw.forceDevUpdateConfig,
    requestHeaders: raw.requestHeaders === null ? null : { ...raw.requestHeaders }
  })
  const check = raw.checkForUpdates
  const download = raw.downloadUpdate
  const recordingCheck = vi.fn(async () => {
    atCheck.push(settings())
    return check()
  })
  const recordingDownload = vi.fn(async () => {
    atDownload.push(settings())
    return download()
  })
  const engine = new Proxy(raw, {
    get(target, key, receiver) {
      touched.add(String(key))
      if (key === 'checkForUpdates') return recordingCheck
      if (key === 'downloadUpdate') return recordingDownload
      return Reflect.get(target, key, receiver)
    },
    set(target, key, value, receiver) {
      touched.add(String(key))
      return Reflect.set(target, key, value, receiver)
    }
  })
  return {
    engine: engine as UpdateEngine,
    raw,
    check,
    download,
    touched,
    atCheck,
    atDownload,
    logged,
    settings,
    emitProgress: (percent: number) => progress.forEach((listener) => listener({ percent }))
  }
}

type Fake = ReturnType<typeof fakeEngine>

function make(over: Partial<UpdaterInput> = {}, seams: Partial<UpdaterSeams> = {}, fake: Fake = fakeEngine()) {
  const updater = createUpdater(input(over), { engine: () => fake.engine, now: () => NOW, ...seams })
  return { updater, fake }
}

/** A promise the test settles by hand, to look at the state while the engine is still working. */
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function available(over: Partial<UpdaterInput> = {}, seams: Partial<UpdaterSeams> = {}) {
  const made = make(over, seams)
  made.fake.check.mockResolvedValue(found('0.3.0'))
  await made.updater.check()
  return made
}

async function ready(over: Partial<UpdaterInput> = {}, seams: Partial<UpdaterSeams> = {}) {
  const made = await available(over, seams)
  await made.updater.download()
  return made
}

const IDLE: UpdateState = { state: 'idle', current: '0.2.0', checkedAt: null, justUpdated: false }
const AVAILABLE: UpdateState = { state: 'available', current: '0.2.0', next: '0.3.0' }
const READY: UpdateState = { state: 'ready', current: '0.2.0', next: '0.3.0' }

beforeEach(() => {
  packaged.reads = 0
  packaged.engine = null
  packaged.broken = false
})

describe('when updates are off', () => {
  const never = (): UpdateEngine => {
    throw new Error('the engine must not be loaded')
  }

  async function expectOff(over: Partial<UpdaterInput>, why: string) {
    const updater = createUpdater(input(over), { engine: never })
    const off = { state: 'off', why }
    expect(updater.state()).toEqual(off)
    expect(await updater.check()).toEqual(off)
    expect(await updater.download()).toEqual(off)
    expect(updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
  }

  it('is off for an app that is not packaged, and never loads the engine', async () => {
    await expectOff({ isPackaged: false }, 'not-installed-app')
  })

  it('is off on anything but Windows', async () => {
    await expectOff({ platform: 'darwin' }, 'not-installed-app')
    await expectOff({ platform: 'linux' }, 'not-installed-app')
  })

  it('is off when the version is not a plain x.y.z', async () => {
    await expectOff({ version: '0.3.0-beta.1' }, 'not-installed-app')
    await expectOff({ version: '' }, 'not-installed-app')
  })

  it('SIMS_HELPER_UPDATES=off switches the updater off', async () => {
    await expectOff({ env: { SIMS_HELPER_UPDATES: 'off' } }, 'switched-off')
    await expectOff({ env: { SIMS_HELPER_UPDATES: ' OFF ' } }, 'switched-off')
    await expectOff({ env: { sims_helper_updates: 'off' } }, 'switched-off')
    await expectOff({ env: { SIMS_HELPER_UPDATES: 'off' }, isPackaged: false }, 'switched-off')
  })

  it('is off when the install folder is inside Documents or OneDrive, is one of them, or contains one', async () => {
    const unsafe = [
      `${DOCUMENTS}\\Sims Helper`,
      `${DOCUMENTS}\\Apps\\Sims Helper`,
      DOCUMENTS,
      `${DOCUMENTS}\\`,
      'C:\\Users\\Lila',
      'C:\\',
      `${ONEDRIVE}\\Apps\\Sims Helper`
    ]
    for (const installDir of unsafe) await expectOff({ installDir }, 'unsafe-install-folder')
  })

  it('compares folders without regard to letter case or the kind of slash', async () => {
    await expectOff({ installDir: 'c:\\users\\lila\\DOCUMENTS\\sims helper' }, 'unsafe-install-folder')
    await expectOff({ installDir: 'C:/Users/Lila/Documents/Sims Helper' }, 'unsafe-install-folder')
    await expectOff({ installDir: `${DOCUMENTS}\\Sims Helper`, keepOutOf: ['c:/users/lila/documents/'] }, 'unsafe-install-folder')
  })

  it('is off under any folder whose name starts with OneDrive, even when no OneDrive root was passed in', async () => {
    await expectOff(
      { installDir: 'D:\\OneDrive - Personal\\Apps\\Sims Helper', keepOutOf: [DOCUMENTS] },
      'unsafe-install-folder'
    )
  })

  it('is off when it cannot tell where the app or Documents is', async () => {
    await expectOff({ installDir: '' }, 'unsafe-install-folder')
    await expectOff({ installDir: 'Programs\\Sims Helper' }, 'unsafe-install-folder')
    await expectOff({ keepOutOf: [] }, 'unsafe-install-folder')
    await expectOff({ keepOutOf: ['', 'Documents'] }, 'unsafe-install-folder')
  })

  it('is off, and does not throw, when the engine cannot start', async () => {
    const broken = createUpdater(input(), { engine: never })
    expect(broken.state()).toEqual({ state: 'off', why: 'not-installed-app' })
    expect(await broken.check()).toEqual({ state: 'off', why: 'not-installed-app' })
  })
})

describe('when updates are on', () => {
  it('a folder that only starts with the same letters as Documents is a safe install folder', () => {
    expect(make({ installDir: 'C:\\Users\\Lila\\Documents2\\Sims Helper' }).updater.state()).toEqual(IDLE)
    expect(make({ installDir: 'D:\\Apps\\Sims Helper' }).updater.state()).toEqual(IDLE)
  })

  it('starts idle without asking the engine for anything, so opening the app never waits for it', () => {
    const { updater, fake } = make()
    expect(updater.state()).toEqual(IDLE)
    expect(fake.check).not.toHaveBeenCalled()
    expect(fake.download).not.toHaveBeenCalled()
    expect(fake.raw.quitAndInstall).not.toHaveBeenCalled()
  })

  it('--updated in argv means the installer just restarted the app', () => {
    const { updater } = make({ argv: ['Sims Helper.exe', '--updated'] })
    expect(updater.state()).toEqual({ ...IDLE, justUpdated: true })
  })

  it('turns off automatic download and install, downgrades, prereleases and the other unsafe defaults before the first check', async () => {
    const { updater, fake } = make()
    expect(fake.settings()).toEqual(SAFE_SETTINGS)
    await updater.check()
    expect(fake.atCheck).toEqual([SAFE_SETTINGS])
  })

  it('puts the settings back before every check and download, whatever changed them', async () => {
    const { updater, fake } = make()
    fake.check.mockResolvedValue(found('0.3.0'))
    Object.assign(fake.raw, { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, requestHeaders: null })
    await updater.check()
    Object.assign(fake.raw, { autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, requestHeaders: { authorization: 'x' } })
    await updater.download()
    expect(fake.atCheck).toEqual([SAFE_SETTINGS])
    expect(fake.atDownload).toEqual([SAFE_SETTINGS])
  })

  it('gives the engine a logger that drops everything', () => {
    const { fake } = make()
    const logger = fake.raw.logger
    expect(logger).not.toBeNull()
    logger?.info('C:\\Users\\Lila\\AppData')
    logger?.warn('C:\\Users\\Lila\\AppData')
    logger?.error('C:\\Users\\Lila\\AppData')
    expect(fake.logged).toEqual([])
  })

  it('sends a fixed id in place of the random per-install id, and no other header, on a check and on a download', async () => {
    const { updater, fake } = await ready()
    expect(fake.atCheck[0]?.requestHeaders).toEqual(HEADERS)
    expect(fake.atDownload[0]?.requestHeaders).toEqual(HEADERS)
    expect(Object.keys(fake.raw.requestHeaders ?? {})).toEqual(['x-user-staging-id'])
    expect(updater.state()).toEqual(READY)
  })

  it('never points the feed anywhere: it only uses the feed baked into the installed app, on the stable channel', async () => {
    const { updater, fake } = await ready()
    updater.install()
    expect(fake.raw.setFeedURL).not.toHaveBeenCalled()
    expect(fake.raw.addAuthHeader).not.toHaveBeenCalled()
    expect(fake.raw.channel).toBeNull()
    expect(fake.raw.updateConfigPath).toBeNull()
    expect([...fake.touched].filter((name) => !MAY_TOUCH.includes(name))).toEqual([])
  })

  it('no environment value can do more than switch updates off', async () => {
    const env = {
      SIMS_HELPER_UPDATES: 'https://evil.example/feed',
      SIMS_HELPER_UPDATE_URL: 'https://evil.example/feed',
      SIMS_HELPER_UPDATE_FEED_DIR: 'C:\\evil',
      ELECTRON_UPDATER_URL: 'https://evil.example/feed',
      GH_TOKEN: 'not-a-real-token',
      GITHUB_TOKEN: 'not-a-real-token'
    }
    const { updater, fake } = await ready({ env })
    expect(updater.state()).toEqual(READY)
    expect(fake.raw.setFeedURL).not.toHaveBeenCalled()
    expect(fake.raw.addAuthHeader).not.toHaveBeenCalled()
    expect(fake.atCheck).toEqual([SAFE_SETTINGS])
    expect([...fake.touched].filter((name) => !MAY_TOUCH.includes(name))).toEqual([])
  })
})

describe('check', () => {
  it('reports a higher version as available and never downloads it', async () => {
    const { updater, fake } = make()
    fake.check.mockResolvedValue(found('0.3.0'))
    expect(await updater.check()).toEqual(AVAILABLE)
    expect(await updater.check()).toEqual(AVAILABLE)
    expect(updater.state()).toEqual(AVAILABLE)
    expect(fake.download).not.toHaveBeenCalled()
    expect(fake.atCheck.every((s) => s.autoDownload === false)).toBe(true)
  })

  it('compares version numbers as numbers', async () => {
    const { updater, fake } = make({ version: '0.9.0' })
    fake.check.mockResolvedValue(found('0.10.0'))
    expect(await updater.check()).toEqual({ state: 'available', current: '0.9.0', next: '0.10.0' })
  })

  it('is idle, with the time of the check, when there is nothing newer', async () => {
    const { updater } = make()
    expect(await updater.check()).toEqual({ ...IDLE, checkedAt: NOW.toISOString() })
  })

  it('keeps justUpdated after a check', async () => {
    const { updater } = make({ argv: ['--updated'] })
    expect(await updater.check()).toEqual({ ...IDLE, checkedAt: NOW.toISOString(), justUpdated: true })
  })

  it('does not offer an equal or lower version, a prerelease, or a version that is not plain x.y.z, even if the engine does', async () => {
    const refused = ['0.2.0', '0.1.9', '0.3.0-beta.1', '0.3.0+build', 'v0.3.0', '0.3', '<b>9.9.9</b>', '', 3, null, undefined]
    for (const version of refused) {
      const { updater, fake } = make()
      fake.check.mockResolvedValue(found(version))
      expect(await updater.check(), `version ${String(version)}`).toEqual({ ...IDLE, checkedAt: NOW.toISOString() })
      expect(await updater.download()).toEqual({ ...IDLE, checkedAt: NOW.toISOString() })
      expect(fake.download).not.toHaveBeenCalled()
    }
  })

  it('does not offer a version the engine did not call available', async () => {
    const { updater, fake } = make()
    fake.check.mockResolvedValue(nothingNew('0.3.0'))
    expect(await updater.check()).toEqual({ ...IDLE, checkedAt: NOW.toISOString() })
  })

  it('returns the state unchanged while a check is running, and asks the engine once', async () => {
    const { updater, fake } = make()
    const gate = pending<CheckResult>()
    fake.check.mockReturnValue(gate.promise)
    const first = updater.check()
    const checking = { state: 'checking', current: '0.2.0' }
    expect(updater.state()).toEqual(checking)
    expect(await updater.check()).toEqual(checking)
    expect(await updater.download()).toEqual(checking)
    expect(updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    gate.resolve(found('0.3.0'))
    expect(await first).toEqual(AVAILABLE)
    expect(fake.check).toHaveBeenCalledTimes(1)
  })

  it('returns the state unchanged while downloading and when ready', async () => {
    const { updater, fake } = await available()
    const gate = pending<unknown>()
    fake.download.mockReturnValue(gate.promise)
    const downloading = updater.download()
    expect(await updater.check()).toEqual({ state: 'downloading', current: '0.2.0', next: '0.3.0', percent: 0 })
    gate.resolve([])
    expect(await downloading).toEqual(READY)
    expect(await updater.check()).toEqual(READY)
    expect(fake.check).toHaveBeenCalledTimes(1)
  })

  it('a failed check is a calm state: it never rejects and holds no raw error text', async () => {
    const errors: unknown[] = [
      new Error('ENOENT: no such file, open C:\\Users\\Lila\\AppData\\Local\\Programs\\Sims Helper\\resources\\app-update.yml'),
      Object.assign(new Error('Cannot parse releases feed: <feed>Lila</feed>'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }),
      Object.assign(new Error('503 Service Unavailable Lila'), { statusCode: 503, code: 'HTTP_ERROR_503' }),
      'a string naming Lila',
      { message: { toString: () => 'Lila' } },
      null,
      undefined
    ]
    for (const error of errors) {
      const { updater, fake } = make()
      fake.check.mockRejectedValue(error)
      const state = await updater.check()
      expect(state).toEqual({ state: 'failed', current: '0.2.0', step: 'check', why: 'error' })
      expect(JSON.stringify(updater.state())).not.toContain('Lila')
    }
  })

  it('a check without a connection fails as offline', async () => {
    const errors = [
      new Error('net::ERR_INTERNET_DISCONNECTED'),
      new Error('net::ERR_NAME_NOT_RESOLVED'),
      Object.assign(
        new Error('Unable to find latest version on GitHub (https://github.com/...): Error: net::ERR_CONNECTION_TIMED_OUT\n at C:\\Users\\Lila'),
        { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }
      ),
      new Error('Request timed out'),
      Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
    ]
    for (const error of errors) {
      const { updater, fake } = make()
      fake.check.mockRejectedValue(error)
      expect(await updater.check(), String(error)).toEqual({ state: 'failed', current: '0.2.0', step: 'check', why: 'offline' })
    }
  })

  it('fails calmly when the engine throws at once or answers with nothing', async () => {
    const thrown = make()
    thrown.fake.check.mockImplementation(() => {
      throw new Error('boom at C:\\Users\\Lila')
    })
    expect(await thrown.updater.check()).toEqual({ state: 'failed', current: '0.2.0', step: 'check', why: 'error' })
    const nothing = make()
    nothing.fake.check.mockResolvedValue(null)
    expect(await nothing.updater.check()).toEqual({ state: 'failed', current: '0.2.0', step: 'check', why: 'error' })
  })

  it('can check again after a failed check', async () => {
    const { updater, fake } = make()
    fake.check.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await updater.check()
    fake.check.mockResolvedValue(found('0.3.0'))
    expect(await updater.check()).toEqual(AVAILABLE)
  })
})

describe('download', () => {
  it('does nothing unless an update is available', async () => {
    const { updater, fake } = make()
    expect(await updater.download()).toEqual(IDLE)
    fake.check.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const failed = await updater.check()
    expect(await updater.download()).toEqual(failed)
    expect(fake.download).not.toHaveBeenCalled()
  })

  it('downloads only when asked, and is ready when the engine has finished and checked the file', async () => {
    const { updater, fake } = await available()
    expect(fake.download).not.toHaveBeenCalled()
    expect(await updater.download()).toEqual(READY)
    expect(fake.download).toHaveBeenCalledTimes(1)
  })

  it('never installs by itself: automatic install on quit is off and the installer is not started', async () => {
    const { updater, fake } = await ready()
    expect(updater.state()).toEqual(READY)
    expect(fake.atDownload).toEqual([SAFE_SETTINGS])
    expect(fake.settings().autoInstallOnAppQuit).toBe(false)
    expect(fake.raw.quitAndInstall).not.toHaveBeenCalled()
  })

  it('reports progress as a whole percent that never goes back, and is not ready until the engine says so', async () => {
    const { updater, fake } = await available()
    const gate = pending<unknown>()
    fake.download.mockReturnValue(gate.promise)
    const downloading = updater.download()
    const percentAfter = (percent: number): unknown => {
      fake.emitProgress(percent)
      const state = updater.state()
      return state.state === 'downloading' ? state.percent : state.state
    }
    expect(updater.state()).toEqual({ state: 'downloading', current: '0.2.0', next: '0.3.0', percent: 0 })
    expect(percentAfter(41.7)).toBe(41)
    expect(percentAfter(12)).toBe(41)
    expect(percentAfter(Number.NaN)).toBe(41)
    expect(percentAfter(250)).toBe(100)
    expect(percentAfter(-5)).toBe(100)
    expect(await updater.download()).toEqual({ state: 'downloading', current: '0.2.0', next: '0.3.0', percent: 100 })
    expect(updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    gate.resolve([])
    expect(await downloading).toEqual(READY)
    expect(fake.download).toHaveBeenCalledTimes(1)
    fake.emitProgress(50)
    expect(updater.state()).toEqual(READY)
  })

  it('a file that fails its checksum is a failed download with bad-file, and is never ready', async () => {
    const { updater, fake } = await available()
    fake.download.mockRejectedValue(
      Object.assign(new Error('sha512 checksum mismatch, expected abc, got def'), { code: 'ERR_CHECKSUM_MISMATCH' })
    )
    expect(await updater.download()).toEqual({ state: 'failed', current: '0.2.0', step: 'download', why: 'bad-file' })
    expect(updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    expect(fake.raw.quitAndInstall).not.toHaveBeenCalled()
  })

  it('a file not signed by the expected publisher is bad-file too', async () => {
    const { updater, fake } = await available()
    fake.download.mockRejectedValue(
      Object.assign(new Error('New version 0.3.0 is not signed by the application owner'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' })
    )
    expect(await updater.download()).toEqual({ state: 'failed', current: '0.2.0', step: 'download', why: 'bad-file' })
  })

  it('a failed download is a calm state: it never rejects and holds no raw error text', async () => {
    const offline = await available()
    offline.fake.download.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(await offline.updater.download()).toEqual({ state: 'failed', current: '0.2.0', step: 'download', why: 'offline' })

    const other = await available()
    other.fake.download.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, rename C:\\Users\\Lila\\AppData\\Local\\sims-helper-updater\\pending\\temp.exe')
    })
    expect(await other.updater.download()).toEqual({ state: 'failed', current: '0.2.0', step: 'download', why: 'error' })
    expect(JSON.stringify(other.updater.state())).not.toContain('Lila')
  })

  it('after a failed download, a new check and a new click download again', async () => {
    const { updater, fake } = await available()
    fake.download.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
    await updater.download()
    expect(await updater.check()).toEqual(AVAILABLE)
    expect(await updater.download()).toEqual(READY)
    expect(fake.download).toHaveBeenCalledTimes(2)
  })
})

describe('install', () => {
  it('refuses unless a checked download is ready', async () => {
    const idle = make()
    expect(idle.updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    const waiting = await available()
    expect(waiting.updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    expect(idle.fake.raw.quitAndInstall).not.toHaveBeenCalled()
    expect(waiting.fake.raw.quitAndInstall).not.toHaveBeenCalled()
  })

  it('on Restart now it starts a silent install that reopens the app, once', async () => {
    const { updater, fake } = await ready()
    expect(updater.install()).toEqual({ status: 'restarting' })
    expect(fake.raw.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(fake.raw.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(updater.install()).toEqual({ status: 'restarting' })
    expect(fake.raw.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('refuses as busy while a fix, backup or 50/50 step is running, then installs once it is done', async () => {
    let busy = true
    const { updater, fake } = await ready({}, { busy: () => busy })
    expect(updater.install()).toEqual({ status: 'refused', why: 'busy' })
    expect(fake.raw.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.state()).toEqual(READY)
    busy = false
    expect(updater.install()).toEqual({ status: 'restarting' })
    expect(fake.raw.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('refuses as busy when it cannot find out whether a change is running', async () => {
    const { updater, fake } = await ready({}, {
      busy: () => {
        throw new Error('no context yet')
      }
    })
    expect(updater.install()).toEqual({ status: 'refused', why: 'busy' })
    expect(fake.raw.quitAndInstall).not.toHaveBeenCalled()
  })

  it('touches nothing on the engine after the restart was started', async () => {
    const { updater, fake } = await ready()
    updater.install()
    expect(await updater.check()).toEqual(READY)
    expect(await updater.download()).toEqual(READY)
    expect(fake.check).toHaveBeenCalledTimes(1)
    expect(fake.download).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the installer cannot be started: the download counts as failed', async () => {
    const { updater, fake } = await ready()
    fake.raw.quitAndInstall.mockImplementation(() => {
      throw new Error('spawn C:\\Users\\Lila\\AppData\\Local\\sims-helper-updater\\pending\\Setup.exe EACCES')
    })
    expect(updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    expect(updater.state()).toEqual({ state: 'failed', current: '0.2.0', step: 'download', why: 'error' })
  })
})

describe('the real engine', () => {
  it('is electron-updater’s autoUpdater, read once, and only for an installed app', async () => {
    const fake = fakeEngine()
    packaged.engine = fake.engine
    fake.check.mockResolvedValue(found('0.3.0'))

    expect(createUpdater(input({ isPackaged: false })).state().state).toBe('off')
    expect(createUpdater(input({ env: { SIMS_HELPER_UPDATES: 'off' } })).state().state).toBe('off')
    expect(createUpdater(input({ installDir: `${DOCUMENTS}\\Sims Helper` })).state().state).toBe('off')
    expect(packaged.reads).toBe(0)

    const updater = createUpdater(input())
    expect(fake.settings()).toEqual(SAFE_SETTINGS)
    expect(await updater.check()).toEqual(AVAILABLE)
    expect(await updater.download()).toEqual(READY)
    expect(updater.install()).toEqual({ status: 'restarting' })
    expect(packaged.reads).toBe(1)
  })

  it('leaves updates off when electron-updater cannot start, as outside Electron', () => {
    packaged.broken = true
    expect(createUpdater(input()).state()).toEqual({ state: 'off', why: 'not-installed-app' })
    packaged.broken = false
    packaged.engine = undefined
    expect(createUpdater(input()).state()).toEqual({ state: 'off', why: 'not-installed-app' })
  })
})
