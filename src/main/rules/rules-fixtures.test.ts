// @vitest-environment node
// The rules on the real pipeline: locate, inventory (PR 4), logs (PR 5) and folder facts, on freshly generated
// fake Sims folders. Each rule fires on the fixture made for it, and nothing above info fires on clean.
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { Finding, Scan } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import { buildInventory } from '../inventory/index.ts'
import { createFixtureHost } from '../locate/fixture-host.ts'
import { locate } from '../locate/index.ts'
import { readLogs } from '../logs/index.ts'
import { readFolderFacts, runRules } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = join(THIS_DIR, '../../../scripts/fixtures/specs')
const CLI = join(THIS_DIR, 'cli.ts')

const FIXTURES = ['patch-day', 'onedrive', 'exceptions', 'nested-scripts', 'broken-packages', 'duplicates', 'clean', 'big']

type ScanInput = Omit<Scan, 'findings'>

let workDir: string
const roots = new Map<string, string>()
const scans = new Map<string, ScanInput>()

/** The same steps as the findings CLI, without the rules. */
async function scanOf(root: string): Promise<ScanInput> {
  const located = await locate(createFixtureHost(root))
  const [folder, ...otherFolders] = located.userFolders
  expect(folder, `Sims folder under ${root}`).toBeDefined()
  const paths = appPaths({
    localAppData: join(root, 'Users', 'Player', 'AppData', 'Local'),
    appData: join(root, 'Users', 'Player', 'AppData', 'Roaming'),
    desktopDir: join(root, 'Users', 'Player', 'Desktop')
  })
  const [inventory, logs, facts] = await Promise.all([
    buildInventory({ modsDir: join(folder!.path, 'Mods'), curseForgeInstanceFile: paths.curseForgeInstanceFile }),
    readLogs({ folderPath: folder!.path }),
    readFolderFacts({ folderPath: folder!.path, game: located.gameInstall })
  ])
  return {
    id: 'fixture',
    at: '2026-11-25T12:00:00.000Z',
    tookMs: 0,
    symptom: 'not-sure',
    folder: folder!,
    otherFolders,
    game: located.gameInstall,
    gameRunning: located.gameRunning,
    facts,
    inventory,
    logs
  }
}

function findingsFor(name: string): Finding[] {
  return runRules(scans.get(name)!)
}

/** The rules that fired above info, sorted. */
function loudRules(findings: Finding[]): string[] {
  return [...new Set(findings.filter((f) => f.severity !== 'info').map((f) => f.rule))].sort()
}

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-rules-fixtures-')))
  for (const name of FIXTURES) {
    const root = join(workDir, name)
    await generateFixture(await loadSpec(join(SPECS_DIR, `${name}.json`)), root)
    roots.set(name, root)
    scans.set(name, await scanOf(root))
  }
}, 120_000)

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe('rules on the real fixtures', () => {
  it.each([
    ['patch-day', ['mods-off']],
    ['onedrive', ['folder-in-onedrive', 'two-sims-folders']],
    ['exceptions', ['log-names-mod']],
    ['nested-scripts', ['package-too-deep', 'script-too-deep']],
    ['broken-packages', ['archive-in-mods', 'broken-package', 'wrong-game-package']],
    ['duplicates', ['duplicate-files']]
  ])('%s fires exactly its rules above info', (name, expected) => {
    expect(loudRules(findingsFor(name))).toEqual([...expected].sort())
  })

  it('patch-day: turned-off mods is the one stop finding', () => {
    const stops = findingsFor('patch-day').filter((f) => f.severity === 'stop')
    expect(stops.map((f) => f.rule)).toEqual(['mods-off'])
  })

  it('exceptions: the log names a real mod group, so the crash is not called causeless', () => {
    const findings = findingsFor('exceptions')
    const named = findings.filter((f) => f.rule === 'log-names-mod')
    expect(named.length).toBeGreaterThan(0)
    expect(named.every((f) => f.groupIds.length > 0)).toBe(true)
    expect(findings.some((f) => f.rule === 'crash-without-cause')).toBe(false)
    // The fixture does hold a crash log; the rule stays quiet only because a mod is named.
    expect(scans.get('exceptions')!.logs.some((l) => l.kind === 'crash')).toBe(true)
  })

  it('clean: nothing above info', () => {
    expect(loudRules(findingsFor('clean'))).toEqual([])
  })

  it.each(FIXTURES)('%s: every finding points at files and groups the inventory has', (name) => {
    const { inventory } = scans.get(name)!
    const files = new Set(inventory.files.map((f) => f.relPath))
    const groups = new Set(inventory.groups.map((g) => g.id))
    for (const f of findingsFor(name)) {
      for (const file of f.files) expect(files.has(file), `${f.id} file ${file}`).toBe(true)
      for (const id of f.groupIds) expect(groups.has(id), `${f.id} group ${id}`).toBe(true)
      for (const fix of f.fixes) {
        if ('files' in fix) for (const file of fix.files) expect(files.has(file), `${f.id} fix file ${file}`).toBe(true)
        if ('groupId' in fix) expect(groups.has(fix.groupId), `${f.id} fix group ${fix.groupId}`).toBe(true)
      }
    }
  })

  it('big: runRules takes under a second on the real inventory, logs and facts', () => {
    const scan = scans.get('big')!
    expect(scan.inventory.files.length).toBeGreaterThan(5000)
    const started = performance.now()
    runRules(scan)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('npm run findings', () => {
  function runCli(name: string, extra: string[] = []) {
    return spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', CLI, roots.get(name)!, ...extra],
      { encoding: 'utf8', timeout: 60_000 }
    )
  }

  it('patch-day: exits 0 and prints the mods-off finding', () => {
    const run = runCli('patch-day')
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('(mods-off)')
    expect(run.stdout).toContain('[Do this first')
  })

  it('exceptions: --json prints the same findings runRules gives', () => {
    const run = runCli('exceptions', ['--json'])
    expect(run.status, run.stderr).toBe(0)
    const printed = JSON.parse(run.stdout) as Finding[]
    expect(printed.map((f) => f.id)).toEqual(findingsFor('exceptions').map((f) => f.id))
  })
}, 120_000)
