import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureHost } from '../locate/fixture-host.ts'
import { locate } from '../locate/index.ts'
import { buildInventory } from './index.ts'
import { timingFailures } from './perf-gate.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(THIS_DIR, 'perf-baseline.json')
const EXPECTED_BIG_PACKAGES = 5000
const EXPECTED_BIG_SCRIPTS = 300

interface PerfBaseline {
  windowsBigMs: number | null
}

async function readBaselineMs(): Promise<number | null> {
  try {
    const raw = await readFile(BASELINE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PerfBaseline>
    if (typeof parsed.windowsBigMs === 'number' && Number.isFinite(parsed.windowsBigMs) && parsed.windowsBigMs > 0) {
      return parsed.windowsBigMs
    }
    return null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let fixtureRoot: string | undefined
  let timeMode = false

  for (const arg of args) {
    if (arg === '--time') {
      timeMode = true
    } else if (!arg.startsWith('-') && fixtureRoot === undefined) {
      fixtureRoot = arg
    } else {
      console.error(`Unknown argument: ${arg}`)
      console.error('Usage: npm run inventory -- <fixture-root> [--time]')
      process.exitCode = 1
      return
    }
  }

  if (!fixtureRoot) {
    console.error('Usage: npm run inventory -- <fixture-root> [--time]')
    process.exitCode = 1
    return
  }

  const resolvedRoot = resolve(fixtureRoot)
  const located = await locate(createFixtureHost(resolvedRoot))
  if (located.userFolders.length === 0) {
    console.error(`No Sims 4 user folder found under fixture root: ${resolvedRoot}`)
    process.exitCode = 1
    return
  }

  const modsDir = join(located.userFolders[0]!.path, 'Mods')
  const curseForgeInstanceFile = join(
    resolvedRoot,
    'Users',
    'Player',
    'AppData',
    'Roaming',
    'CurseForge',
    'agent',
    'GameInstances',
    'AddonGameInstance.json'
  )

  const start = performance.now()
  const inventory = await buildInventory({ modsDir, curseForgeInstanceFile })
  const elapsedMs = Math.round(performance.now() - start)

  if (!timeMode) {
    console.log(JSON.stringify(inventory, null, 2))
    return
  }

  const packageCount = inventory.files.filter((f) => f.kind === 'package').length
  const scriptCount = inventory.files.filter((f) => f.kind === 'script').length
  const baselineMs = await readBaselineMs()

  console.log(
    `packages=${packageCount} scripts=${scriptCount} files=${inventory.files.length} groups=${inventory.groups.length} elapsedMs=${elapsedMs}` +
      (baselineMs !== null ? ` baselineMs=${baselineMs}` : ' baselineMs=unset')
  )

  const failures: string[] = []
  if (packageCount !== EXPECTED_BIG_PACKAGES || scriptCount !== EXPECTED_BIG_SCRIPTS) {
    failures.push(
      `Expected ${EXPECTED_BIG_PACKAGES} packages and ${EXPECTED_BIG_SCRIPTS} scripts, got ${packageCount} and ${scriptCount}`
    )
  }
  failures.push(...timingFailures(elapsedMs, baselineMs))

  if (failures.length > 0) {
    for (const msg of failures) {
      console.error(msg)
    }
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
