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

  it('removes a user name that is also part of longer words only where it is her folder', () => {
    const redact = makeRedactor({ USERNAME: 'Ann', USERPROFILE: 'C:\\Users\\Ann' })
    const base = sampleScan()
    const folderPath = 'C:\\Users\\Ann\\Documents\\Electronic Arts\\The Sims 4'
    const scan = sampleScan({
      folder: { ...base.folder, path: folderPath },
      inventory: {
        ...base.inventory,
        modsDir: `${folderPath}\\Mods`,
        curseForge: {
          status: 'found',
          file: 'C:\\Users\\Ann\\AppData\\Roaming\\CurseForge\\agent\\GameInstances\\AddonGameInstance.json',
          addons: []
        }
      },
      logs: [
        {
          ...base.logs[0]!,
          file: 'Annabelle_lastException.txt',
          message: 'Annual event failed in C:/Users/Ann/Documents/Electronic Arts/The Sims 4/Mods/Annabelle.ts4script'
        }
      ]
    })

    const plan = planReport(scan, redact)
    expect(plan.map((e) => e.name)).toEqual([
      'Annabelle_lastException.txt',
      'Options.ini',
      'GameVersion.txt',
      'scan.json',
      'AddonGameInstance.json'
    ])
    const fileSources = plan.flatMap((e) => ('file' in e.source ? [e.source.file] : []))
    expect(fileSources[0]).toBe(`${folderPath}\\Annabelle_lastException.txt`)

    const json = JSON.stringify(plan.find((e) => e.name === 'scan.json')!.source)
    expect(json).not.toMatch(/[\\/]Ann(?=[\\/"])/)
    expect(json).toContain('<user>')
    expect(json).toContain('Annual event failed')
    expect(json).toContain('Mods/Annabelle.ts4script')
    expect(json).toContain('Annabelle_lastException.txt')
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
    // 23:30:45 on her own clock. Built from local parts, so in any time zone west of UTC the UTC date is the 25th.
    const clock = { now: () => new Date(2026, 10, 24, 23, 30, 45) }

    const { result, file } = await buildReport({ gate, paths, clock, redact }, scan)

    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return

    expect(result.fileName).toBe('Sims Helper report 20261124-233045.zip')
    expect(file).toBe(join(desktopDir, 'Sims Helper report 20261124-233045.zip'))

    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.reason).toBe('report')
    expect(req.folderPath).toBeNull()
    expect(req.ops).toHaveLength(1)

    const op = req.ops[0]!
    expect(op.op).toBe('write')
    if (op.op !== 'write') return
    expect(op.mode).toBe('create')
    expect(op.path).toBe(join(desktopDir, 'Sims Helper report 20261124-233045.zip'))
    expect(op.data).toBeInstanceOf(Uint8Array)

    const unzipped = unzipSync(op.data as Uint8Array)
    expect(Object.keys(unzipped).sort()).toEqual([
      'AddonGameInstance.json',
      'GameVersion.txt',
      'Options.ini',
      'Read me.txt',
      'lastException_63887259912.txt',
      'scan.json',
      'skipped.txt'
    ])
    expect(result.entries[0]).toBe('Read me.txt')

    for (const [entryName, bytes] of Object.entries(unzipped)) {
      expect(entryName.toLowerCase()).not.toContain('lila')
      const content = strFromU8(bytes)
      expect(content.toLowerCase(), `entry ${entryName}`).not.toContain('lila')
    }

    const readme = strFromU8(unzipped['Read me.txt']!)
    expect(readme.startsWith('Sims Helper report\n')).toBe(true)
    expect(readme).toContain('The game closes by itself')
    expect(readme).toContain('1.129.39.1030')
    expect(readme).toContain('lastException_63887259912.txt')
    expect(readme).toContain('Saves and Tray folders are never included in this report.')
    expect(readme).not.toContain(root)
    expect(readme).not.toContain(simsDir)
    expect(readme).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(readme).not.toMatch(/[\u2013\u2014]/)
    expect(readme).not.toContain('\r')

    const skippedText = strFromU8(unzipped['skipped.txt']!)
    expect(skippedText).toContain('lastException_huge.txt')
  })

  it('writes a plain-language Read me.txt with symptom, game, mods, changes, findings and logs, and no user name or paths', async () => {
    const base = sampleScan()
    const folderPath = base.folder.path
    const scan = sampleScan({
      symptom: 'freezes',
      gameRunning: 'running',
      findings: [
        base.findings[2]!,
        {
          ...base.findings[1]!,
          evidence: [
            `${folderPath}\\Mods\\Gameplay\\deep.ts4script (3 folders deep)`,
            'line 2',
            'line 3',
            'line 4',
            'line 5',
            'line 6 should not show'
          ]
        },
        base.findings[0]!
      ],
      changes: {
        sinceAt: '2026-11-20T10:00:00.000Z',
        gameVersion: { from: '1.128.0.1000', to: '1.129.39.1030' },
        added: [{ groupId: 'dir:hair', label: 'Hair', hasScript: false }],
        updated: [{ groupId: 'cf:901234', label: 'Wicked Wardrobe', hasScript: true }],
        removed: []
      }
    })

    const requests: WriteRequest[] = []
    const capture: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }
    const paths = appPaths({ localAppData: '/tmp/local', appData: '/tmp/roaming', desktopDir: '/tmp/desktop' })
    const clock = { now: () => new Date(2026, 10, 24, 12, 0, 0) }
    const redact = makeRedactor({ USERNAME: 'Lila', USERPROFILE: 'C:\\Users\\Lila' })

    const { result } = await buildReport({ gate: capture, paths, clock, redact }, scan)
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return
    expect(result.entries[0]).toBe('Read me.txt')

    const op = requests[0]!.ops[0]!
    if (op.op !== 'write') throw new Error('expected a write')
    const unzipped = unzipSync(op.data as Uint8Array)
    expect(Object.keys(unzipped)[0]).toBe('Read me.txt')
    const readme = strFromU8(unzipped['Read me.txt']!)

    expect(readme).toContain('Sims Helper report')
    expect(readme).toContain('2026-11-24T12:00:00.000Z')
    expect(readme).toContain('It freezes or gets stuck')
    expect(readme).toContain('Game version: 1.129.39.1030')
    expect(readme).toContain('Game was running: Yes')
    expect(readme).toContain('Files: 2')
    expect(readme).toContain('Mod groups: 2')
    expect(readme).toContain('Script mods: 1')
    expect(readme).toContain('Mods folder size: 1.2 MB')
    expect(readme).toContain('Options.ini: mods off, script mods off')
    expect(readme).toContain('Resource.cfg: packages load up to 5 folders deep')
    expect(readme).toContain('Game updated from 1.128.0.1000 to 1.129.39.1030')
    expect(readme).toContain('Added 1 mod: Hair')
    expect(readme).toContain('Updated 1 mod: Wicked Wardrobe')
    expect(readme).not.toContain('Removed')
    expect(readme).toContain('lastException_63887259912.txt')
    expect(readme).toContain('[Mods folder]')
    expect(readme).toContain('line 5')
    expect(readme).not.toContain('line 6 should not show')
    expect(readme).toContain('and 1 more')

    const first = readme.indexOf('[Do this first] Mods are turned off after an update')
    const second = readme.indexOf('[Worth fixing] A script mod is buried too deep in folders')
    const third = readme.indexOf('[Good to know] The thumbnail cache is older than your latest mod change')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)

    expect(readme.toLowerCase()).not.toContain('lila')
    expect(readme).not.toContain(folderPath)
    expect(readme).not.toContain('Program Files')
    expect(readme).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(readme).not.toMatch(/[\u2013\u2014]/)
    expect(readme).not.toContain('\r')
  })

  it('caps long change lists, keeps line endings to \\n, and never lets a planned file replace Read me.txt', async () => {
    const root = await makeTempDir()
    const simsDir = join(root, 'The Sims 4')
    await mkdir(simsDir, { recursive: true })
    await writeFile(join(simsDir, 'READ ME.txt'), 'not the summary', 'utf8')

    const base = sampleScan()
    const added = Array.from({ length: 13 }, (_, i) => ({ groupId: `dir:m${i}`, label: `Mod ${i + 1}`, hasScript: false }))
    const scan = sampleScan({
      folder: { ...base.folder, path: simsDir },
      inventory: { ...base.inventory, modsDir: join(simsDir, 'Mods'), curseForge: { status: 'not-found' } },
      logs: [{ ...base.logs[0]!, file: 'READ ME.txt' }],
      findings: [{ ...base.findings[0]!, detail: 'First line\r\nSecond line\rThird line' }],
      changes: { sinceAt: '2026-11-20T10:00:00.000Z', gameVersion: null, added, updated: [], removed: [] }
    })
    const requests: WriteRequest[] = []
    const gate: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }
    const paths = appPaths({ localAppData: '/tmp/local', appData: '/tmp/roaming', desktopDir: '/tmp/desktop' })
    const clock = { now: () => new Date(2026, 10, 24, 12, 0, 0) }

    const { result } = await buildReport({ gate, paths, clock, redact: makeRedactor({ USERNAME: 'Lila' }) }, scan)
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return
    expect(result.entries.filter((name) => name.toLowerCase() === 'read me.txt')).toEqual(['Read me.txt'])

    const op = requests[0]!.ops[0]!
    if (op.op !== 'write') throw new Error('expected a write')
    const unzipped = unzipSync(op.data as Uint8Array)
    expect(Object.keys(unzipped).filter((name) => name.toLowerCase() === 'read me.txt')).toEqual(['Read me.txt'])
    const readme = strFromU8(unzipped['Read me.txt']!)

    expect(readme.startsWith('Sims Helper report\n')).toBe(true)
    expect(readme).not.toContain('not the summary')
    expect(readme).toContain('Added 13 mods: Mod 1, Mod 2')
    expect(readme).toContain('Mod 10, and 3 more')
    expect(readme).not.toContain('Mod 11')
    expect(readme).not.toContain('\r')
    expect(readme).toContain('First line\nSecond line\nThird line')
  })

  it('says so plainly when there are no findings and no logs', async () => {
    const scan = sampleScan({ findings: [], logs: [], game: null, changes: null })
    const requests: WriteRequest[] = []
    const gate: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }
    const paths = appPaths({ localAppData: '/tmp/local', appData: '/tmp/roaming', desktopDir: '/tmp/desktop' })
    const clock = { now: () => new Date(2026, 10, 24, 12, 0, 0) }

    await buildReport({ gate, paths, clock, redact: makeRedactor({ USERNAME: 'Lila' }) }, scan)
    const op = requests[0]!.ops[0]!
    if (op.op !== 'write') throw new Error('expected a write')
    const readme = strFromU8(unzipSync(op.data as Uint8Array)['Read me.txt']!)

    expect(readme).toContain('Game version: Unknown')
    expect(readme).toContain('No obvious mod problems were found.')
    expect(readme).toContain('No readable crash or exception logs found.')
    expect(readme).not.toContain('What changed since')
    expect(readme.toLowerCase()).not.toContain('lila')
  })

  it('redacts usernames and emails inside changed mod labels, findings, and log names with Windows-safe zip entries and intact headings', async () => {
    const root = await makeTempDir()
    const simsDir = join(root, 'The Sims 4')
    await mkdir(simsDir, { recursive: true })
    await writeFile(join(simsDir, 'Lila_lastException.txt'), '<root>from C:\\Users\\Lila\\Mods</root>', 'utf8')

    const base = sampleScan()
    const scan = sampleScan({
      folder: { ...base.folder, path: simsDir },
      inventory: { ...base.inventory, modsDir: join(simsDir, 'Mods'), curseForge: { status: 'not-found' } },
      findings: [
        {
          ...base.findings[0]!,
          title: 'Your last exception mentions Lila.private',
          detail: 'Check Custom by Lila (lila.sims@example.com) before playing.',
          evidence: ['Mods/Lila.private.package', 'Custom by Lila_CC_Pack']
        }
      ],
      logs: [{ ...base.logs[0]!, file: 'Lila_lastException.txt' }],
      changes: {
        sinceAt: '2026-11-20T10:00:00.000Z',
        gameVersion: null,
        added: [{ groupId: 'file:lila.private.package', label: 'Lila.private', hasScript: false }],
        updated: [
          { groupId: 'dir:custom by lila', label: 'Custom by Lila (lila.sims@example.com)', hasScript: true }
        ],
        removed: []
      }
    })

    const requests: WriteRequest[] = []
    const gate: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }
    const paths = appPaths({ localAppData: '/tmp/local', appData: '/tmp/roaming', desktopDir: '/tmp/desktop' })
    const clock = { now: () => new Date(2026, 10, 24, 12, 0, 0) }
    const redact = makeRedactor({ USERNAME: 'Lila', USERPROFILE: 'C:\\Users\\Lila' })

    const { result } = await buildReport({ gate, paths, clock, redact }, scan)
    expect(result.status).toBe('saved')

    const op = requests[0]!.ops[0]!
    if (op.op !== 'write') throw new Error('expected a write')
    const unzipped = unzipSync(op.data as Uint8Array)
    const entryNames = Object.keys(unzipped)
    expect(entryNames).toContain('user_lastException.txt')
    for (const name of entryNames) {
      expect(name.toLowerCase()).not.toContain('lila')
      expect(name).not.toMatch(/[<>:"|?*]/)
    }

    const readme = strFromU8(unzipped['Read me.txt']!)
    const scanJson = strFromU8(unzipped['scan.json']!)

    expect(readme).toContain('Added 1 mod: <user>.private')
    expect(readme).toContain('Updated 1 mod: Custom by <user> (<email>)')
    expect(readme).toContain('user_lastException.txt')
    expect(readme.toLowerCase()).not.toContain('lila')
    expect(readme).not.toContain('lila.sims@example.com')

    expect(scanJson.toLowerCase()).not.toContain('lila')
    expect(scanJson).not.toContain('lila.sims@example.com')

    // Fixed headings stay intact even when the Windows username matches a word in the heading.
    requests.length = 0
    const simsRedact = makeRedactor({ USERNAME: 'Sims', USERPROFILE: 'C:\\Users\\Sims' })
    const simsRes = await buildReport({ gate, paths, clock, redact: simsRedact }, scan)
    expect(simsRes.result.status).toBe('saved')
    const simsOp = requests[0]!.ops[0]!
    if (simsOp.op !== 'write') throw new Error('expected a write')
    const simsReadme = strFromU8(unzipSync(simsOp.data as Uint8Array)['Read me.txt']!)
    expect(simsReadme.startsWith('Sims Helper report\n')).toBe(true)
  })

  it('keeps both logs when redaction maps two distinct log filenames to the same Windows-safe name', async () => {
    const root = await makeTempDir()
    const simsDir = join(root, 'The Sims 4')
    await mkdir(simsDir, { recursive: true })
    await writeFile(join(simsDir, 'lastException_Lila.txt'), '<root>first-log C:\\Users\\Lila\\Mods\\a.py</root>', 'utf8')
    await writeFile(join(simsDir, 'lastException_user.txt'), '<root>second-log-literal-user</root>', 'utf8')

    const base = sampleScan()
    const scan = sampleScan({
      folder: { ...base.folder, path: simsDir },
      inventory: { ...base.inventory, modsDir: join(simsDir, 'Mods'), curseForge: { status: 'not-found' } },
      logs: [
        { ...base.logs[0]!, file: 'lastException_Lila.txt' },
        { ...base.logs[0]!, file: 'lastException_user.txt' }
      ]
    })

    const requests: WriteRequest[] = []
    const gate: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }
    const paths = appPaths({ localAppData: '/tmp/local', appData: '/tmp/roaming', desktopDir: '/tmp/desktop' })
    const clock = { now: () => new Date(2026, 10, 24, 12, 0, 0) }
    const redact = makeRedactor({ USERNAME: 'Lila', USERPROFILE: 'C:\\Users\\Lila' })

    const { result } = await buildReport({ gate, paths, clock, redact }, scan)
    expect(result.status).toBe('saved')

    const op = requests[0]!.ops[0]!
    if (op.op !== 'write') throw new Error('expected a write')
    const unzipped = unzipSync(op.data as Uint8Array)
    expect(unzipped['lastException_user.txt']).toBeDefined()
    expect(unzipped['lastException_user (2).txt']).toBeDefined()
    expect(strFromU8(unzipped['lastException_user.txt']!)).toContain('first-log C:\\Users\\<user>\\Mods\\a.py')
    expect(strFromU8(unzipped['lastException_user.txt']!).toLowerCase()).not.toContain('lila')
    expect(strFromU8(unzipped['lastException_user (2).txt']!)).toContain('second-log-literal-user')
    const readme = strFromU8(unzipped['Read me.txt']!)
    expect(readme).toContain('- lastException_user.txt (')
    expect(readme).toContain('- lastException_user (2).txt (')
  })

  it('matches planned ZIP paths in Read me.txt for nested colliding logs across folders', async () => {
    const root = await makeTempDir()
    const simsDir = join(root, 'The Sims 4')
    await Promise.all([
      mkdir(join(simsDir, 'Mods', 'Other'), { recursive: true }),
      mkdir(join(simsDir, 'Mods', 'Lila'), { recursive: true }),
      mkdir(join(simsDir, 'Mods', 'user'), { recursive: true })
    ])
    await writeFile(join(simsDir, 'Mods', 'Other', 'mc_lastexception.html'), 'other-log', 'utf8')
    await writeFile(join(simsDir, 'Mods', 'Lila', 'mc_lastexception.html'), 'lila-log', 'utf8')
    await writeFile(join(simsDir, 'Mods', 'user', 'mc_lastexception.html'), 'user-log', 'utf8')

    const base = sampleScan()
    const scan = sampleScan({
      folder: { ...base.folder, path: simsDir },
      inventory: { ...base.inventory, modsDir: join(simsDir, 'Mods'), curseForge: { status: 'not-found' } },
      logs: [
        { ...base.logs[0]!, kind: 'mccc', file: 'Mods/Other/mc_lastexception.html' },
        { ...base.logs[0]!, kind: 'mccc', file: 'Mods/Lila/mc_lastexception.html' },
        { ...base.logs[0]!, kind: 'mccc', file: 'Mods/user/mc_lastexception.html' }
      ]
    })

    const requests: WriteRequest[] = []
    const gate: Gate = {
      async run(request) {
        requests.push(request)
        return { status: 'done' }
      }
    }
    const paths = appPaths({ localAppData: '/tmp/local', appData: '/tmp/roaming', desktopDir: '/tmp/desktop' })
    const clock = { now: () => new Date(2026, 10, 24, 12, 0, 0) }
    const redact = makeRedactor({ USERNAME: 'Lila', USERPROFILE: 'C:\\Users\\Lila' })

    const { result } = await buildReport({ gate, paths, clock, redact }, scan)
    expect(result.status).toBe('saved')

    const op = requests[0]!.ops[0]!
    if (op.op !== 'write') throw new Error('expected a write')
    const unzipped = unzipSync(op.data as Uint8Array)
    expect(unzipped['Mods/Other/mc_lastexception.html']).toBeDefined()
    expect(unzipped['Mods/user/mc_lastexception.html']).toBeDefined()
    expect(unzipped['Mods/user/mc_lastexception (2).html']).toBeDefined()

    const readme = strFromU8(unzipped['Read me.txt']!)
    expect(readme).toContain('- Mods/Other/mc_lastexception.html (')
    expect(readme).toContain('- Mods/user/mc_lastexception.html (')
    expect(readme).toContain('- Mods/user/mc_lastexception (2).html (')
    expect(readme).not.toContain('(3)')
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
