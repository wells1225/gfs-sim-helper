// @vitest-environment node
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { INVOKE_CHANNELS, type IpcInvoke } from '../shared/ipc.ts'
import type {
  AssistAnswer,
  BackupRefusal,
  DisabledGroup,
  FiftyDamaged,
  FixRefusal,
  GameRunState as ModelGameRunState,
  GateRefusal,
  KeySetResult,
  UpdateInstall,
  UpdateState
} from '../shared/model.ts'
import { sampleFiftyFifty, sampleJournalEntry } from '../shared/testing/sample.ts'
import { appPaths } from './app-paths.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import { collectHandlers } from './ipc.ts'
import type { Host } from './locate/host.ts'
import type { ActionPlan, AssistReply, KeyStore, PlanFixAt, PlannedStep, Updater } from './ports.ts'
import type { GameRunState as LocateGameRunState } from './locate/process.ts'
import { scanHandlers } from './scan/handlers.ts'
import { createContext, updaterKeepOutOf, type CreateContextInput } from './services.ts'
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

    const groups = [scanHandlers(ctx), fixHandlers(ctx), fiftyHandlers(ctx), assistHandlers(ctx), updateHandlers(ctx)]
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
    expect(makeContext().updater.state()).toEqual({ state: 'off', why: 'switched-off' })
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
    const off: UpdateState = { state: 'off', why: 'switched-off' }
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
      expect(state).toMatchObject({ state: 'off' })
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
