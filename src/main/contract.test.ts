// @vitest-environment node
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS } from '../shared/ipc.ts'
import type { GameRunState as ModelGameRunState } from '../shared/model.ts'
import { appPaths } from './app-paths.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import { collectHandlers } from './ipc.ts'
import type { Host } from './locate/host.ts'
import type { GameRunState as LocateGameRunState } from './locate/process.ts'
import { scanHandlers } from './scan/handlers.ts'
import { createContext } from './services.ts'

const execFileAsync = promisify(execFile)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(THIS_DIR, '../..')
const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const GAME_RUN_STATE_MATCHES: AssertEqual<ModelGameRunState, LocateGameRunState> = true

function makeFakeHost(): Host {
  return {
    documentsDir: '/fake/Documents',
    env: { USERNAME: 'Lila' },
    async readRegistry() {
      return undefined
    },
    async listProcesses() {
      return []
    },
    async fileVersion() {
      return undefined
    }
  }
}

describe('contract', () => {
  it('both tsc projects from npm run typecheck exit 0', async () => {
    for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) {
      const result = await execFileAsync(process.execPath, [TSC_BIN, '--noEmit', '-p', config], {
        cwd: REPO_ROOT,
        timeout: 120_000
      })
      expect(result.stderr).toBe('')
    }
  }, 120_000)

  it('builds context and handlers without running stubs and covers every INVOKE_CHANNELS entry once', () => {
    const ctx = createContext({
      host: makeFakeHost(),
      paths: appPaths({
        localAppData: '/fake/LocalAppData',
        appData: '/fake/Roaming',
        desktopDir: '/fake/Desktop',
        env: {}
      }),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (text) => Buffer.from(text, 'utf8'),
        decryptString: (data) => Buffer.from(data).toString('utf8')
      },
      emit: () => {},
      reveal: () => {}
    })

    const groups = [scanHandlers(ctx), fixHandlers(ctx), fiftyHandlers(ctx), assistHandlers(ctx)]
    const seen = new Map<string, number>()
    for (const group of groups) {
      for (const channel of Object.keys(group)) {
        seen.set(channel, (seen.get(channel) ?? 0) + 1)
      }
    }

    for (const channel of INVOKE_CHANNELS) {
      expect(seen.get(channel), `channel ${channel}`).toBe(1)
    }
    expect(seen.size).toBe(INVOKE_CHANNELS.length)

    const merged = collectHandlers(ctx)
    expect(Object.keys(merged).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('keeps GameRunState identical between shared/model.ts and locate/process.ts', () => {
    expect(GAME_RUN_STATE_MATCHES).toBe(true)
  })
})
