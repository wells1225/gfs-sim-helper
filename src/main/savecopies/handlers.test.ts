// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import type { AppContext } from '../ports.ts'
import { createContext } from '../services.ts'
import { saveCopiesHandlers } from './handlers.ts'

const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const SIMS_REL = ['Users', 'Player', 'Documents', 'Electronic Arts', 'The Sims 4']

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function makeContext(processes: string[] = []): Promise<{ ctx: AppContext; folder: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-savecopies-ipc-')))
  roots.push(root)
  await generateFixture(await loadSpec(join(SPECS_DIR, 'p15-save-copies.json')), join(root, 'pc'))
  const folder = join(root, 'pc', ...SIMS_REL)
  const player = join(root, 'pc', 'Users', 'Player')
  await mkdir(join(player, 'Desktop'), { recursive: true })
  const paths = appPaths({
    localAppData: join(player, 'AppData', 'Local'),
    appData: join(player, 'AppData', 'Roaming'),
    desktopDir: join(player, 'Desktop')
  })
  const host: Host = {
    documentsDir: join(player, 'Documents'),
    env: { USERNAME: 'Player' },
    readRegistry: async () => undefined,
    listProcesses: async () => processes,
    fileVersion: async () => undefined
  }
  const ctx = createContext({
    host,
    paths,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    },
    emit: () => {},
    reveal: () => {}
  })
  return { ctx, folder }
}

describe('saveCopiesHandlers', () => {
  it('makes, lists and puts back through the IPC channels, using the scanned folder', async () => {
    const { ctx, folder } = await makeContext()
    ctx.session.scan = { ...sampleScan(), folder: { ...sampleScan().folder, path: folder } }
    const handlers = saveCopiesHandlers(ctx)
    expect(await handlers['savecopies:list']()).toEqual([])
    const made = await handlers['savecopies:make']({ reason: 'by-hand' })
    expect(made.kind).toBe('done')
    if (made.kind !== 'done') return
    expect(await handlers['savecopies:list']()).toEqual([made.copy])
    expect(await handlers['savecopies:put-back']({ copyId: made.copy.id, save: 'Slot_00000002.save' })).toEqual({
      kind: 'done',
      newSlot: 'Slot_00000003.save'
    })
  })

  it('falls back to the saved folder in settings.json, and answers no-folder without one', async () => {
    const { ctx, folder } = await makeContext()
    const handlers = saveCopiesHandlers(ctx)
    expect(await handlers['savecopies:make']({ reason: 'by-hand' })).toEqual({ kind: 'refused', why: 'no-folder' })
    await mkdir(ctx.paths.stateDir, { recursive: true })
    await writeFile(join(ctx.paths.stateDir, 'settings.json'), JSON.stringify({ welcome: 'seen', folderPath: folder }))
    expect((await handlers['savecopies:make']({ reason: 'by-hand' })).kind).toBe('done')
  })

  it('refuses while the game runs', async () => {
    const { ctx, folder } = await makeContext(['TS4_x64.exe'])
    ctx.session.scan = { ...sampleScan(), folder: { ...sampleScan().folder, path: folder } }
    const handlers = saveCopiesHandlers(ctx)
    expect(await handlers['savecopies:make']({ reason: 'by-hand' })).toEqual({ kind: 'refused', why: 'game-running' })
  })

  it('does not trust the window: a bad reason or put-back request is refused calmly', async () => {
    const { ctx, folder } = await makeContext()
    ctx.session.scan = { ...sampleScan(), folder: { ...sampleScan().folder, path: folder } }
    const handlers = saveCopiesHandlers(ctx)
    const anyHandlers = handlers as unknown as Record<string, (req: unknown) => Promise<unknown>>
    expect(await anyHandlers['savecopies:make']!({ reason: 'whenever' })).toEqual({ kind: 'refused', why: 'error' })
    expect(await anyHandlers['savecopies:make']!(undefined)).toEqual({ kind: 'refused', why: 'error' })
    expect(await anyHandlers['savecopies:put-back']!({ copyId: 3, save: 'x' })).toEqual({
      kind: 'refused',
      why: 'not-found'
    })
    expect(await anyHandlers['savecopies:put-back']!(null)).toEqual({ kind: 'refused', why: 'not-found' })
  })
})
