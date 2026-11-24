// @vitest-environment node
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { freeBytes } from './disk.ts'
import { createBackup } from './index.ts'
import { makeWorkspace, pathExists } from './testing/harness.ts'
import type { Workspace, WorkspaceTools } from './testing/harness.ts'

vi.mock('./disk.ts', () => ({ freeBytes: vi.fn() }))

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const roots: string[] = []
const TOOLS: WorkspaceTools = {
  fs: { mkdir: (p) => mkdir(p), copyFile, rename, writeFile, rm, utimes },
  makeTempRoot: async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-refuse-')))
    roots.push(root)
    return root
  },
  generate: async (spec, out) => {
    await generateFixture(await loadSpec(join(SPECS, `${spec}.json`)), out)
  }
}

beforeEach(() => {
  vi.mocked(freeBytes).mockResolvedValue(Number.MAX_SAFE_INTEGER)
})

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function expectNothingWritten(ws: Workspace): Promise<void> {
  expect(ws.gate.requests).toEqual([])
  expect(await pathExists(ws.paths.backupsDir)).toBe(false)
}

describe('createBackup refuses', () => {
  it('while the game is running', async () => {
    const ws = await makeWorkspace(TOOLS)
    ws.game.state = 'running'
    expect(await createBackup(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', reason: 'game-running' })
    await expectNothingWritten(ws)
  })

  it('when the game state is unknown, or asking for it throws', async () => {
    const ws = await makeWorkspace(TOOLS)
    ws.game.state = 'unknown'
    expect(await createBackup(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', reason: 'game-state-unknown' })
    ws.game.state = 'throws'
    expect(await createBackup(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', reason: 'game-state-unknown' })
    await expectNothingWritten(ws)
  })

  it('when the backups folder is inside a OneDrive root', async () => {
    const ws = await makeWorkspace(TOOLS)
    ws.deps.paths = { ...ws.paths, oneDriveRoots: [ws.paths.dataDir.toUpperCase()] }
    if (process.platform !== 'win32') ws.deps.paths.oneDriveRoots = [ws.paths.dataDir]
    expect(await createBackup(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', reason: 'backup-folder-in-onedrive' })
    await expectNothingWritten(ws)
  })

  it('when a part of the backups folder path starts with OneDrive', async () => {
    const ws = await makeWorkspace(TOOLS)
    const backupsDir = join(ws.root, 'OneDrive - School', 'SimsHelper', 'backups')
    ws.deps.paths = { ...ws.paths, backupsDir }
    expect(await createBackup(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', reason: 'backup-folder-in-onedrive' })
    expect(ws.gate.requests).toEqual([])
  })

  it('when there is less free space than 1.1 times the bytes to copy', async () => {
    const ws = await makeWorkspace(TOOLS)
    vi.mocked(freeBytes).mockResolvedValue(10)
    expect(await createBackup(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', reason: 'not-enough-space' })
    await expectNothingWritten(ws)
  })

  it('when the Sims folder is missing', async () => {
    const ws = await makeWorkspace(TOOLS)
    expect(await createBackup(ws.deps, join(ws.root, 'nowhere', 'The Sims 4'))).toEqual({
      status: 'refused',
      reason: 'sims-folder-missing'
    })
    await expectNothingWritten(ws)
  })

  it('while another backup is running', async () => {
    const ws = await makeWorkspace(TOOLS)
    const first = createBackup(ws.deps, ws.simsFolder)
    const second = await createBackup(ws.deps, ws.simsFolder)
    expect(second).toEqual({ status: 'refused', reason: 'backup-already-running' })
    expect((await first).status).toBe('verified')
    expect((await createBackup(ws.deps, ws.simsFolder)).status).toBe('verified')
  })

  it('to put the backup inside the Sims folder (no refusal reason exists for it, so it fails)', async () => {
    const ws = await makeWorkspace(TOOLS)
    ws.deps.paths = { ...ws.paths, backupsDir: join(ws.simsFolder, 'Backups') }
    const result = await createBackup(ws.deps, ws.simsFolder)
    expect(result.status).toBe('failed')
    expect(ws.gate.requests).toEqual([])
  })
})
