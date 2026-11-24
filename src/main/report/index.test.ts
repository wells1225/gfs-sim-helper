// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Gate, WriteRequest } from '../ports.ts'
import { makeRedactor } from '../redact.ts'
import { buildReport, planReport } from './index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sims-helper-report-'))
  tempDirs.push(dir)
  return dir
}

describe('planReport', () => {
  it('plans exactly the listed files and redacts the user name from every name and scan content', () => {
    const redact = makeRedactor({ USERNAME: 'Lila' })
    const scan = sampleScan()

    const plan = planReport(scan, redact)
    const names = plan.map((e) => e.name)

    expect(names).toEqual([
      'lastException_63887259912.txt',
      'Options.ini',
      'GameVersion.txt',
      'scan.json',
      'AddonGameInstance.json'
    ])

    for (const entry of plan) {
      expect(entry.name.toLowerCase()).not.toContain('lila')
      if ('json' in entry.source) {
        const serialized = JSON.stringify(entry.source.json)
        expect(serialized.toLowerCase()).not.toContain('lila')
        expect(serialized).toContain('<user>')
      }
    }
  })

  it('never includes any CurseForge file other than AddonGameInstance.json', () => {
    const redact = makeRedactor({ USERNAME: 'Lila' })
    const base = sampleScan()
    const scan = sampleScan({
      inventory: {
        ...base.inventory,
        curseForge: {
          status: 'found',
          file: 'C:\\Users\\Lila\\AppData\\Roaming\\CurseForge\\agent\\auth_tokens.json',
          addons: []
        }
      }
    })

    const plan = planReport(scan, redact)
    const names = plan.map((e) => e.name)

    expect(names).toEqual([
      'lastException_63887259912.txt',
      'Options.ini',
      'GameVersion.txt',
      'scan.json'
    ])
  })
})

describe('buildReport', () => {
  it('writes one create-mode zip to Desktop through the gate, redacts all contents, and skips files over 8 MB', async () => {
    const root = await makeTempDir()
    const userDir = join(root, 'Users', 'Lila')
    const simsDir = join(userDir, 'Documents', 'Electronic Arts', 'The Sims 4')
    const cfDir = join(userDir, 'AppData', 'Roaming', 'CurseForge', 'agent', 'GameInstances')
    const desktopDir = join(userDir, 'Desktop')
    const localAppData = join(userDir, 'AppData', 'Local')

    await Promise.all([
      mkdir(simsDir, { recursive: true }),
      mkdir(cfDir, { recursive: true }),
      mkdir(desktopDir, { recursive: true })
    ])

    const logFile = 'lastException_63887259912.txt'
    const hugeLogFile = 'lastException_huge.txt'
    const cfFile = join(cfDir, 'AddonGameInstance.json')

    await writeFile(
      join(simsDir, logFile),
      '<root><report>Path: C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\mod.py</report></root>',
      'utf8'
    )
    await writeFile(join(simsDir, hugeLogFile), Buffer.alloc(8 * 1024 * 1024 + 16, 0x61))
    await writeFile(join(simsDir, 'Options.ini'), '[options]\nmodsdisabled = 1\n', 'utf8')
    await writeFile(join(simsDir, 'GameVersion.txt'), '1.129.39.1030', 'utf8')
    await writeFile(cfFile, JSON.stringify({ path: simsDir, installedAddons: [] }), 'utf8')

    const base = sampleScan()
    const scan = sampleScan({
      folder: {
        path: simsDir,
        inOneDrive: false,
        newestFileAt: new Date('2026-11-23T22:15:00.000Z')
      },
      inventory: {
        ...base.inventory,
        modsDir: join(simsDir, 'Mods'),
        curseForge: {
          status: 'found',
          file: cfFile,
          addons: []
        }
      },
      logs: [
        { ...base.logs[0]!, file: logFile },
        { ...base.logs[0]!, file: hugeLogFile }
      ]
    })

    const requests: WriteRequest[] = []
    const gate: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }

    const redact = makeRedactor({ USERNAME: 'Lila', USERPROFILE: userDir })
    const paths = appPaths({ localAppData, appData: join(userDir, 'AppData', 'Roaming'), desktopDir })
    const clock = { now: () => new Date('2026-11-24T15:30:45.000Z') }

    const { result, file } = await buildReport({ gate, paths, clock, redact }, scan)

    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return

    expect(result.fileName).toBe('Sims Helper report 20261124-153045.zip')
    expect(file).toBe(join(desktopDir, 'Sims Helper report 20261124-153045.zip'))

    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.reason).toBe('report')
    expect(req.folderPath).toBeNull()
    expect(req.ops).toHaveLength(1)

    const op = req.ops[0]!
    expect(op.op).toBe('write')
    if (op.op !== 'write') return
    expect(op.mode).toBe('create')
    expect(op.path).toBe(join(desktopDir, 'Sims Helper report 20261124-153045.zip'))
    expect(op.data).toBeInstanceOf(Uint8Array)

    const unzipped = unzipSync(op.data as Uint8Array)
    expect(Object.keys(unzipped).sort()).toEqual([
      'AddonGameInstance.json',
      'GameVersion.txt',
      'Options.ini',
      'lastException_63887259912.txt',
      'scan.json',
      'skipped.txt'
    ])

    for (const [entryName, bytes] of Object.entries(unzipped)) {
      expect(entryName.toLowerCase()).not.toContain('lila')
      const content = strFromU8(bytes)
      expect(content.toLowerCase(), `entry ${entryName}`).not.toContain('lila')
    }

    const skippedText = strFromU8(unzipped['skipped.txt']!)
    expect(skippedText).toContain('lastException_huge.txt')
  })

  it('returns write-refused when the gate refuses', async () => {
    const scan = sampleScan()
    const gate: Gate = {
      async run() {
        return { status: 'refused', refusal: { reason: 'outside-allowed-area', path: '/nope' } }
      }
    }
    const paths = appPaths({
      localAppData: '/tmp/local',
      appData: '/tmp/roaming',
      desktopDir: '/tmp/desktop'
    })
    const clock = { now: () => new Date('2026-11-24T15:30:45.000Z') }

    const { result, file } = await buildReport({ gate, paths, clock, redact: (s) => s }, scan)

    expect(file).toBeNull()
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.why).toBe('write-refused')
  })
})
