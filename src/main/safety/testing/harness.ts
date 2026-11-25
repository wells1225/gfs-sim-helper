// Test support for PR 9: a temp workspace with a fixture Sims folder, app paths and SafetyDeps around a test gate.
// Nothing in the app imports this file. Like test-gate.ts it imports no fs write function: the test file passes in
// the ones that make the temp folder and the fixture.
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { GameRunState } from '../../../shared/model.ts'
import { sha256File } from '../../fs-read.ts'
import type { AppPaths, SafetyDeps } from '../../ports.ts'
import { backupStatus } from '../index.ts'
import { makeTestGate } from './test-gate.ts'
import type { TestGate, TestGateFs } from './test-gate.ts'

export const SIMS_REL = ['Users', 'Player', 'Documents', 'Electronic Arts', 'The Sims 4'] as const

export interface WorkspaceTools {
  fs: TestGateFs
  makeTempRoot(): Promise<string> // an empty folder, links resolved
  generate(spec: string, outDir: string): Promise<void>
}

export interface Workspace {
  root: string
  simsFolder: string
  mods: string
  paths: AppPaths
  gate: TestGate
  deps: SafetyDeps
  game: { state: GameRunState | 'throws' }
}

export async function makeWorkspace(tools: WorkspaceTools, spec = 'duplicates'): Promise<Workspace> {
  const root = await tools.makeTempRoot()
  const fixtureRoot = join(root, 'fixture')
  await tools.generate(spec, fixtureRoot)
  const simsFolder = join(fixtureRoot, ...SIMS_REL)
  const dataDir = join(root, 'LocalAppData', 'SimsHelper')
  await tools.fs.mkdir(join(root, 'LocalAppData'))
  await tools.fs.mkdir(join(root, 'Desktop'))
  const paths: AppPaths = {
    dataDir,
    backupsDir: join(dataDir, 'backups'),
    holdingDir: join(dataDir, 'holding'),
    journalDir: join(dataDir, 'journal'),
    stateDir: join(dataDir, 'state'),
    keyFile: join(dataDir, 'assist', 'key.bin'),
    oldSavesDir: join(dataDir, 'old-saves'),
    shareDir: join(dataDir, 'share'),
    desktopDir: join(root, 'Desktop'),
    oneDriveRoots: [],
    curseForgeInstanceFile: null
  }
  const game: Workspace['game'] = { state: 'not-running' }
  const gameState = async (): Promise<GameRunState> => {
    if (game.state === 'throws') throw new Error('process list unavailable')
    return game.state
  }
  let tick = 0
  let ids = 0
  const deps: SafetyDeps = {
    gate: undefined as unknown as SafetyDeps['gate'],
    paths,
    clock: { now: () => new Date(Date.UTC(2026, 10, 24, 12, 0, 0) + 1000 * tick++) },
    newId: () => `20261124-120000-${String(++ids).padStart(4, '0')}`,
    gameState
  }
  const gate = makeTestGate({
    fs: tools.fs,
    dataDir,
    gameState,
    backupStatus: (folderPath) => backupStatus(deps, folderPath)
  })
  deps.gate = gate
  return { root, simsFolder, mods: join(simsFolder, 'Mods'), paths, gate, deps, game }
}

/** Every file and folder under root: relative path to SHA-256, or 'dir'. No dates. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        out[rel] = 'dir'
        await walk(full)
      } else if (entry.isFile()) {
        out[rel] = await sha256File(full)
      } else {
        out[rel] = 'link'
      }
    }
  }
  await walk(root)
  return out
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
