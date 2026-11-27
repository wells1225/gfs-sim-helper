// @vitest-environment node
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Progress } from '../../shared/model.ts'
import { sampleFinding, sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import type { AppContext, Gate, WriteRequest } from '../ports.ts'
import { makeRedactor } from '../redact.ts'
import { scanHandlers } from './handlers.ts'
import { folderFingerprint, readScanSnapshot } from './snapshot.ts'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeFixtureEnv(): Promise<{
  root: string
  simsDir: string
  desktopDir: string
  stateDir: string
  ctx: AppContext
  gateRequests: WriteRequest[]
  emitted: Progress[]
  revealed: string[]
}> {
  // locate() returns realpath'd folders (macOS /private/var, Windows RUNNER~1 expanded)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-handlers-')))
  tempDirs.push(root)

  const userDir = join(root, 'Users', 'Lila')
  const documentsDir = join(userDir, 'Documents')
  const simsDir = join(documentsDir, 'Electronic Arts', 'The Sims 4')
  const desktopDir = join(userDir, 'Desktop')
  const localAppData = join(userDir, 'AppData', 'Local')
  const appData = join(userDir, 'AppData', 'Roaming')

  await Promise.all([
    mkdir(join(simsDir, 'Mods'), { recursive: true }),
    mkdir(desktopDir, { recursive: true }),
    mkdir(localAppData, { recursive: true })
  ])
  await writeFile(join(simsDir, 'Options.ini'), '[options]\nmodsdisabled = 0\n', 'utf8')

  const paths = appPaths({ localAppData, appData, desktopDir })
  const gateRequests: WriteRequest[] = []
  const emitted: Progress[] = []
  const revealed: string[] = []

  const gate: Gate = {
    async run(request) {
      gateRequests.push(request)
      for (const op of request.ops) {
        if (op.op === 'mkdir') {
          await mkdir(op.path, { recursive: true })
        } else if (op.op === 'write') {
          await writeFile(op.path, op.data)
        }
      }
      return { status: 'done' }
    }
  }

  const host: Host = {
    documentsDir,
    env: { USERNAME: 'Lila', USERPROFILE: userDir },
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

  const base = sampleScan({
    folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-23T22:15:00.000Z') }
  })
  const clock = { now: () => new Date('2026-11-24T12:00:00.000Z') }

  const ctx: AppContext = {
    host,
    clock,
    paths,
    newId: () => '20261124-120000-1122',
    redact: makeRedactor(host.env),
    gameState: async () => 'not-running',
    scan: {
      buildInventory: async () => base.inventory,
      readLogs: async () => [],
      readFolderFacts: async () => base.facts,
      runRules: () => [sampleFinding()],
      clock,
      newId: () => '20261124-120000-1122',
      paths
    },
    gate,
    safety: {} as AppContext['safety'],
    fixes: {} as AppContext['fixes'],
    keyStore: {} as AppContext['keyStore'],
    updater: {} as AppContext['updater'],
    share: {} as AppContext['share'],
    pickFolder: async () => null,
    openWeb: async () => 'refused',
    openGame: async () => {
      throw new Error('not in this test')
    },
    startupRecovery: async () => ({ status: 'finished', touched: [] }),
    busy: () => false,
    session: { scan: null },
    emit: (p) => emitted.push(p),
    reveal: (file) => revealed.push(file)
  }

  return { root, simsDir, desktopDir, stateDir: paths.stateDir, ctx, gateRequests, emitted, revealed }
}

describe('scanHandlers', () => {
  it('returns default settings when missing, writes updates through the gate, and refuses unknown folderPath', async () => {
    const { simsDir, ctx, gateRequests } = await makeFixtureEnv()
    const handlers = scanHandlers(ctx)

    expect(await handlers['settings:get']()).toEqual({ welcome: 'not-seen', folderPath: null })

    await expect(handlers['settings:update']({ folderPath: '/not/a/real/sims/folder' })).rejects.toThrow()
    expect(gateRequests).toHaveLength(0)

    const updated = await handlers['settings:update']({ welcome: 'seen', folderPath: simsDir })
    expect(updated).toEqual({ welcome: 'seen', folderPath: simsDir })
    expect(gateRequests).toHaveLength(1)
    expect(gateRequests[0]?.reason).toBe('state')
    expect(gateRequests[0]?.folderPath).toBeNull()

    expect(await handlers['settings:get']()).toEqual({ welcome: 'seen', folderPath: simsDir })
  })

  it('keeps the old settings and saves no report when the gate refuses with check-failed', async () => {
    const { simsDir, desktopDir, ctx } = await makeFixtureEnv()
    ctx.gate = {
      async run(request) {
        const first = request.ops[0]!
        return { status: 'refused', refusal: { reason: 'check-failed', path: 'path' in first ? first.path : '' } }
      }
    }
    const handlers = scanHandlers(ctx)

    // The message names the reason only, never the path the check was looking at.
    const refused = await handlers['settings:update']({ welcome: 'seen', folderPath: simsDir }).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )
    expect(refused).toBe('Could not save settings: check-failed')
    expect(await handlers['settings:get']()).toEqual({ welcome: 'not-seen', folderPath: null })

    await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    const report = await handlers['report:build']()
    expect(report).toEqual({ status: 'failed', why: 'write-refused', detail: 'check-failed' })
    expect(await readdir(desktopDir)).toEqual([])
    await handlers['report:reveal']()
  })

  it('refuses scan:run for an unknown folderPath and stores the scan in ctx.session.scan when valid', async () => {
    const { simsDir, ctx, emitted } = await makeFixtureEnv()
    const handlers = scanHandlers(ctx)

    const bad = await handlers['scan:run']({ folderPath: '/nope/missing', symptom: 'closes' })
    expect(bad.status).toBe('failed')
    if (bad.status === 'failed') {
      expect(bad.why).toBe('folder-not-found')
    }
    expect(ctx.session.scan).toBeNull()

    const ok = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(ok.status).toBe('done')
    if (ok.status !== 'done') return
    expect(ctx.session.scan).toBe(ok.scan)
    expect(emitted.length).toBeGreaterThan(0)
  })

  it('refuses a folderPath that is not a string without writing or scanning', async () => {
    const { ctx, gateRequests } = await makeFixtureEnv()
    const handlers = scanHandlers(ctx)
    const scanSpy = vi.spyOn(ctx.scan, 'buildInventory')

    for (const req of [null, undefined, {}, { folderPath: 42 }, { folderPath: ['C:\\x'] }]) {
      const result = await handlers['scan:run'](req as unknown as { folderPath: string; symptom: 'closes' })
      expect(result.status).toBe('failed')
      if (result.status === 'failed') expect(result.why).toBe('folder-not-found')
    }
    expect(scanSpy).not.toHaveBeenCalled()
    expect(ctx.session.scan).toBeNull()

    for (const patch of [{ folderPath: 42 }, { folderPath: { path: 'x' } }, 'seen', 7]) {
      await expect(handlers['settings:update'](patch as unknown as { folderPath: string })).rejects.toThrow()
    }
    expect(gateRequests).toHaveLength(0)
  })

  it('locates folders, checks game state, builds a report after a scan, and reveals it', async () => {
    const { simsDir, desktopDir, ctx, revealed } = await makeFixtureEnv()
    const gameSpy = vi.spyOn(ctx, 'gameState')
    const handlers = scanHandlers(ctx)

    const located = await handlers['locate:run']()
    expect(located.folders.map((f) => f.path)).toEqual([simsDir])
    expect(located.gameRunning).toBe('not-running')

    expect(await handlers['game:check']()).toBe('not-running')
    expect(gameSpy).toHaveBeenCalledTimes(1)

    const beforeScan = await handlers['report:build']()
    expect(beforeScan.status).toBe('failed')
    if (beforeScan.status === 'failed') {
      expect(beforeScan.why).toBe('no-scan')
    }

    await handlers['scan:run']({ folderPath: simsDir, symptom: 'freezes' })

    const built = await handlers['report:build']()
    expect(built.status).toBe('saved')
    if (built.status !== 'saved') return

    await handlers['report:reveal']()
    expect(revealed).toEqual([join(desktopDir, built.fileName)])
  })

  it('waits for startupRecovery to finish before scanning', async () => {
    const { simsDir, ctx } = await makeFixtureEnv()
    const events: string[] = []
    let finishRecovery!: () => void
    ctx.startupRecovery = () =>
      new Promise((resolve) => {
        events.push('recovery:start')
        finishRecovery = () => {
          events.push('recovery:done')
          resolve({ status: 'finished', touched: [] })
        }
      })
    const origBuild = ctx.scan.buildInventory
    ctx.scan.buildInventory = async (...args) => {
      events.push('scan:inventory')
      return origBuild(...args)
    }

    const handlers = scanHandlers(ctx)
    const pending = handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toEqual(['recovery:start'])

    finishRecovery()
    const result = await pending
    expect(result.status).toBe('done')
    expect(events).toEqual(['recovery:start', 'recovery:done', 'scan:inventory'])
  })

  it('report:build waits for unresolved startupRecovery before building a report', async () => {
    const { simsDir, ctx } = await makeFixtureEnv()
    ctx.session.scan = sampleScan({
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-23T22:15:00.000Z') }
    })

    const events: string[] = []
    let finishRecovery!: () => void
    ctx.startupRecovery = () =>
      new Promise((resolve) => {
        events.push('recovery:start')
        finishRecovery = () => {
          events.push('recovery:done')
          resolve({ status: 'finished', touched: [] })
        }
      })

    const origGateRun = ctx.gate.run
    ctx.gate = {
      async run(req) {
        events.push('report:write')
        return origGateRun(req)
      }
    }

    const handlers = scanHandlers(ctx)
    let settled = false
    const pending = handlers['report:build']().then((res) => {
      settled = true
      return res
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    expect(events).toEqual(['recovery:start'])

    finishRecovery()
    const built = await pending
    expect(built.status).toBe('saved')
    expect(events).toEqual(['recovery:start', 'recovery:done', 'report:write'])
  })

  it('prevents an older out-of-order scan from overwriting a newer snapshot, reporting reversed changes, or clobbering ctx.session.scan', async () => {
    const { simsDir, stateDir, ctx, gateRequests } = await makeFixtureEnv()
    const baseInv = sampleScan({
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-23T22:15:00.000Z') }
    }).inventory
    const invA = {
      ...baseInv,
      files: [],
      groups: [
        {
          id: 'dir:mod-a',
          label: 'Mod A',
          source: 'folder' as const,
          files: [],
          bytes: 100,
          hasScript: false,
          curseForge: null
        }
      ]
    }
    const invB = {
      ...baseInv,
      files: [],
      groups: [
        ...invA.groups,
        {
          id: 'dir:mod-b',
          label: 'Mod B',
          source: 'folder' as const,
          files: [],
          bytes: 200,
          hasScript: false,
          curseForge: null
        }
      ]
    }

    let buildCall = 0
    let releaseScanA!: () => void
    const scanAStarted = new Promise<void>((resolve) => {
      ctx.scan.buildInventory = async () => {
        buildCall += 1
        if (buildCall === 1) {
          resolve()
          await new Promise<void>((r) => {
            releaseScanA = r
          })
          return invA
        }
        return invB
      }
    })

    let scanIdCounter = 0
    ctx.scan.newId = () => `20261124-120000-000${++scanIdCounter}`

    const handlers = scanHandlers(ctx)

    // Start scan A first; pause it mid-inventory
    const promiseA = handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    await scanAStarted

    // Start scan B second and let it finish completely first
    const resultB = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(resultB.status).toBe('done')
    if (resultB.status !== 'done') return
    expect(ctx.session.scan).toBe(resultB.scan)
    expect(gateRequests).toHaveLength(1)

    // Now let older scan A finish second
    releaseScanA()
    const resultA = await promiseA
    expect(resultA.status).toBe('done')
    if (resultA.status !== 'done') return

    // Scan A must NOT report reversed changes, must NOT overwrite B's snapshot, and must NOT overwrite ctx.session.scan
    expect(resultA.scan.changes).toBeNull()
    expect(ctx.session.scan).toBe(resultB.scan)
    expect(gateRequests).toHaveLength(1)

    const persisted = await readScanSnapshot(stateDir, folderFingerprint(simsDir))
    expect(persisted?.groups).toHaveLength(2)
  })
})
