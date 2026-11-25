import { createFixtureHost } from './fixture-host.ts'
import { createRealHost, locate } from './index.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const target = args[0]

  if (!target) {
    console.error('Usage: npm run locate -- <fixture-root | --real>')
    process.exitCode = 1
    return
  }

  const host = target === '--real' ? await createRealHost() : createFixtureHost(target)
  const result = await locate(host)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
