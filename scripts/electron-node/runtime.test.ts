// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// run.ts sets this, so a run that was meant for Electron's Node fails here if it fell back to plain Node.
const onElectronNode = process.env.SIMS_HELPER_EXPECT_ELECTRON_NODE === '1'

describe('the Electron-Node test run', () => {
  it.skipIf(!onElectronNode)("runs each test worker on the installed Electron's own Node", () => {
    const require = createRequire(import.meta.url)
    const pkg = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')) as { version: string }
    expect(process.versions.electron).toBe(pkg.version)
  })
})
