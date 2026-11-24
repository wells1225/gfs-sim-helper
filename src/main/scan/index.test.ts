// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LocateView, Progress, SimsFolder } from '../../shared/model.ts'
import { sampleFinding, sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { ScanDeps } from '../ports.ts'
import { runScan } from './index.ts'

function makeSampleInput(): LocateView & { folder: SimsFolder; symptom: 'closes' } {
  const base = sampleScan()
  const otherFolder: SimsFolder = {
    path: 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4',
    inOneDrive: true,
    newestFileAt: new Date('2026-10-01T12:00:00.000Z')
  }
  return {
    folders: [base.folder, otherFolder],
    folder: base.folder,
    game: base.game,
    gameRunning: base.gameRunning,
    symptom: 'closes'
  }
}

function makeFakeDeps(overrides: Partial<ScanDeps> = {}): {
  deps: ScanDeps
  callOrder: string[]
  advanceClock(ms: number): void
} {
  const base = sampleScan()
  const callOrder: string[] = []
  let nowMs = new Date('2026-11-24T12:00:00.000Z').getTime()

  const deps: ScanDeps = {
    async buildInventory(input) {
      callOrder.push(`buildInventory:${input.modsDir}`)
      input.onProgress?.({ task: 'scan', stage: 'mods', done: 1, total: 2 })
      nowMs += 150
      return base.inventory
    },
    async readLogs(input) {
      callOrder.push(`readLogs:${input.folderPath}`)
      nowMs += 40
      return base.logs
    },
    async readFolderFacts(input) {
      callOrder.push(`readFolderFacts:${input.folderPath}`)
      nowMs += 20
      return base.facts
    },
    runRules(scan) {
      callOrder.push(`runRules:${scan.id}`)
      nowMs += 10
      return [sampleFinding()]
    },
    clock: {
      now: () => new Date(nowMs)
    },
    newId: () => '20261124-120000-abcd',
    paths: appPaths({
      localAppData: 'C:\\Users\\Lila\\AppData\\Local',
      appData: 'C:\\Users\\Lila\\AppData\\Roaming',
      desktopDir: 'C:\\Users\\Lila\\Desktop'
    }),
    ...overrides
  }

  return {
    deps,
    callOrder,
    advanceClock(ms: number) {
      nowMs += ms
    }
  }
}

describe('runScan', () => {
  it('runs inventory, logs, folder facts, then rules, sends all progress stages, and fills tookMs', async () => {
    const { deps, callOrder } = makeFakeDeps()
    const input = makeSampleInput()
    const progress: Progress[] = []

    const result = await runScan(deps, input, (p) => progress.push(p))

    expect(result.status).toBe('done')
    if (result.status !== 'done') return

    expect(callOrder).toEqual([
      `buildInventory:${join(input.folder.path, 'Mods')}`,
      `readLogs:${input.folder.path}`,
      `readFolderFacts:${input.folder.path}`,
      'runRules:20261124-120000-abcd'
    ])

    const stages = progress.map((p) => p.stage)
    expect(stages).toContain('counting')
    expect(stages).toContain('mods')
    expect(stages).toContain('logs')
    expect(stages).toContain('rules')
    expect(stages.indexOf('counting')).toBeLessThan(stages.indexOf('mods'))
    expect(stages.indexOf('mods')).toBeLessThan(stages.indexOf('logs'))
    expect(stages.indexOf('logs')).toBeLessThan(stages.indexOf('rules'))

    expect(result.scan.id).toBe('20261124-120000-abcd')
    expect(result.scan.tookMs).toBe(220)
    expect(result.scan.symptom).toBe('closes')
    expect(result.scan.folder.path).toBe(input.folder.path)
    expect(result.scan.otherFolders).toHaveLength(1)
    expect(result.scan.otherFolders[0]?.inOneDrive).toBe(true)
    expect(result.scan.findings).toHaveLength(1)
  })

  it('catches a thrown dep error and returns failed unexpected without throwing', async () => {
    const gateSpy = vi.fn()
    const { deps } = makeFakeDeps({
      async readLogs() {
        throw new Error('disk read timeout')
      }
    })

    const result = await runScan(deps, makeSampleInput())

    expect(result).toEqual({
      status: 'failed',
      why: 'unexpected',
      detail: 'disk read timeout'
    })
    expect(gateSpy).not.toHaveBeenCalled()
  })

  it('emits mods progress even when buildInventory does not emit progress itself', async () => {
    const base = sampleScan()
    const { deps } = makeFakeDeps({
      async buildInventory() {
        return base.inventory
      }
    })
    const progress: Progress[] = []

    const result = await runScan(deps, makeSampleInput(), (p) => progress.push(p))

    expect(result.status).toBe('done')
    expect(progress.map((p) => p.stage)).toEqual(['counting', 'mods', 'logs', 'rules', 'rules'])
  })
})
