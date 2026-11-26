// npm run findings -- <fixture root> [--json]
// Locates the Sims folder in a fixture, builds the inventory and reads the logs (PRs 4 and 5), then prints findings.
import { join, resolve } from 'node:path'
import type { Finding, Scan } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import { buildInventory } from '../inventory/index.ts'
import { createFixtureHost } from '../locate/fixture-host.ts'
import { locate } from '../locate/index.ts'
import { readLogs } from '../logs/index.ts'
import { readFolderFacts, runRules } from './index.ts'

const BADGE: Record<Finding['severity'], string> = { stop: 'Do this first', warn: 'Worth fixing', info: 'Good to know' }

function format(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings.'
  return findings
    .map((f) =>
      [
        `[${BADGE[f.severity]} · ${f.certainty}] ${f.title}  (${f.id})`,
        `  ${f.detail}`,
        ...f.evidence.map((line) => `    - ${line}`),
        ...(f.fixes.length > 0 ? [`  Fix: ${f.fixes.map((x) => x.fix).join(', ')}`] : []),
        ...(f.next !== 'none' ? [`  Next: ${f.next}`] : [])
      ].join('\n')
    )
    .join('\n\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) {
    console.error('Usage: npm run findings -- <fixture root> [--json]')
    process.exitCode = 1
    return
  }
  const root = resolve(target)
  const located = await locate(createFixtureHost(root))
  const [folder, ...otherFolders] = located.userFolders
  if (!folder) {
    console.error(`No Sims 4 folder found under ${root}`)
    process.exitCode = 1
    return
  }
  const paths = appPaths({
    localAppData: join(root, 'Users', 'Player', 'AppData', 'Local'),
    appData: join(root, 'Users', 'Player', 'AppData', 'Roaming'),
    desktopDir: join(root, 'Users', 'Player', 'Desktop')
  })
  const started = Date.now()
  const [inventory, logs, facts] = await Promise.all([
    buildInventory({ modsDir: join(folder.path, 'Mods'), curseForgeInstanceFile: paths.curseForgeInstanceFile }),
    readLogs({ folderPath: folder.path }),
    readFolderFacts({ folderPath: folder.path, game: located.gameInstall })
  ])
  const scan: Omit<Scan, 'findings'> = {
    id: 'cli',
    at: new Date().toISOString(),
    tookMs: Date.now() - started,
    symptom: 'not-sure',
    folder,
    otherFolders,
    game: located.gameInstall,
    gameRunning: located.gameRunning,
    facts,
    inventory,
    logs
  }
  const findings = runRules(scan)
  console.log(args.includes('--json') ? JSON.stringify(findings, null, 2) : format(findings))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
