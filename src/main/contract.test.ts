// @vitest-environment node
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { INVOKE_CHANNELS } from '../shared/ipc.ts'
import type { BackupRefusal, FixRefusal, GateRefusal, GameRunState as ModelGameRunState } from '../shared/model.ts'
import { sampleJournalEntry } from '../shared/testing/sample.ts'
import { appPaths } from './app-paths.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import { collectHandlers } from './ipc.ts'
import type { Host } from './locate/host.ts'
import type { ActionPlan, PlanFixAt, PlannedStep } from './ports.ts'
import type { GameRunState as LocateGameRunState } from './locate/process.ts'
import { scanHandlers } from './scan/handlers.ts'
import { createContext } from './services.ts'
import { shoot } from '../../test/e2e/support/app.ts'

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

    const groups = [scanHandlers(ctx), fixHandlers(ctx), fiftyHandlers(ctx), assistHandlers(ctx)]
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

describe('renderer index.html', () => {
  it('sets the Content-Security-Policy the contract names', async () => {
    const html = await readFile(join(REPO_ROOT, 'src/renderer/index.html'), 'utf8')
    const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/)
    expect(match?.[1]).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; " +
        "form-action 'none'"
    )
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
