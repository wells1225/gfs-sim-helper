// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, type Handlers, type IpcInvoke } from '../shared/ipc.ts'
import type {
  ActionKind,
  AssistAnswer,
  BackupRefusal,
  DisabledGroup,
  FiftyDamaged,
  FiftyStopPartWay,
  FixRefusal,
  GameRunState as ModelGameRunState,
  GateRefusal,
  JournalOrigin,
  KeySetResult,
  Progress,
  ShareRefusal,
  ShareView,
  StartupRecovery,
  UpdateInstall,
  UpdateState
} from '../shared/model.ts'
import { sampleFiftyFifty, sampleJournalEntry, sampleScan, sampleShareView } from '../shared/testing/sample.ts'
import { appPaths } from './app-paths.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import type { IpcMainInvokeEvent } from 'electron'
import { CHANGING_CHANNELS, collectHandlers, registerIpc, sanitizeIpcError } from './ipc.ts'
import type { Host } from './locate/host.ts'
import type { ActionPlan, AssistReply, KeyStore, PlanFixAt, PlannedStep, Updater } from './ports.ts'
import type { GameRunState as LocateGameRunState } from './locate/process.ts'
import { scanHandlers } from './scan/handlers.ts'
import { sha256File } from './fs-read.ts'
import {
  createContext,
  createRecoveryQuitGuard,
  makeOpenWeb,
  onceRecovery,
  updaterKeepOutOf,
  type CreateContextInput
} from './services.ts'
import { shareHandlers } from './share/handlers.ts'
import { updateHandlers } from './update/handlers.ts'
import { createUpdater } from './update/updater.ts'
import { launchEnv, shoot } from '../../test/e2e/support/app.ts'
import { cspAtBuild, RENDERER_CSP } from '../../electron.vite.config.ts'

const execFileAsync = promisify(execFile)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(THIS_DIR, '../..')
const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const GAME_RUN_STATE_MATCHES: AssertEqual<ModelGameRunState, LocateGameRunState> = true

function makeFakeHost(): Host {
  return {
    documentsDir: '/fake/Documents',
    env: { USERNAME: 'Lila' },
    async readRegistry() {
      return undefined
    },
    async listProcesses() {
      return []
    },
    async fileVersion() {
      return undefined
    }
  }
}

describe('contract', () => {
  it('both tsc projects from npm run typecheck exit 0', async () => {
    for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) {
      const result = await execFileAsync(process.execPath, [TSC_BIN, '--noEmit', '-p', config], {
        cwd: REPO_ROOT,
        timeout: 120_000
      })
      expect(result.stderr).toBe('')
    }
  }, 120_000)

  it('builds context and handlers without running stubs and covers every INVOKE_CHANNELS entry once', () => {
    const ctx = createContext({
      host: makeFakeHost(),
      paths: appPaths({
        localAppData: '/fake/LocalAppData',
        appData: '/fake/Roaming',
        desktopDir: '/fake/Desktop',
        env: {}
      }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {}
    })

    const groups = [
      scanHandlers(ctx),
      fixHandlers(ctx),
      fiftyHandlers(ctx),
      assistHandlers(ctx),
      updateHandlers(ctx),
      shareHandlers(ctx)
    ]
    const seen = new Map<string, number>()
    for (const group of groups) {
      for (const channel of Object.keys(group)) {
        seen.set(channel, (seen.get(channel) ?? 0) + 1)
      }
    }

    for (const channel of INVOKE_CHANNELS) {
      expect(seen.get(channel), `channel ${channel}`).toBe(1)
    }
    expect(seen.size).toBe(INVOKE_CHANNELS.length)

    const merged = collectHandlers(ctx)
    expect(Object.keys(merged).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('keeps GameRunState identical between shared/model.ts and locate/process.ts', () => {
    expect(GAME_RUN_STATE_MATCHES).toBe(true)
  })
})

describe('e2e support shoot()', () => {
  const slug = 'contract-shoot-unit'

  afterAll(async () => {
    await rm(join(process.cwd(), 'test-results', 'screens', slug), { recursive: true, force: true })
  })

  it('turns on reduced motion and waits a frame after each colour switch before a screenshot', async () => {
    const events: string[] = []
    const page = {
      async setViewportSize() {},
      async emulateMedia(media: { colorScheme?: string; reducedMotion?: string }) {
        if (media.reducedMotion) events.push(`reducedMotion:${media.reducedMotion}`)
        if (media.colorScheme) events.push(`colorScheme:${media.colorScheme}`)
      },
      async evaluate() {
        events.push('frame')
      },
      async screenshot(options: { path: string }) {
        events.push(`shot:${options.path.endsWith('-dark.png') ? 'dark' : 'light'}`)
      }
    } as unknown as Page

    await shoot(page, slug, 'sample')

    const firstShot = events.findIndex((e) => e.startsWith('shot:'))
    expect(events.slice(0, firstShot)).toContain('reducedMotion:reduce')
    for (const scheme of ['light', 'dark']) {
      const shot = events.indexOf(`shot:${scheme}`)
      const switched = events.lastIndexOf(`colorScheme:${scheme}`, shot)
      expect(switched).toBeGreaterThanOrEqual(0)
      expect(events.slice(switched + 1, shot)).toContain('frame')
    }
  })
})

const CONTRACT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; " +
  "form-action 'none'"

describe('renderer Content-Security-Policy', () => {
  it('is added only at build time, so the dev server can inject its inline script', async () => {
    const html = await readFile(join(REPO_ROOT, 'src/renderer/index.html'), 'utf8')
    expect(html).not.toMatch(/Content-Security-Policy/i)
    const plugin = cspAtBuild()
    expect(plugin.apply).toBe('build')
    expect(RENDERER_CSP).toBe(CONTRACT_CSP)
  })

  it('puts the exact policy first in the built page head', () => {
    const transform = cspAtBuild().transformIndexHtml as () => unknown
    expect(transform()).toEqual([
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTRACT_CSP },
        injectTo: 'head-prepend'
      }
    ])
  })
})

describe('GateRefusal', () => {
  it('has a check-failed reason so an error inside a gate check fails closed', () => {
    const refusal: GateRefusal = { reason: 'check-failed', path: 'C:\\Sims\\Mods\\a.package' }
    expect(refusal.reason).toBe('check-failed')
  })
})

describe('backup and action plan contract', () => {
  it('refuses a backup folder inside the Sims folder', () => {
    const reason: BackupRefusal = 'backup-folder-in-sims-folder'
    expect(reason).toBe('backup-folder-in-sims-folder')
  })

  it('lets the planner choose the journal entry id that runAction uses', () => {
    const plan: ActionPlan = {
      entryId: 'entry-1',
      action: 'disable-group',
      summary: 'Set aside one mod',
      origin: { by: 'fix' },
      folderPath: 'C:\\Sims',
      groupId: 'g1',
      groupLabel: 'Group one',
      hasScript: false,
      steps: []
    }
    expect(plan.entryId).toBe('entry-1')
  })
})

describe('fix contract requests from PR 10', () => {
  it('has a refusal for an action that failed before anything changed', () => {
    const refusal: FixRefusal = { why: 'not-started' }
    expect(refusal.why).toBe('not-started')
  })

  it('carries the hash the edit was planned against, so runAction can refuse a changed file', () => {
    const step: PlannedStep = { kind: 'edit', path: 'C:\\Sims\\Options.ini', newText: 'a', beforeSha256: 'b'.repeat(64) }
    expect(step.kind === 'edit' && step.beforeSha256).toBe('b'.repeat(64))
  })

  it('carries the group label and script flag on the plan and on the journal entry', () => {
    const plan: ActionPlan = {
      entryId: 'entry-2',
      action: 'disable-group',
      summary: 'Set aside Wicked Wardrobe',
      origin: { by: 'fix' },
      folderPath: 'C:\\Sims',
      groupId: 'cf:901234',
      groupLabel: 'Wicked Wardrobe',
      hasScript: true,
      steps: []
    }
    const entry = sampleJournalEntry({ groupId: plan.groupId, groupLabel: plan.groupLabel, hasScript: plan.hasScript })
    expect([entry.groupLabel, entry.hasScript]).toEqual(['Wicked Wardrobe', true])
    expect([sampleJournalEntry().groupLabel, sampleJournalEntry().hasScript]).toEqual([null, false])
  })

  it('a save swap journal entry has no backup id: backupId is null, a fix keeps its string', () => {
    // PR 14: a save swap makes no backup, so it has no honest backup id. The tsc test above fails if null is refused.
    const swap = sampleJournalEntry({
      action: 'share-receive',
      origin: { by: 'share', shareId: 'share-1', seq: 1 },
      backupId: null,
      steps: []
    })
    const backupIds: (string | null)[] = [swap.backupId, sampleJournalEntry().backupId]
    expect(backupIds).toEqual([null, '20261124-120400-e5f6'])
  })

  it('lets planFix take what applyFix read from the disk', () => {
    const at: PlanFixAt = {
      holdingDir: 'C:\\Data\\holding',
      entryId: 'entry-3',
      optionsText: '[options]\n',
      existingCaches: ['localthumbcache.package'],
      existingModPaths: ['Scripts/a.ts4script']
    }
    const bare: PlanFixAt = { holdingDir: 'C:\\Data\\holding', entryId: 'entry-3' }
    expect([at.optionsText, bare.optionsText]).toEqual(['[options]\n', undefined])
  })
})

describe('50/50 contract requests from PR 11', () => {
  it('sends the round the answer is for, so a stale click cannot answer the next round', () => {
    const req: IpcInvoke['fifty:answer']['req'] = { answer: 'worked', round: 2 }
    expect(req.round).toBe(2)
  })

  it('says whether a disabled group was set aside by a fix or by the 50/50 test', () => {
    const groups: DisabledGroup[] = [
      { groupId: 'dir:hair', label: 'Hair', entryId: 'e1', at: '2026-11-24T12:00:00.000Z', origin: 'fix' },
      { groupId: 'cf:1', label: 'Zed', entryId: 'e2', at: '2026-11-24T12:01:00.000Z', origin: 'fifty-fifty' }
    ]
    expect(groups.map((g) => g.origin)).toEqual(['fix', 'fifty-fifty'])
  })

  it('answers fifty:get with a typed damaged result, beside the session or null', () => {
    const answers: IpcInvoke['fifty:get']['res'][] = [sampleFiftyFifty(), null, { status: 'damaged' }]
    const damaged = answers.filter((a): a is FiftyDamaged => a !== null && 'status' in a)
    expect(damaged).toEqual([{ status: 'damaged' }])
  })

  it('lets fifty:stop end part way with no session, naming the groups not back yet', () => {
    const partWay: FiftyStopPartWay = {
      status: 'stopped-part-way',
      state: null,
      notBack: ['Wicked Wardrobe'],
      detail: 'put-back stopped'
    }
    const res: IpcInvoke['fifty:stop']['res'] = partWay
    const other: IpcInvoke['fifty:start']['res'] = { status: 'stopped-part-way', state: sampleFiftyFifty(), detail: 'x' }
    expect([res.status, res.state, partWay.notBack, other.state?.id]).toEqual([
      'stopped-part-way',
      null,
      ['Wicked Wardrobe'],
      sampleFiftyFifty().id
    ])
  })
})

describe('AI key contract requests from PR 12', () => {
  it('tells a key the service rejected (HTTP 401) apart from no key at all', () => {
    const reply: AssistReply = { status: 'failed', why: 'key-rejected' }
    const answer: AssistAnswer = { status: 'no-answer', why: 'key-rejected' }
    expect([reply.status === 'failed' && reply.why, answer.status === 'no-answer' && answer.why]).toEqual([
      'key-rejected',
      'key-rejected'
    ])
  })

  it('lets setKey say a new key was not saved while the old one stays stored', () => {
    const results: KeySetResult[] = ['set', 'not-set', 'encryption-unavailable', 'not-saved']
    const res: IpcInvoke['assist:set-key']['res'] = 'not-saved'
    const set: KeyStore['set'] = async () => 'not-saved'
    expect([results.at(-1), res, typeof set]).toEqual(['not-saved', 'not-saved', 'function'])
  })
})

describe('auto-update contract (PR 13)', () => {
  function makeContext(updater?: CreateContextInput['updater']) {
    return createContext({
      host: makeFakeHost(),
      paths: appPaths({ localAppData: '/fake/LocalAppData', appData: '/fake/Roaming', desktopDir: '/fake/Desktop', env: {} }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {},
      ...(updater ? { updater } : {})
    })
  }

  it('builds the installer with a GitHub publish entry but never publishes from a build', async () => {
    // Windows checkouts may have CRLF line ends.
    const builder = (await readFile(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')).replaceAll('\r\n', '\n')
    expect(builder).toMatch(/^publish:\n {2}provider: github\n {2}owner: wells1225\n {2}repo: gfs-sim-helper\n/m)
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts['dist:win']).toMatch(/ --publish never$/)
    expect(pkg.devDependencies['electron-updater']).toBe('^6.8.11')
  })

  it('always installs per user, so no update asks for admin', async () => {
    const nsh = await readFile(join(REPO_ROOT, 'build/installer.nsh'), 'utf8')
    expect(nsh).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"\s+!macroend/)
    expect(nsh).toContain('Made for Lila, with love from Tyler')
  })

  it('registers the update channels from updateHandlers', () => {
    const ctx = makeContext()
    const channels: (keyof IpcInvoke)[] = ['update:get', 'update:check', 'update:download', 'update:install']
    expect(Object.keys(updateHandlers(ctx)).sort()).toEqual([...channels].sort())
    for (const channel of channels) expect(INVOKE_CHANNELS).toContain(channel)
  })

  it('has updates off when no updater is passed in, and uses the one passed in', async () => {
    expect(makeContext().updater.state()).toEqual({ state: 'off', why: 'switched-off', current: '0.0.0' })
    const idle: UpdateState = { state: 'idle', current: '0.2.0', checkedAt: null, justUpdated: false }
    const refused: UpdateInstall = { status: 'refused', why: 'not-ready' }
    const updater: Updater = {
      state: () => idle,
      check: async () => idle,
      download: async () => idle,
      install: () => refused
    }
    const ctx = makeContext(updater)
    expect(await ctx.updater.check()).toBe(idle)
    expect(ctx.updater.install()).toBe(refused)
  })

  it('hands a factory updater the same busy() as the context, so install refuses mid-change', async () => {
    let seenBusy: (() => boolean) | null = null
    const off: UpdateState = { state: 'off', why: 'switched-off', current: '0.2.0' }
    const ctx = makeContext((seams) => {
      seenBusy = seams.busy
      return { state: () => off, check: async () => off, download: async () => off, install: () => ({ status: 'refused', why: 'not-ready' }) }
    })
    if (seenBusy === null) throw new Error('the factory was not called')
    const busy: () => boolean = seenBusy
    expect(busy()).toBe(false)
    const call = ctx.safety.backupStatus('/fake/Documents/Electronic Arts/The Sims 4')
    expect(busy()).toBe(true)
    await call.catch(() => {})
    expect(busy()).toBe(false)
  })

  it('keeps updates out of Documents, OneDrive and the app data folder', () => {
    const keepOutOf = updaterKeepOutOf(['C:\\Users\\Lila\\Documents', 'C:\\Users\\Lila\\Documents', ''], {
      dataDir: 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper',
      oneDriveRoots: ['C:\\Users\\Lila\\OneDrive']
    })
    expect(keepOutOf).toEqual([
      'C:\\Users\\Lila\\Documents',
      'C:\\Users\\Lila\\OneDrive',
      'C:\\Users\\Lila\\AppData\\Local\\SimsHelper'
    ])
  })

  // Both the stub and PR 13's updater decide these before they touch electron-updater, so this holds on either.
  // Outside Electron the real updater is also off as 'not-installed-app' once it reaches the engine, so that
  // reason means the install folder was let through.
  it('the updater is off for an install folder that is, holds or sits in the app data folder', async () => {
    const dataDir = 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper'
    const keepOutOf = updaterKeepOutOf(['C:\\Users\\Lila\\Documents'], { dataDir, oneDriveRoots: [] })
    for (const installDir of [dataDir, 'C:\\Users\\Lila\\AppData\\Local', `${dataDir}\\app`]) {
      const updater = createUpdater(
        { isPackaged: true, version: '0.2.0', installDir, argv: [], env: {}, keepOutOf, platform: 'win32' },
        { busy: () => false }
      )
      const state = updater.state()
      expect(state).toMatchObject({ state: 'off', current: '0.2.0' })
      expect(state.state === 'off' ? state.why : null).not.toBe('not-installed-app')
      expect((await updater.check()).state).toBe('off')
      expect(updater.install()).toEqual({ status: 'refused', why: 'not-ready' })
    }
  })

  it('busy() is true while a safety or fixes call is in flight', async () => {
    const ctx = makeContext()
    expect(ctx.busy()).toBe(false)
    const call = ctx.safety.backupStatus('/fake/Documents/Electronic Arts/The Sims 4')
    expect(ctx.busy()).toBe(true)
    await call.catch(() => {})
    expect(ctx.busy()).toBe(false)
    const fix = ctx.fixes.disabledGroups('/fake/Documents/Electronic Arts/The Sims 4')
    expect(ctx.busy()).toBe(true)
    await fix.catch(() => {})
    expect(ctx.busy()).toBe(false)
  })

  it('busy() is true while a write runs through the gate, so a state or key write is never cut by a restart', async () => {
    const ctx = makeContext()
    const write = ctx.gate.run({ reason: 'state', folderPath: null, ops: [] })
    expect(ctx.busy()).toBe(true)
    await write.catch(() => {})
    expect(ctx.busy()).toBe(false)
  })

  describe('busy() holds for a whole changing IPC call', () => {
    type Invoke = (event: IpcMainInvokeEvent, req?: unknown) => Promise<unknown>
    const EVENT = {} as IpcMainInvokeEvent

    /** registerIpc over fake handlers: each records busy() when it starts, then waits for release(). */
    function register(trusted = true) {
      const ctx = makeContext()
      const invoke = new Map<string, Invoke>()
      const seenBusy: boolean[] = []
      let release = (): void => {}
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const fake = async (): Promise<never> => {
        seenBusy.push(ctx.busy())
        await waiting
        throw new Error('the fake handler ends by failing')
      }
      const handlers = Object.fromEntries(INVOKE_CHANNELS.map((c) => [c, fake])) as unknown as Handlers<keyof IpcInvoke>
      registerIpc({ handle: (channel, fn) => void invoke.set(channel, fn as Invoke) }, ctx, () => trusted, handlers)
      const call = (channel: keyof IpcInvoke): Promise<unknown> => {
        const fn = invoke.get(channel)
        if (!fn) throw new Error(`no handler registered for ${channel}`)
        return fn(EVENT)
      }
      return { ctx, call, seenBusy, release }
    }

    it('names every channel, and no update channel counts as a change', () => {
      expect(Object.keys(CHANGING_CHANNELS).sort()).toEqual([...INVOKE_CHANNELS].sort())
      const changing = INVOKE_CHANNELS.filter((c) => CHANGING_CHANNELS[c])
      expect(changing).toEqual([
        'settings:update',
        'report:build',
        'fix:apply',
        'journal:undo',
        'fifty:start',
        'fifty:begin-round',
        'fifty:answer',
        'fifty:stop',
        'fifty:finish',
        'assist:set-key',
        'assist:clear-key',
        'share:set-role',
        'share:find-folder',
        'share:check',
        'share:settings',
        'share:send',
        'share:receive',
        'share:keep',
        'share:restore',
        'share:stop',
        'share:mod-link'
      ])
    })

    it('a 50/50 step is busy from its first line to its last, between its fixes calls too, and lets go when it fails', async () => {
      const { ctx, call, seenBusy, release } = register()
      const first = call('fifty:begin-round')
      const second = call('fix:apply')
      await Promise.resolve()
      expect(seenBusy).toEqual([true, true])
      expect(ctx.busy()).toBe(true)
      release()
      await expect(first).rejects.toThrow('the fake handler ends by failing')
      await expect(second).rejects.toThrow('the fake handler ends by failing')
      expect(ctx.busy()).toBe(false)
    })

    it('update:install and a check-up are not counted, so install can still ask busy() itself', async () => {
      const { ctx, call, seenBusy, release } = register()
      const calls = [call('update:install'), call('scan:run'), call('fifty:get')]
      await Promise.resolve()
      expect(seenBusy).toEqual([false, false, false])
      expect(ctx.busy()).toBe(false)
      release()
      await Promise.allSettled(calls)
    })

    it('a call from an untrusted sender is refused and holds nothing', async () => {
      const { ctx, call, seenBusy } = register(false)
      await expect(call('fifty:begin-round')).rejects.toThrow('untrusted sender')
      expect(seenBusy).toEqual([])
      expect(ctx.busy()).toBe(false)
    })
  })

  it('e2e launches switch updates off unless the caller says otherwise', () => {
    expect(launchEnv({ SIMS_HELPER_UPDATES: 'on', PATH: '/bin' }, {})).toMatchObject({ SIMS_HELPER_UPDATES: 'off', PATH: '/bin' })
    expect(launchEnv({}, { SIMS_HELPER_UPDATES: undefined })).not.toHaveProperty('SIMS_HELPER_UPDATES')
    expect(launchEnv({}, { SIMS_HELPER_UPDATES: 'on' })).toMatchObject({ SIMS_HELPER_UPDATES: 'on' })
  })
})

describe('50/50 control round (PR 11)', () => {
  it('the sample at round 1 has the round 0 control in its history and counts it in roundsAtMost', () => {
    const state = sampleFiftyFifty()
    expect(state.roundsAtMost).toBe(Math.ceil(Math.log2(state.groups.length)) + 1)
    expect(state.history).toEqual([{ round: 0, parked: state.suspects, answer: 'worked' }])
    expect(state.round).toBe(1)
  })
})

describe('start-up recovery (PR 10)', () => {
  function makeContext() {
    return createContext({
      host: makeFakeHost(),
      paths: appPaths({ localAppData: '/fake/LocalAppData', appData: '/fake/Roaming', desktopDir: '/fake/Desktop', env: {} }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {}
    })
  }

  it('has a journal:recovery read channel beside journal:list, and neither counts as a change', () => {
    expect(INVOKE_CHANNELS).toContain('journal:recovery')
    expect(Object.keys(fixHandlers(makeContext()))).toContain('journal:recovery')
    expect([CHANGING_CHANNELS['journal:list'], CHANGING_CHANNELS['journal:recovery']]).toEqual([false, false])
    const answers: IpcInvoke['journal:recovery']['res'][] = [
      { status: 'finished', touched: [sampleJournalEntry()] },
      { status: 'failed' }
    ]
    expect(answers.map((a) => a.status)).toEqual(['finished', 'failed'])
  })

  it('runs recover once however often it is asked, and gives the same answer each time', async () => {
    let calls = 0
    const entry = sampleJournalEntry()
    const once = onceRecovery(async () => {
      calls += 1
      return [entry]
    })
    expect(calls).toBe(0)
    const first = once()
    const second = once()
    expect(second).toBe(first)
    const expected: StartupRecovery = { status: 'finished', touched: [entry] }
    expect(await first).toEqual(expected)
    expect(await once()).toEqual(expected)
    expect(calls).toBe(1)
  })

  it('turns a recover that throws or rejects into failed, never a rejection', async () => {
    const throws = onceRecovery(() => {
      throw new Error('boom')
    })
    const rejects = onceRecovery(async () => {
      throw new Error('boom')
    })
    expect(await throws()).toEqual({ status: 'failed' })
    expect(await rejects()).toEqual({ status: 'failed' })
  })

  it('the context does not start recovery when it is built; startupRecovery() does, once', async () => {
    const ctx = makeContext()
    expect(ctx.busy()).toBe(false)
    const run = ctx.startupRecovery()
    // Counted from its first line: built from an uncounted recover, Restart now could restart mid-put-back.
    expect(ctx.busy()).toBe(true)
    expect(ctx.startupRecovery()).toBe(run)
    // 'failed' while recover is the contract's throwing stub; 'finished' once PR 9's real recover lands.
    // That a throw becomes 'failed' is pinned by the onceRecovery test above.
    expect(['failed', 'finished']).toContain((await run).status)
    expect(ctx.busy()).toBe(false)
  })

  it('forwards backup and fix progress events from startupRecovery() to emit', async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'sims-recovery-progress-')))
    try {
      const simsFolder = join(tempRoot, 'Users', 'Lila', 'Documents', 'Electronic Arts', 'The Sims 4')
      const modsDir = join(simsFolder, 'Mods', 'BuildBuy')
      const localAppData = join(tempRoot, 'LocalAppData')
      const desktopDir = join(tempRoot, 'Desktop')
      await mkdir(modsDir, { recursive: true })
      await mkdir(localAppData, { recursive: true })
      await mkdir(desktopDir, { recursive: true })
      await writeFile(join(simsFolder, 'Options.ini'), '[options]\nmodsdisabled = 0\nscriptmodsenabled = 1\n')

      const paths = appPaths({ localAppData, appData: join(tempRoot, 'Roaming'), desktopDir, env: {} })
      const heldFile = join(paths.holdingDir, 'hold-1', 'Mods', 'BuildBuy', 'lamp_a.package')
      await mkdir(dirname(heldFile), { recursive: true })
      await writeFile(heldFile, 'package-bytes')
      const sha = await sha256File(heldFile)

      await mkdir(paths.journalDir, { recursive: true })
      await writeFile(
        join(paths.journalDir, 'hold-1.json'),
        JSON.stringify(
          sampleJournalEntry({
            id: 'hold-1',
            folderPath: simsFolder,
            status: 'in-progress',
            undo: 'can-undo',
            steps: [
              {
                kind: 'move',
                from: join(modsDir, 'lamp_a.package'),
                to: heldFile,
                bytes: Buffer.byteLength('package-bytes'),
                sha256: sha,
                state: 'applied'
              }
            ]
          })
        )
      )

      const emitted: Progress[] = []
      const ctx = createContext({
        host: { ...makeFakeHost(), documentsDir: join(tempRoot, 'Users', 'Lila', 'Documents') },
        paths,
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (text) => Buffer.from(text, 'utf8'),
          decryptString: (data) => Buffer.from(data).toString('utf8')
        },
        emit: (p) => emitted.push(p),
        reveal: () => {}
      })

      const res = await ctx.startupRecovery()
      expect(res.status).toBe('finished')
      if (res.status === 'finished') {
        expect(res.touched.map((e) => [e.id, e.status])).toEqual([['hold-1', 'undone']])
      }
      expect(emitted.some((p) => p.task === 'backup')).toBe(true)
      expect(emitted.filter((p) => p.task === 'fix')).toEqual([
        { task: 'fix', stage: 'moving', done: 0, total: 1 },
        { task: 'fix', stage: 'moving', done: 1, total: 1 }
      ])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('share saves contract (PR 14)', () => {
  function makeContext(extra: Partial<CreateContextInput> = {}) {
    return createContext({
      host: makeFakeHost(),
      paths: appPaths({ localAppData: '/fake/LocalAppData', appData: '/fake/Roaming', desktopDir: '/fake/Desktop', env: {} }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {},
      ...extra
    })
  }

  it('registers every share channel from shareHandlers', () => {
    const channels: (keyof IpcInvoke)[] = [
      'share:get',
      'share:set-role',
      'share:find-folder',
      'share:check',
      'share:settings',
      'share:local-saves',
      'share:send',
      'share:receive',
      'share:keep',
      'share:old-saves',
      'share:restore',
      'share:stop',
      'share:mod-link',
      'share:open-link',
      'share:find-preview',
      'share:find-send'
    ]
    expect(Object.keys(shareHandlers(makeContext())).sort()).toEqual([...channels].sort())
    expect(INVOKE_CHANNELS.filter((c) => c.startsWith('share:'))).toEqual(channels)
  })

  it('widens the journal for a save swap and progress for a send or a get', () => {
    const kinds: ActionKind[] = ['disable-group', 'share-receive', 'share-restore']
    const origins: JournalOrigin[] = [
      { by: 'share', shareId: 's1', seq: 3 },
      { by: 'share', shareId: 's1', seq: null }
    ]
    const progress: Progress[] = [
      { task: 'share', stage: 'sending', done: 0, total: null },
      { task: 'share', stage: 'getting', done: 1, total: 2 }
    ]
    expect([kinds.length, origins.length, progress.length]).toEqual([3, 2, 2])
  })

  it('types the share view, its refusals and the start view the fake answers', () => {
    const view: ShareView = {
      link: { state: 'no-role' },
      settings: { role: null, folderLabel: null, keepOld: 5, keepInDrive: 3 },
      saves: [],
      aiFind: 'hide'
    }
    const refusals: ShareRefusal[] = [
      { why: 'game-running' },
      { why: 'not-ready', state: 'arriving' },
      { why: 'game-older', theirs: '1.110.2', ours: '1.109.4' },
      { why: 'out-of-date', detail: 'no-free-slot' }
    ]
    expect([view.link.state, refusals.length]).toEqual(['no-role', 4])
  })

  it('builds share without calling it, with no folder picked and no web page opened by default', async () => {
    const ctx = makeContext()
    expect(typeof ctx.share.view).toBe('function')
    expect(await ctx.pickFolder()).toBeNull()
    expect(await ctx.openWeb('https://www.curseforge.com/projects/1')).toBe('refused')
  })

  it('openWeb hands only the checked address to the opener, and refuses whatever the check does not pass', async () => {
    const opened: string[] = []
    const open = async (url: string) => {
      opened.push(url)
    }
    const passes = makeOpenWeb(() => ({ url: 'https://www.curseforge.com/projects/1', host: 'www.curseforge.com' }), open)
    expect(await passes('https://www.curseforge.com/projects/1#x')).toBe('opened')
    expect(opened).toEqual(['https://www.curseforge.com/projects/1'])

    const refusedNull = makeOpenWeb(() => null, open)
    const refusedThrow = makeOpenWeb(() => {
      throw new Error('boom')
    }, open)
    const noOpener = makeOpenWeb(() => ({ url: 'https://a.example/', host: 'a.example' }), undefined)
    const openerFails = makeOpenWeb(
      () => ({ url: 'https://a.example/', host: 'a.example' }),
      async () => {
        throw new Error('no browser')
      }
    )
    for (const openWeb of [refusedNull, refusedThrow, noOpener, openerFails]) {
      expect(await openWeb('http://192.168.0.1:8080/')).toBe('refused')
    }
    expect(opened).toHaveLength(1)
  })

  it('the key store find stub answers no-key, and closeUndo is a stub', async () => {
    const ctx = makeContext()
    expect(await ctx.keyStore.find({ model: 'm', system: 's', user: 'u', maxTokens: 10, searches: 3 })).toEqual({
      status: 'failed',
      why: 'no-key'
    })
    await expect(ctx.safety.closeUndo('entry-1')).rejects.toThrow('not implemented: closeUndo')
  })

  it('sampleShareView is a connected PC with one save ready to get, and takes overrides', () => {
    const view = sampleShareView()
    expect(view.link.state).toBe('connected')
    expect(view.settings.role).toBe('lila')
    expect(view.saves).toHaveLength(1)
    expect(view.saves[0]?.incoming).toMatchObject({ state: 'ready', will: 'replace', from: 'tyler' })
    expect(sampleShareView({ saves: [] }).saves).toEqual([])
  })

  it('a planned move may carry the size and hash it expects to find', () => {
    const step: PlannedStep = { kind: 'move', from: 'a', to: 'b', expect: { bytes: 10, sha256: 'c'.repeat(64) } }
    const bare: PlannedStep = { kind: 'move', from: 'a', to: 'b' }
    expect([step.kind === 'move' && step.expect?.bytes, bare.kind === 'move' && bare.expect]).toEqual([10, undefined])
  })

  it('e2e launches strip any ambient SIMS_HELPER_SHARE_DIR (any letter case) unless explicitly passed', () => {
    const cleared = launchEnv(
      { SIMS_HELPER_SHARE_DIR: 'C:\\Host\\Sims Helper Share', sims_helper_share_dir: 'C:\\Host\\Other', PATH: '/bin' },
      {}
    )
    expect(cleared).not.toHaveProperty('SIMS_HELPER_SHARE_DIR')
    expect(cleared).not.toHaveProperty('sims_helper_share_dir')
    expect(cleared['PATH']).toBe('/bin')

    const explicit = launchEnv(
      { sims_helper_share_dir: 'C:\\Host\\Other' },
      { SIMS_HELPER_SHARE_DIR: 'C:\\Temp\\Sims Helper Share' }
    )
    expect(explicit).not.toHaveProperty('sims_helper_share_dir')
    expect(explicit['SIMS_HELPER_SHARE_DIR']).toBe('C:\\Temp\\Sims Helper Share')
  })

  it('e2e launches keep ProgramW6432 in sync when ProgramFiles is overridden so Windows cmd.exe does not reset it', () => {
    const env = launchEnv(
      { ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files', PATH: '/bin' },
      { ProgramFiles: 'C:\\Temp\\big\\Program Files' }
    )
    expect(env['ProgramFiles']).toBe('C:\\Temp\\big\\Program Files')
    expect(env['ProgramW6432']).toBe('C:\\Temp\\big\\Program Files')
  })
})

describe('stage review integration invariants', () => {
  it('main/index.ts starts startupRecovery after registerIpc, guards quit until settled, and creates the window', async () => {
    const src = await readFile(join(REPO_ROOT, 'src/main/index.ts'), 'utf8')
    expect(src).not.toMatch(/await\s+ctx\.startupRecovery\(\)/)
    const registerAt = src.indexOf('registerIpc(')
    const startAt = src.indexOf('const recoveryDone = ctx.startupRecovery()')
    const guardAt = src.indexOf('createRecoveryQuitGuard(recoveryDone')
    const createAt = src.indexOf('mainWindow = createWindow()')
    expect(registerAt).toBeGreaterThan(-1)
    expect(startAt).toBeGreaterThan(registerAt)
    expect(guardAt).toBeGreaterThan(startAt)
    expect(createAt).toBeGreaterThan(guardAt)
    expect(src).toMatch(/app\.on\('before-quit'/)
    expect(src).toMatch(/quitGuard\?\.onBeforeQuit/)
    expect(src).toMatch(/quitGuard\.onWindowAllClosed/)
  })

  it('createRecoveryQuitGuard defers window-all-closed and before-quit while recovery is pending, skips quit if a window reopens, and quits immediately once settled', async () => {
    // 1. window-all-closed on Windows while recovery is unresolved -> defers quit until settled
    let resolve1!: () => void
    const recovery1 = new Promise<void>((resolve) => {
      resolve1 = resolve
    })
    let quitCalls1 = 0
    let windows1 = 0
    const guard1 = createRecoveryQuitGuard(recovery1, {
      platform: 'win32',
      quit: () => {
        quitCalls1 += 1
      },
      openWindowCount: () => windows1
    })
    guard1.onWindowAllClosed()
    expect(quitCalls1).toBe(0)
    resolve1()
    await recovery1
    await Promise.resolve()
    expect(quitCalls1).toBe(1)

    // 2. window-all-closed while unresolved, then a window reopens before recovery finishes -> does not quit; closing later quits immediately
    let resolve2!: () => void
    const recovery2 = new Promise<void>((resolve) => {
      resolve2 = resolve
    })
    let quitCalls2 = 0
    let windows2 = 0
    const guard2 = createRecoveryQuitGuard(recovery2, {
      platform: 'win32',
      quit: () => {
        quitCalls2 += 1
      },
      openWindowCount: () => windows2
    })
    guard2.onWindowAllClosed()
    windows2 = 1
    resolve2()
    await recovery2
    await Promise.resolve()
    expect(quitCalls2).toBe(0)
    windows2 = 0
    guard2.onWindowAllClosed()
    expect(quitCalls2).toBe(1)

    // 3. darwin never quits on window-all-closed, but still defers explicit before-quit
    let resolve3!: () => void
    const recovery3 = new Promise<void>((resolve) => {
      resolve3 = resolve
    })
    let quitCalls3 = 0
    const guard3 = createRecoveryQuitGuard(recovery3, {
      platform: 'darwin',
      quit: () => {
        quitCalls3 += 1
      },
      openWindowCount: () => 0
    })
    guard3.onWindowAllClosed()
    resolve3()
    await recovery3
    await Promise.resolve()
    expect(quitCalls3).toBe(0)
    guard3.onWindowAllClosed()
    expect(quitCalls3).toBe(0)

    // 4. before-quit while unresolved prevents default, coalesces repeated events + window-all-closed into one quit, and lets nested before-quit pass once settled
    let resolve4!: () => void
    const recovery4 = new Promise<void>((resolve) => {
      resolve4 = resolve
    })
    let quitCalls4 = 0
    let nestedPrevented = false
    const guard4 = createRecoveryQuitGuard(recovery4, {
      platform: 'win32',
      quit: () => {
        quitCalls4 += 1
        guard4.onBeforeQuit({
          preventDefault: () => {
            nestedPrevented = true
          }
        })
      },
      openWindowCount: () => 1
    })
    let preventedA = false
    let preventedB = false
    guard4.onBeforeQuit({ preventDefault: () => void (preventedA = true) })
    guard4.onBeforeQuit({ preventDefault: () => void (preventedB = true) })
    guard4.onWindowAllClosed()
    expect([preventedA, preventedB, quitCalls4]).toEqual([true, true, 0])
    resolve4()
    await recovery4
    await Promise.resolve()
    expect([quitCalls4, nestedPrevented]).toEqual([1, false])

    // 5. Once already settled, before-quit does not prevent default and window-all-closed quits synchronously
    let settledPrevented = false
    guard4.onBeforeQuit({ preventDefault: () => void (settledPrevented = true) })
    expect(settledPrevented).toBe(false)
  })

  it('registerIpc never leaks raw OS paths or usernames when a handler rejects', async () => {
    const ctx = createContext({
      host: makeFakeHost(),
      paths: appPaths({
        localAppData: '/fake/LocalAppData',
        appData: '/fake/Roaming',
        desktopDir: '/fake/Desktop',
        env: {}
      }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {}
    })
    const registered = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>()
    const base = collectHandlers(ctx)
    const fakeHandlers: Handlers<keyof IpcInvoke> = {
      ...base,
      'journal:list': async () => {
        throw Object.assign(
          new Error("EACCES: permission denied, scandir 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper\\journal'"),
          { code: 'EACCES', path: 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper\\journal' }
        )
      },
      'settings:get': async () => {
        throw new Error('Could not read C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Options.ini.')
      },
      'locate:run': async () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV',
          dest: 'D:\\Holding\\entry-1\\a.package'
        })
      },
      'game:check': async () => {
        throw new Error("EACCES: permission denied, open '/Users/Lila/Documents/Electronic Arts/The Sims 4/Options.ini'")
      }
    }
    registerIpc(
      {
        handle(channel, fn) {
          registered.set(channel, fn as (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>)
        }
      },
      ctx,
      () => true,
      fakeHandlers
    )

    const ev = {} as IpcMainInvokeEvent
    const rejectMsg = (channel: keyof IpcInvoke) =>
      registered.get(channel)!(ev, undefined).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      )

    expect(await rejectMsg('journal:list')).toBe('A file operation failed')
    expect(await rejectMsg('locate:run')).toBe('A file operation failed')
    expect(await rejectMsg('game:check')).toBe('A file operation failed')
    expect(await rejectMsg('settings:get')).toBe('Could not read <path>.')
  })

  it('sanitizeIpcError redacts fs errors and embedded paths while preserving plain handler errors', () => {
    const ctx = createContext({
      host: makeFakeHost(),
      paths: appPaths({
        localAppData: '/fake/LocalAppData',
        appData: '/fake/Roaming',
        desktopDir: '/fake/Desktop',
        env: {}
      }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {}
    })

    const fsObjects: unknown[] = [
      Object.assign(new Error('open failed'), { path: 'C:\\Users\\Lila\\file.txt' }),
      Object.assign(new Error('open buffer failed'), { path: Buffer.from('/Users/Lila/file.txt') }),
      Object.assign(new Error('open url failed'), { path: new URL('file:///Users/Lila/file.txt') }),
      Object.assign(new Error('rename dest failed'), { dest: 'D:\\Backups\\b1\\file.package' }),
      Object.assign(new Error('rename dest uint8 failed'), { dest: new Uint8Array([1, 2, 3]) }),
      Object.assign(new Error('stat failed'), { syscall: 'stat' }),
      Object.assign(new Error('copyfile failed'), { syscall: 'copyfile' }),
      new Error("EACCES: permission denied, scandir 'C:\\Users\\Lila\\AppData'"),
      new Error("ENOENT: no such file or directory, open '/private/var/folders/ab/cd/T/sims/Options.ini'"),
      'ERR_FS_EISDIR: illegal operation on a directory'
    ]
    for (const err of fsObjects) {
      expect(sanitizeIpcError(err, ctx.redact).message).toBe('A file operation failed')
    }
    for (const syscall of [
      'open',
      'read',
      'write',
      'stat',
      'lstat',
      'fstat',
      'statfs',
      'scandir',
      'readdir',
      'mkdir',
      'rmdir',
      'unlink',
      'rename',
      'copyfile',
      'realpath',
      'readlink',
      'chmod',
      'chown',
      'access',
      'rm',
      'link',
      'symlink',
      'mkdtemp',
      'truncate',
      'utime',
      'futime',
      'close',
      'fsync'
    ]) {
      expect(sanitizeIpcError(Object.assign(new Error(`${syscall} failed`), { syscall }), ctx.redact).message, syscall).toBe(
        'A file operation failed'
      )
    }
    for (const code of [
      'ENOENT',
      'EACCES',
      'EPERM',
      'EBUSY',
      'EEXIST',
      'EISDIR',
      'ENOTDIR',
      'ENOTEMPTY',
      'ENOSPC',
      'EMFILE',
      'ENFILE',
      'EROFS',
      'EXDEV',
      'ENAMETOOLONG',
      'ELOOP',
      'EIO',
      'EBADF',
      'EFBIG'
    ]) {
      expect(sanitizeIpcError(new Error(`${code}: fs failure`), ctx.redact).message, code).toBe('A file operation failed')
    }

    // Non-filesystem syscalls and errno codes must not falsely claim 'A file operation failed', while still redacting paths
    expect(
      sanitizeIpcError(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED', syscall: 'connect' }),
        ctx.redact
      ).message
    ).toBe('connect ECONNREFUSED 127.0.0.1:443')
    expect(
      sanitizeIpcError(
        Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
          code: 'ENOTFOUND',
          syscall: 'getaddrinfo'
        }),
        ctx.redact
      ).message
    ).toBe('getaddrinfo ENOTFOUND api.anthropic.com')
    expect(sanitizeIpcError(new Error('ECONNREFUSED: connection refused'), ctx.redact).message).toBe(
      'ECONNREFUSED: connection refused'
    )
    expect(sanitizeIpcError(new Error('ETIMEDOUT: request timed out'), ctx.redact).message).toBe(
      'ETIMEDOUT: request timed out'
    )
    expect(
      sanitizeIpcError(
        Object.assign(new Error('connect ECONNREFUSED C:\\Users\\Lila\\AppData\\Local\\pipe.sock'), {
          code: 'ECONNREFUSED',
          syscall: 'connect'
        }),
        ctx.redact
      ).message
    ).toBe('connect ECONNREFUSED <path>')

    expect(sanitizeIpcError(null, ctx.redact).message).toBe('Something went wrong')
    expect(sanitizeIpcError({ code: 42 }, ctx.redact).message).toBe('Something went wrong')

    const redactedCases: [string, string][] = [
      [
        'Could not read C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Options.ini',
        'Could not read <path>'
      ],
      [
        'Could not read C:\\Games\\Private  Profile\\Options.ini',
        'Could not read <path>'
      ],
      [
        'Failed on /Users/Lila/Private  Profile/The  Sims  4/Options.ini.',
        'Failed on <path>.'
      ],
      [
        'C:\\Users\\Lila\\My Cool Mod.package',
        '<path>'
      ],
      [
        'Corrupt mod at C:\\Users\\Lila\\Mods\\My  Cool  Mod.package',
        'Corrupt mod at <path>'
      ],
      [
        'Could not read C:\\Games\\Mods — please check Options.ini later',
        'Could not read <path> — please check Options.ini later'
      ],
      [
        'Failed at C:\\Games\\Mods and then read Options.ini',
        'Failed at <path> and then read Options.ini'
      ],
      [
        'Failed at C:\\Games\\Mods, please check Options.ini',
        'Failed at <path>, please check Options.ini'
      ],
      [
        'Failed at C:\\Games\\Mods please check Options.ini',
        'Failed at <path> please check Options.ini'
      ],
      [
        'Failed at C:\\Games\\The Sims 4 please check Options.ini',
        'Failed at <path> please check Options.ini'
      ],
      [
        'Failed at C:\\Games\\Mods (see Options.ini)',
        'Failed at <path> (see Options.ini)'
      ],
      [
        'Could not open C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4 because it is locked.',
        'Could not open <path> because it is locked.'
      ],
      [
        'Failed on D:/Games/The Sims 4/Mods/Wicked Wardrobe/mod.package!',
        'Failed on <path>!'
      ],
      [
        'Locked \\\\?\\C:\\Users\\Lila\\AppData\\Local\\SimsHelper\\journal\\e1.json',
        'Locked <path>'
      ],
      [
        'Device \\\\.\\C:\\Users\\Lila\\AppData\\file.dat failed',
        'Device <path> failed'
      ],
      [
        'JSON payload {"file":"C:\\\\Users\\\\Lila\\\\Documents\\\\Electronic Arts\\\\Options.ini"}',
        'JSON payload {"file":"<path>"}'
      ],
      [
        'Unquoted escaped C:\\\\Users\\\\Lila\\\\Documents\\\\The Sims 4\\\\Options.ini.',
        'Unquoted escaped <path>.'
      ],
      [
        'Share error at \\\\NAS\\Shared Saves\\The Sims 4\\Slot_00000002.save, retry later',
        'Share error at <path>, retry later'
      ],
      [
        'Share error at //nas/shared/The Sims 4/Slot_00000002.save.',
        'Share error at <path>.'
      ],
      [
        'Cannot open file:///C:/Users/Lila/Documents/Electronic%20Arts/Options.ini.',
        'Cannot open <path>.'
      ],
      [
        'Unreadable ~/Documents/Electronic Arts/The Sims 4/Options.ini',
        'Unreadable <path>'
      ],
      [
        'Unreadable %LOCALAPPDATA%\\SimsHelper\\journal\\entry.json',
        'Unreadable <path>'
      ],
      [
        'Unreadable $HOME/.config/sims-helper/settings.json',
        'Unreadable <path>'
      ],
      [
        'Unix home /Users/Lila/Documents/Electronic Arts/The Sims 4/Options.ini failed',
        'Unix home <path> failed'
      ],
      [
        'Folder /Users/Lila/Documents/Electronic Arts/The Sims 4 in 50/50 test and/or 11/25/2026',
        'Folder <path> in 50/50 test and/or 11/25/2026'
      ],
      [
        'Temp path (/private/var/folders/xy/z123/T/sims-helper/Mods/a.package) missing',
        'Temp path (<path>) missing'
      ],
      [
        "That didn't work at 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4' or \"/Users/Lila/Mods\"",
        "That didn't work at '<path>' or \"<path>\""
      ]
    ]
    for (const [input, expected] of redactedCases) {
      expect(sanitizeIpcError(new Error(input), ctx.redact).message, input).toBe(expected)
      expect(sanitizeIpcError(new Error(input)).message, `without redact: ${input}`).toBe(expected)
    }

    const preserved = [
      'Settings update must be an object',
      'Unknown welcome value',
      'folderPath must be text or null',
      'Selected folder was not found among your Sims 4 folders',
      'Could not save settings: check-failed',
      'fifty:answer needs a known answer',
      'fifty:answer needs the round it answers',
      'fifty:finish needs keep',
      'Could not read history',
      'Could not read set-aside mods',
      '50/50 test stopped on 11/25/2026 and/or needs https://www.curseforge.com/sims4/mods/mccc'
    ]
    for (const msg of preserved) {
      expect(sanitizeIpcError(new Error(msg), ctx.redact).message, msg).toBe(msg)
    }

    // Linear-time guard against catastrophic backtracking on long inputs
    const longText = `Could not parse ${'word '.repeat(10_000)}C:\\Users\\Lila\\Options.ini`
    const t0 = performance.now()
    expect(sanitizeIpcError(new Error(longText), ctx.redact).message.endsWith('<path>')).toBe(true)
    expect(performance.now() - t0).toBeLessThan(250)
  })

  it('fix:apply and fifty:start never overlap: fifty:start sees a group whose disable just finished, and a fix after fifty:start is refused', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'sims-stage-race-'))
    try {
      const paths = appPaths({
        localAppData: join(tempRoot, 'LocalAppData'),
        appData: join(tempRoot, 'Roaming'),
        desktopDir: join(tempRoot, 'Desktop'),
        env: {}
      })
      await mkdir(paths.stateDir, { recursive: true })

      const disabled: DisabledGroup[] = []
      let releaseFix!: () => void
      let markFixStarted!: () => void
      const waitFixStarted = new Promise<void>((resolve) => {
        markFixStarted = resolve
      })

      const baseCtx = createContext({
        host: makeFakeHost(),
        paths,
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (text) => Buffer.from(text, 'utf8'),
          decryptString: (data) => Buffer.from(data).toString('utf8')
        },
        emit: () => {},
        reveal: () => {}
      })

      const ctx = {
        ...baseCtx,
        startupRecovery: async (): Promise<StartupRecovery> => ({ status: 'finished', touched: [] }),
        gate: {
          async run(request: Parameters<typeof baseCtx.gate.run>[0]) {
            for (const op of request.ops) {
              if (op.op === 'mkdir') await mkdir(op.path, { recursive: true })
              else if (op.op === 'write') {
                await mkdir(dirname(op.path), { recursive: true })
                await writeFile(op.path, op.data)
              }
            }
            return { status: 'done' as const }
          }
        },
        fixes: {
          ...baseCtx.fixes,
          async disabledGroups() {
            return [...disabled]
          },
          async apply(_scan: ReturnType<typeof sampleScan>, request: Parameters<typeof baseCtx.fixes.apply>[1]) {
            if (request.fix === 'disable-group') {
              markFixStarted()
              await new Promise<void>((resolve) => {
                releaseFix = resolve
              })
              disabled.push({
                groupId: request.groupId,
                label: 'Hair',
                entryId: 'e-hair',
                at: '2026-11-25T12:00:00.000Z',
                origin: 'fix'
              })
            }
            return { status: 'done' as const, entry: sampleJournalEntry({ groupId: 'dir:hair' }) }
          }
        }
      }

      ctx.session.scan = sampleScan()
      const fixH = fixHandlers(ctx)
      const fiftyH = fiftyHandlers(ctx)

      const fixPromise = fixH['fix:apply']({ via: 'group', fix: 'disable-group', groupId: 'dir:hair' })
      await waitFixStarted
      const startPromise = fiftyH['fifty:start']()
      await new Promise((r) => setTimeout(r, 20))
      releaseFix()

      const [fixRes, startRes] = await Promise.all([fixPromise, startPromise])
      expect(fixRes.status).toBe('done')
      expect(startRes.status).toBe('ok')
      if (startRes.status === 'ok') {
        expect(startRes.state).not.toBeNull()
        expect(startRes.state!.groups.map((g) => g.id)).not.toContain('dir:hair')
      }

      // Now fiftyfifty.json is active: a fix must be refused.
      const afterStart = await fixH['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
      expect(afterStart).toEqual({ status: 'refused', refusal: { why: 'fifty-fifty-running' } })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
