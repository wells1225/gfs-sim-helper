/**
 * Runs the safety tests (gate and backup) on the Node inside the installed Electron, the one the app ships on,
 * with 2 workers. Unit tests elsewhere run on plain Node 22. Started from Node with spawnSync so the run waits
 * for electron.exe and its exit code is ours. Usage: npm run test:electron-node
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron') as unknown as string
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIMS_HELPER_EXPECT_ELECTRON_NODE: '1' }

const versions = spawnSync(electron, ['-p', '`Electron ${process.versions.electron}, Node ${process.versions.node}`'], {
  env,
  encoding: 'utf8'
})
if (versions.status !== 0) {
  console.error(versions.error ?? versions.stderr)
  process.exit(1)
}
console.log(`Running the safety tests on ${versions.stdout.trim()}`)

const args = [vitest, 'run', 'src/main/safety', 'scripts/electron-node', '--maxWorkers=2', '--reporter=verbose']
const run = spawnSync(electron, args, { env, stdio: 'inherit' })
if (run.error) console.error(run.error)
process.exit(run.status ?? 1)
