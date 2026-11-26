// @vitest-environment node
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { ModFile, Progress, ResourceCfgRead, Scan } from '../../shared/model.ts'
import { sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { FixDeps, Safety } from '../ports.ts'
import { readResourceCfg } from '../inventory/resource-cfg.ts'
import { backupStatus, createBackup, listJournal, recover, runAction, undo } from '../safety/index.ts'
import { makeWorkspace, pathExists, snapshotTree } from '../safety/testing/harness.ts'
import type { Workspace, WorkspaceTools } from '../safety/testing/harness.ts'
import { applyFix, planFix } from './index.ts'

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-move-package-up-')))
  roots.push(root)
  return root
}

const TOOLS: WorkspaceTools = {
  fs: { mkdir, copyFile, rename, writeFile, rm, utimes },
  makeTempRoot: tempRoot,
  generate: async (spec, out) => {
    await generateFixture(await loadSpec(join(SPECS, `${spec}.json`)), out)
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function pkg(relPath: string): ModFile {
  return {
    kind: 'package',
    relPath,
    bytes: 1000,
    modifiedAt: '2026-11-15T12:00:00.000Z',
    hash: { status: 'not-needed' },
    groupId: `dir:${relPath.split('/')[0]!.toLowerCase()}`,
    depth: relPath.split('/').length - 1,
    dbpf: { status: 'ok', keyCount: 1 }
  }
}

function script(relPath: string): ModFile {
  return {
    kind: 'script',
    relPath,
    bytes: 1000,
    modifiedAt: '2026-11-15T12:00:00.000Z',
    hash: { status: 'not-needed' },
    groupId: `dir:${relPath.split('/')[0]!.toLowerCase()}`,
    depth: relPath.split('/').length - 1,
    script: { status: 'ok', entries: ['a.pyc'] }
  }
}

function withPackages(files: ModFile[], resourceCfg: ResourceCfgRead, at?: { folderPath: string; modsDir: string }): Scan {
  const base = sampleScan()
  return {
    ...base,
    folder: { ...base.folder, path: at?.folderPath ?? base.folder.path },
    inventory: { ...base.inventory, modsDir: at?.modsDir ?? base.inventory.modsDir, files, groups: [], resourceCfg },
    findings: []
  }
}

const at = { holdingDir: join('/data', 'holding'), entryId: 'entry-42' }
const OK5: ResourceCfgRead = { status: 'ok', maxPackageDepth: 5 }
const OK3: ResourceCfgRead = { status: 'ok', maxPackageDepth: 3 }
const FILE_CHANGED = { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
const NOTHING_TO_DO = { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }

describe('planFix move-package-up', () => {
  it('keeps the first 5 folders when Resource.cfg is missing', () => {
    const scan = withPackages([pkg('CAS/a/b/c/d/e/six.package')], { status: 'missing' })
    const result = planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/d/e/six.package'] }, at)
    expect(result).toEqual({
      status: 'planned',
      plan: {
        entryId: 'entry-42',
        action: 'move-package-up',
        summary: 'Moved 1 package file up within the folder limit',
        origin: { by: 'fix' },
        folderPath: scan.folder.path,
        groupId: null,
        groupLabel: null,
        hasScript: false,
        steps: [
          {
            kind: 'move',
            from: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'c', 'd', 'e', 'six.package'),
            to: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'c', 'd', 'six.package')
          }
        ]
      }
    })
  })

  it('keeps the first 5 folders when Resource.cfg says 5', () => {
    const scan = withPackages([pkg('CAS/a/b/c/d/e/f/g/eight.package')], OK5)
    const result = planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/d/e/f/g/eight.package'] }, at)
    if (result.status !== 'planned') throw new Error(result.status)
    expect(result.plan.steps).toEqual([
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'eight.package'),
        to: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'c', 'd', 'eight.package')
      }
    ])
  })

  it('keeps the first 3 folders when Resource.cfg says 3, and counts the files in the summary', () => {
    const files = ['CAS/a/b/c/four.package', 'CAS/a/b/c/d/e/six.package']
    const scan = withPackages(files.map(pkg), OK3)
    const result = planFix(scan, { fix: 'move-package-up', files }, at)
    if (result.status !== 'planned') throw new Error(result.status)
    expect(result.plan.summary).toBe('Moved 2 package files up within the folder limit')
    expect(result.plan.steps).toEqual([
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'c', 'four.package'),
        to: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'four.package')
      },
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'c', 'd', 'e', 'six.package'),
        to: join(scan.inventory.modsDir, 'CAS', 'a', 'b', 'six.package')
      }
    ])
  })

  it('moves the file right into Mods when Resource.cfg says 0', () => {
    const scan = withPackages([pkg('CAS/Hair/braids.package')], { status: 'ok', maxPackageDepth: 0 })
    const result = planFix(scan, { fix: 'move-package-up', files: ['CAS/Hair/braids.package'] }, at)
    if (result.status !== 'planned') throw new Error(result.status)
    expect(result.plan.steps).toEqual([
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'CAS', 'Hair', 'braids.package'),
        to: join(scan.inventory.modsDir, 'braids.package')
      }
    ])
  })

  it('moves each file once when the request names it twice, in any case', () => {
    const scan = withPackages([pkg('CAS/a/b/c/four.package')], OK3)
    const result = planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/four.package', 'cas/A/b/C/Four.package'] }, at)
    if (result.status !== 'planned') throw new Error(result.status)
    expect(result.plan.steps).toHaveLength(1)
    expect(result.plan.summary).toBe('Moved 1 package file up within the folder limit')
  })

  it('refuses with file-changed when Resource.cfg could not be read', () => {
    const scan = withPackages([pkg('CAS/a/b/c/d/e/six.package')], { status: 'unreadable', detail: 'EACCES' })
    expect(planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/d/e/six.package'] }, at)).toEqual(FILE_CHANGED)
  })

  it('refuses with file-changed when the Resource.cfg depth is not a whole number of folders', () => {
    for (const maxPackageDepth of [-1, 2.5, Number.NaN]) {
      const scan = withPackages([pkg('CAS/a/b/c/d/e/six.package')], { status: 'ok', maxPackageDepth })
      expect(planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/d/e/six.package'] }, at)).toEqual(FILE_CHANGED)
    }
  })

  it('refuses with nothing-to-do when the file is already within the folder limit', () => {
    const scan = withPackages([pkg('CAS/a/b/c/four.package')], OK5)
    expect(planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/four.package'] }, at)).toEqual(NOTHING_TO_DO)
    expect(planFix(scan, { fix: 'move-package-up', files: [] }, at)).toEqual(NOTHING_TO_DO)
  })

  it('refuses with file-changed when a file in the scan already sits at the destination, in any case', () => {
    const scan = withPackages([pkg('CAS/a/b/c/four.package'), pkg('cas/A/B/Four.PACKAGE')], OK3)
    expect(planFix(scan, { fix: 'move-package-up', files: ['CAS/a/b/c/four.package'] }, at)).toEqual(FILE_CHANGED)
  })

  it('refuses with file-changed when something on disk already sits at the destination', () => {
    const scan = withPackages([pkg('CAS/a/b/c/four.package')], OK3)
    const result = planFix(
      scan,
      { fix: 'move-package-up', files: ['CAS/a/b/c/four.package'] },
      { ...at, existingModPaths: ['cas/a/b/FOUR.package'] }
    )
    expect(result).toEqual(FILE_CHANGED)
  })

  it('refuses with file-changed when two deep files would land on the same name', () => {
    const files = ['CAS/a/b/c/dress.package', 'CAS/a/b/d/Dress.package']
    const scan = withPackages(files.map(pkg), OK3)
    expect(planFix(scan, { fix: 'move-package-up', files }, at)).toEqual(FILE_CHANGED)
  })

  it('refuses with file-changed for a file that is not a package, not in the scan, or not a safe path', () => {
    const scan = withPackages([script('Scripts/a/b/c/d/e/f/mod.ts4script'), pkg('CAS/a/b/c/d/e/six.package')], OK3)
    for (const relPath of ['Scripts/a/b/c/d/e/f/mod.ts4script', 'Missing/a/b/c/d/x.package', '../CAS/a/b/c/d/e/six.package', 'C:/x.package']) {
      expect(planFix(scan, { fix: 'move-package-up', files: [relPath] }, at)).toEqual(FILE_CHANGED)
    }
  })
})

describe('applyFix move-package-up', () => {
  it('refuses with file-changed, and runs nothing, when the destination exists on disk but not in the scan', async () => {
    const root = await tempRoot()
    const modsDir = join(root, 'Mods')
    await mkdir(join(modsDir, 'CAS', 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(modsDir, 'CAS', 'a', 'b', 'four.package'), 'already here')
    const scan = withPackages([pkg('CAS/a/b/c/four.package')], OK3, { folderPath: root, modsDir })
    const runActionSpy = vi.fn<Safety['runAction']>()
    const deps: FixDeps = {
      safety: { runAction: runActionSpy } as unknown as Safety,
      paths: appPaths({ localAppData: join(root, 'LocalAppData'), appData: join(root, 'Roaming'), desktopDir: join(root, 'Desktop') }),
      newId: () => 'entry-1'
    }

    expect(await applyFix(deps, scan, { fix: 'move-package-up', files: ['CAS/a/b/c/four.package'] })).toEqual(FILE_CHANGED)
    expect(runActionSpy).not.toHaveBeenCalled()
  })

  async function refusesWhenResourceCfgIs(
    scanCfg: ResourceCfgRead,
    onDisk: (modsDir: string) => Promise<void>
  ): Promise<void> {
    const root = await tempRoot()
    const modsDir = join(root, 'Mods')
    await mkdir(join(modsDir, 'CAS', 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    await onDisk(modsDir)
    const deepRel = 'CAS/a/b/c/d/e/six.package'
    const scan = withPackages([pkg(deepRel)], scanCfg, { folderPath: root, modsDir })
    const runActionSpy = vi.fn<Safety['runAction']>()
    const createBackupSpy = vi.fn<Safety['createBackup']>()
    const backupStatusSpy = vi.fn<Safety['backupStatus']>()
    const deps: FixDeps = {
      safety: { runAction: runActionSpy, createBackup: createBackupSpy, backupStatus: backupStatusSpy } as unknown as Safety,
      paths: appPaths({ localAppData: join(root, 'LocalAppData'), appData: join(root, 'Roaming'), desktopDir: join(root, 'Desktop') }),
      newId: () => 'entry-1'
    }
    const before = await snapshotTree(root)

    expect(await applyFix(deps, scan, { fix: 'move-package-up', files: [deepRel] })).toEqual(FILE_CHANGED)
    expect(runActionSpy).not.toHaveBeenCalled()
    expect(createBackupSpy).not.toHaveBeenCalled()
    expect(await snapshotTree(root)).toEqual(before)
  }

  it('refuses with file-changed when Resource.cfg was missing at scan time but now sets a smaller depth', async () => {
    await refusesWhenResourceCfgIs({ status: 'missing' }, (modsDir) =>
      writeFile(join(modsDir, 'Resource.cfg'), 'Priority 500\nPackedFile */*/*.package\n')
    )
  })

  it('refuses with file-changed when Resource.cfg now sets a different depth than at scan time', async () => {
    await refusesWhenResourceCfgIs(OK3, (modsDir) =>
      writeFile(join(modsDir, 'Resource.cfg'), 'Priority 500\nPackedFile */*.package\n')
    )
  })

  it('refuses with file-changed when Resource.cfg was deleted since scan time', async () => {
    await refusesWhenResourceCfgIs(OK3, async () => {})
  })

  it('refuses with file-changed when Resource.cfg cannot be read now', async () => {
    await refusesWhenResourceCfgIs(OK3, (modsDir) => mkdir(join(modsDir, 'Resource.cfg')))
  })

  function realSafety(ws: Workspace): Safety {
    return {
      backupStatus: (folderPath) => backupStatus(ws.deps, folderPath),
      backupSummary: async () => ({
        status: { state: 'none' },
        verifiedCount: 0,
        totalBytes: 0,
        reclaimableBytes: 0,
        reclaimableBackups: 0,
        canPrune: false
      }),
      pruneBackups: async () => ({ status: 'refused', why: 'nothing-to-prune' }),
      createBackup: (folderPath, onProgress) => createBackup(ws.deps, folderPath, onProgress),
      runAction: (plan, onProgress) => runAction(ws.deps, plan, onProgress),
      undo: (entryId, onProgress) => undo(ws.deps, entryId, onProgress),
      listJournal: () => listJournal(ws.deps),
      recover: (onProgress) => recover(ws.deps, onProgress),
      async closeUndo() {}
    }
  }

  it('makes a safety copy first, moves a deep package up inside Mods, and Undo puts it back in its old folder', async () => {
    const ws = await makeWorkspace(TOOLS)
    const deepRel = 'CAS/Outfits/Formal/Winter/deep_dress.package'
    const deepPath = join(ws.mods, 'CAS', 'Outfits', 'Formal', 'Winter', 'deep_dress.package')
    const movedPath = join(ws.mods, 'CAS', 'Outfits', 'Formal', 'deep_dress.package')
    await mkdir(dirname(deepPath), { recursive: true })
    await writeFile(deepPath, 'DBPF deep dress bytes')
    // Resource.cfg on disk says 3, the same as the scan, so applyFix's fresh read agrees with it.
    await writeFile(join(ws.mods, 'Resource.cfg'), 'Priority 500\nPackedFile */*/*/*.package\n')
    expect(await readResourceCfg(ws.mods)).toEqual(OK3)
    const before = await snapshotTree(ws.simsFolder)
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).not.toBe('verified')

    const scan = withPackages([pkg(deepRel)], OK3, { folderPath: ws.simsFolder, modsDir: ws.mods })
    const safety = realSafety(ws)
    const deps: FixDeps = { safety, paths: ws.paths, newId: ws.deps.newId }
    const progress: Progress[] = []

    const outcome = await applyFix(deps, scan, { fix: 'move-package-up', files: [deepRel] }, (p) => progress.push(p))

    if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome))
    expect(outcome.entry).toMatchObject({
      action: 'move-package-up',
      summary: 'Moved 1 package file up within the folder limit',
      status: 'done',
      undo: 'can-undo'
    })
    expect(outcome.entry.backupId).toEqual(expect.any(String))
    expect(progress.some((p) => p.task === 'backup')).toBe(true)
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')
    expect(await pathExists(deepPath)).toBe(false)
    expect(await pathExists(movedPath)).toBe(true)
    const fixOps = ws.gate.requests.filter((r) => r.reason === 'fix').flatMap((r) => r.ops)
    expect(fixOps.some((op) => op.op === 'move')).toBe(true)
    expect(fixOps.some((op) => op.op === 'remove')).toBe(false)

    const undone = await safety.undo(outcome.entry.id)

    expect(undone).toMatchObject({ status: 'done', entry: { status: 'undone' } })
    expect(await pathExists(deepPath)).toBe(true)
    expect(await pathExists(movedPath)).toBe(false)
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
  })
})
