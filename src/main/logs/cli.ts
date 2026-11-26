import { createFixtureHost } from '../locate/fixture-host.ts'
import { locate } from '../locate/index.ts'
import { readLogs } from './index.ts'

async function main(): Promise<void> {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: npm run logs -- <fixture-root>')
    process.exitCode = 1
    return
  }

  const located = await locate(createFixtureHost(target))
  const folderPath = located.userFolders[0]?.path ?? target
  const reports = await readLogs({ folderPath })
  console.log(JSON.stringify(reports, null, 2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
