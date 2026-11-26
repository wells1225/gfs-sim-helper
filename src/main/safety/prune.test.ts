// @vitest-environment node
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { sampleJournalEntry } from '../../shared/testing/sample.ts'
import { openForRead, sha256File } from '../fs-read.ts'
import type { ReadOnlyFile } from '../fs-read.ts'
import { tracked } from './backup.ts'
import { backupStatus, backupSummary, createBackup, pruneBackups, runAction, undo } from './index.ts'
import { oneAtATime } from './lock.ts'
import { manifestFile, manifestJson, newestVerified, readManifest } from './manifest.ts'
import type { Manifest } from './manifest.ts'
import { canReadFilePayload, pruneBackupsNow, readBackupSummary, storedCopiesHashIntact } from './prune.ts'
import { makeWorkspace, pathExists } from './testing/harness.ts'
import type { Workspace, WorkspaceTools } from './testing/harness.ts'
import { makeTestGate } from './testing/test-gate.ts'

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const roots: string[] = []
const TOOLS: WorkspaceTools = {
  fs: { mkdir, copyFile, rename, writeFile, rm, utimes },
  makeTempRoot: async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-prune-')))
    roots.push(root)
    return root
  },
  generate: async (spec, out) => {
    await generateFixture(await loadSpec(join(SPECS, `${spec}.json`)), out)
  }
}

async function restoreModes(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => {})
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await restoreModes(full)
    else await chmod(full, 0o600).catch(() => {})
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await restoreModes(root)
    await rm(root, { recursive: true, force: true })
  }
})

async function makeVerifiedBackup(ws: Workspace, touchRel?: string, content?: string) {
  if (touchRel !== undefined && content !== undefined) {
    const target = join(ws.mods, ...touchRel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    const bump = ws.deps.clock.now()
    await utimes(target, bump, bump)
  }
  const res = await createBackup(ws.deps, ws.simsFolder)
  if (res.status !== 'verified') throw new Error(`expected verified backup, got ${JSON.stringify(res)}`)
  return res.record
}

describe('backupSummary and pruneBackups', () => {
  it('keeps newest 2 verified backups per folder and reports nothing-to-prune once settled', async () => {
    const ws = await makeWorkspace(TOOLS)
    const b1 = await makeVerifiedBackup(ws, 'extra_1.package', 'v1-bytes-aaaa')
    const b2 = await makeVerifiedBackup(ws, 'extra_1.package', 'v2-bytes-bbbbbbbb')
    const b3 = await makeVerifiedBackup(ws, 'extra_1.package', 'v3-bytes-cccccccccccc')
    const b4 = await makeVerifiedBackup(ws, 'extra_1.package', 'v4-bytes-dddddddddddddddd')

    const before = await backupSummary(ws.deps, ws.simsFolder)
    expect(before.status).toEqual({ state: 'verified', backupId: b4.id, at: b4.at })
    expect(before.verifiedCount).toBe(4)
    expect(before.reclaimableBackups).toBe(2)
    expect(before.reclaimableBytes).toBeGreaterThan(0)
    expect(before.canPrune).toBe(true)

    const pruned = await pruneBackups(ws.deps, ws.simsFolder)
    expect(pruned.status).toBe('done')
    if (pruned.status !== 'done') return

    expect(pruned.removedBackups).toBe(2)
    expect(pruned.freedBytes).toBe(before.reclaimableBytes)
    expect(pruned.summary.verifiedCount).toBe(2)
    expect(pruned.summary.reclaimableBackups).toBe(0)
    expect(pruned.summary.reclaimableBytes).toBe(0)
    expect(pruned.summary.canPrune).toBe(false)
    expect(pruned.summary.totalBytes).toBe(before.totalBytes - pruned.freedBytes)

    expect(await pathExists(manifestFile(ws.paths.backupsDir, b1.id))).toBe(false)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b2.id))).toBe(false)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b3.id))).toBe(true)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b4.id))).toBe(true)
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({ state: 'verified', backupId: b4.id, at: b4.at })

    // Second prune finds nothing left to remove
    const mark = ws.gate.requests.length
    expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'nothing-to-prune' })
    expect(ws.gate.requests.length).toBe(mark)
  })

  it('keeps an older intact verified backup when the newest verified backups lost a stored file externally', async () => {
    const ws = await makeWorkspace(TOOLS)
    const b1 = await makeVerifiedBackup(ws, 'mod_x.package', 'version-1')
    const b2 = await makeVerifiedBackup(ws, 'mod_x.package', 'version-2')
    const b3 = await makeVerifiedBackup(ws, 'mod_x.package', 'version-3')
    const b4 = await makeVerifiedBackup(ws, 'mod_x.package', 'version-4')

    // Simulate external damage to b4 and b3 stored copies
    await rm(join(ws.paths.backupsDir, b4.id, 'files', 'Mods', 'mod_x.package'))
    await rm(join(ws.paths.backupsDir, b3.id, 'files', 'Mods', 'mod_x.package'))

    const pruned = await pruneBackups(ws.deps, ws.simsFolder)
    expect(pruned.status).toBe('done')
    if (pruned.status !== 'done') return

    // b4 and b3 are top-2, AND b2 is the newest intact verified backup -> all 3 kept, only b1 pruned!
    expect(pruned.removedBackups).toBe(1)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b1.id))).toBe(false)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b2.id))).toBe(true)
    expect(await pathExists(join(ws.paths.backupsDir, b2.id, 'files', 'Mods', 'mod_x.package'))).toBe(true)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b3.id))).toBe(true)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b4.id))).toBe(true)
  })

  it('protects shared donor files via storedIn: removes B1 manifest first, removes unreferenced files and empty dirs, and keeps a.package', async () => {
    const ws = await makeWorkspace(TOOLS)
    const aPath = join(ws.mods, 'a.package')
    const bPath = join(ws.mods, 'b.package')
    const deepOld = join(ws.mods, 'OldSub', 'Leaf', 'only_b1.package')
    await mkdir(dirname(deepOld), { recursive: true })
    await writeFile(aPath, 'shared-bytes-a-stays-untouched')
    await writeFile(bPath, 'b-bytes-v1')
    await writeFile(deepOld, 'only-in-b1-bytes')
    const t1 = new Date('2026-11-20T10:00:00.000Z')
    await utimes(aPath, t1, t1)
    await utimes(bPath, t1, t1)
    await utimes(deepOld, t1, t1)
    const aSha = await sha256File(aPath)

    // B1 stores a.package, b.package (v1), and OldSub/Leaf/only_b1.package
    const b1 = await makeVerifiedBackup(ws)

    // Remove OldSub/Leaf/only_b1.package from Mods and update b.package -> B2 reuses a.package from B1
    await rm(join(ws.mods, 'OldSub'), { recursive: true, force: true })
    const b2 = await makeVerifiedBackup(ws, 'b.package', 'b-bytes-v2-changed')

    // Update b.package again -> B3 still reuses a.package from B1
    const b3 = await makeVerifiedBackup(ws, 'b.package', 'b-bytes-v3-changed-again')

    const m3 = await readManifest(ws.paths.backupsDir, b3.id)
    expect(m3?.files.find((f) => f.path === 'Mods/a.package')?.storedIn).toBe(b1.id)

    const mark = ws.gate.requests.length
    const pruned = await pruneBackups(ws.deps, ws.simsFolder)
    expect(pruned.status).toBe('done')
    if (pruned.status !== 'done') return

    const pruneRequests = ws.gate.requests.slice(mark)
    expect(pruneRequests.length).toBeGreaterThanOrEqual(2)
    for (const req of pruneRequests) {
      expect(req.reason).toBe('backup')
      expect(req.folderPath).toBeNull()
      expect(req.ops.length).toBeLessThanOrEqual(200)
    }

    // Phase 1 removes B1's manifest.json BEFORE Phase 2 removes any file in B1/files/
    const b1Manifest = manifestFile(ws.paths.backupsDir, b1.id)
    const b1FileB = join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'b.package')
    const b1FileA = join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'a.package')
    const reqIdxOf = (target: string) =>
      pruneRequests.findIndex((r) => r.ops.some((op) => op.op === 'remove' && op.path === target))

    expect(reqIdxOf(b1Manifest)).toBe(0)
    expect(reqIdxOf(b1FileB)).toBeGreaterThan(reqIdxOf(b1Manifest))

    expect(await pathExists(b1Manifest)).toBe(false)
    expect(await pathExists(b1FileB)).toBe(false)
    expect(await pathExists(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'OldSub'))).toBe(false)
    expect(await pathExists(b1FileA)).toBe(true)
    expect(await sha256File(b1FileA)).toBe(aSha)

    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'verified',
      backupId: b3.id,
      at: b3.at
    })
  })

  it('protects backupId (even if manifest is missing) and holding/<entryId> for can-undo, in-progress, and needs-attention journal entries', async () => {
    const ws = await makeWorkspace(TOOLS)
    const b1 = await makeVerifiedBackup(ws, 'item.package', 'one')
    const b2 = await makeVerifiedBackup(ws, 'item.package', 'two')
    const b3 = await makeVerifiedBackup(ws, 'item.package', 'three')
    const b4 = await makeVerifiedBackup(ws, 'item.package', 'four')
    const b5 = await makeVerifiedBackup(ws, 'item.package', 'five')
    const bMissingManifest = '20261120-090000-miss'

    await mkdir(join(ws.paths.backupsDir, bMissingManifest, 'files', 'Mods'), { recursive: true })
    await writeFile(join(ws.paths.backupsDir, bMissingManifest, 'files', 'Mods', 'raw.package'), 'protected-raw')

    await mkdir(ws.paths.journalDir, { recursive: true })
    const activeStates = [
      { id: 'e-can-undo', status: 'done' as const, undo: 'can-undo' as const, backupId: b1.id },
      { id: 'e-in-prog', status: 'in-progress' as const, undo: 'can-undo' as const, backupId: b2.id },
      { id: 'e-attn', status: 'needs-attention' as const, undo: 'can-undo' as const, backupId: bMissingManifest }
    ]

    for (const item of activeStates) {
      const heldFile = join(ws.paths.holdingDir, item.id, 'Mods', 'held.package')
      await mkdir(dirname(heldFile), { recursive: true })
      await writeFile(heldFile, `held-${item.id}`)
      const entry = sampleJournalEntry({
        id: item.id,
        folderPath: ws.simsFolder,
        backupId: item.backupId,
        status: item.status,
        undo: item.undo,
        steps: [
          {
            kind: 'move',
            from: join(ws.mods, `${item.id}.package`),
            to: heldFile,
            bytes: 10,
            sha256: await sha256File(heldFile),
            state: 'applied'
          }
        ]
      })
      await writeFile(join(ws.paths.journalDir, `${item.id}.json`), JSON.stringify(entry))
    }

    // b1 & b2 & bMissingManifest protected by journal; b4 & b5 protected as newest 2; only b3 is pruned!
    const pruned = await pruneBackups(ws.deps, ws.simsFolder)
    expect(pruned.status).toBe('done')
    if (pruned.status !== 'done') return

    expect(pruned.removedBackups).toBe(1)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b3.id))).toBe(false)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b1.id))).toBe(true)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b2.id))).toBe(true)
    expect(await pathExists(join(ws.paths.backupsDir, bMissingManifest, 'files', 'Mods', 'raw.package'))).toBe(true)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b4.id))).toBe(true)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b5.id))).toBe(true)

    for (const item of activeStates) {
      expect(await pathExists(join(ws.paths.holdingDir, item.id, 'Mods', 'held.package'))).toBe(true)
    }
  })

  it('protects recent or future copying manifests and prunes abandoned copying (> 1h) and failed manifests', async () => {
    const ws = await makeWorkspace(TOOLS)
    const now = new Date('2026-11-25T15:00:00.000Z')
    ws.deps.clock = { now: () => now }

    const writeStateManifest = async (id: string, state: 'copying' | 'failed', at: string) => {
      const dir = join(ws.paths.backupsDir, id, 'files')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'part.dat'), 'partial')
      const m: Manifest = {
        record: { id, at, folderPath: ws.simsFolder, files: 1, bytes: 7, state },
        files: []
      }
      await writeFile(manifestFile(ws.paths.backupsDir, id), manifestJson(m))
    }

    await writeStateManifest('20261125-143000-rec1', 'copying', '2026-11-25T14:30:00.000Z') // 30m ago -> keep
    await writeStateManifest('20261125-160000-fut1', 'copying', '2026-11-25T16:00:00.000Z') // future -> keep
    await writeStateManifest('20261125-130000-old1', 'copying', '2026-11-25T13:00:00.000Z') // 2h ago -> prune
    await writeStateManifest('20261125-145500-fail', 'failed', '2026-11-25T14:55:00.000Z') // failed -> prune

    const res = await pruneBackups(ws.deps, ws.simsFolder)
    expect(res.status).toBe('done')
    if (res.status !== 'done') return

    expect(res.removedBackups).toBe(2)
    expect(await pathExists(join(ws.paths.backupsDir, '20261125-143000-rec1'))).toBe(true)
    expect(await pathExists(join(ws.paths.backupsDir, '20261125-160000-fut1'))).toBe(true)
    expect(await pathExists(join(ws.paths.backupsDir, '20261125-130000-old1'))).toBe(false)
    expect(await pathExists(join(ws.paths.backupsDir, '20261125-145500-fail'))).toBe(false)
  })

  it('prunes settled holding dirs only when every file is accounted for and safe, and keeps all orphan or unlisted holding dirs', async () => {
    const ws = await makeWorkspace(TOOLS)
    const lamp = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    const heldLamp = join(ws.paths.holdingDir, 'e-real-undo', 'Mods', 'BuildBuy', 'lamp_a.package')

    const applied = await runAction(ws.deps, {
      entryId: 'e-real-undo',
      action: 'disable-group',
      summary: 'Set aside lamp',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: 'dir:buildbuy',
      groupLabel: 'BuildBuy',
      hasScript: false,
      steps: [{ kind: 'move', from: lamp, to: heldLamp }]
    })
    expect(applied.status).toBe('done')
    const undone = await undo(ws.deps, 'e-real-undo')
    expect(undone.status).toBe('done')
    expect(await pathExists(join(ws.paths.holdingDir, 'e-real-undo'))).toBe(true)

    // Settled undone with verified copy-left at step.to (step.from exists with matching sha256) -> safe to prune
    const copyLeftOrig = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    const origSha = await sha256File(copyLeftOrig)
    const copyLeftTo = join(ws.paths.holdingDir, 'e-copyleft-ok', 'Mods', 'BuildBuy', 'lamp_a.package')
    await mkdir(dirname(copyLeftTo), { recursive: true })
    await copyFile(copyLeftOrig, copyLeftTo)
    await writeFile(
      join(ws.paths.journalDir, 'e-copyleft-ok.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-copyleft-ok',
          folderPath: ws.simsFolder,
          backupId: null,
          status: 'undone',
          undoneAt: '2026-11-24T12:30:00.000Z',
          steps: [
            {
              kind: 'move',
              from: copyLeftOrig,
              to: copyLeftTo,
              bytes: (await readFile(copyLeftOrig)).byteLength,
              sha256: origSha,
              state: 'reverted'
            }
          ]
        })
      )
    )

    // Settled undone where step.to still exists in holding AND step.from is missing -> MUST STAY PROTECTED
    const unsafeTo = join(ws.paths.holdingDir, 'e-copyleft-missing-src', 'Mods', 'vanished.package')
    await mkdir(dirname(unsafeTo), { recursive: true })
    await writeFile(unsafeTo, 'only-remaining-copy')
    await writeFile(
      join(ws.paths.journalDir, 'e-copyleft-missing-src.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-copyleft-missing-src',
          folderPath: ws.simsFolder,
          backupId: null,
          status: 'undone',
          undoneAt: '2026-11-24T12:31:00.000Z',
          steps: [
            {
              kind: 'move',
              from: join(ws.mods, 'vanished.package'),
              to: unsafeTo,
              bytes: 19,
              sha256: await sha256File(unsafeTo),
              state: 'reverted'
            }
          ]
        })
      )
    )

    // Settled done && cannot-undo holding dir whose edits/Options.ini IS accounted for by its edit step -> safe to prune
    const savedOpts = join(ws.paths.holdingDir, 'e-cannot-undo', 'edits', 'Options.ini')
    await mkdir(dirname(savedOpts), { recursive: true })
    await writeFile(savedOpts, '[options]\nmodsdisabled = 1\n')
    const savedOptsSha = await sha256File(savedOpts)
    const liveOptsSha = await sha256File(join(ws.simsFolder, 'Options.ini'))
    await writeFile(
      join(ws.paths.journalDir, 'e-cannot-undo.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-cannot-undo',
          folderPath: ws.simsFolder,
          backupId: null,
          status: 'done',
          undo: 'cannot-undo',
          steps: [
            {
              kind: 'edit',
              path: join(ws.simsFolder, 'Options.ini'),
              savedCopy: savedOpts,
              beforeSha256: savedOptsSha,
              afterSha256: liveOptsSha,
              state: 'applied'
            }
          ]
        })
      )
    )

    // Settled undone holding dir WITH an unlisted stray file -> MUST STAY KEPT
    const unlistedInSettled = join(ws.paths.holdingDir, 'e-unlisted-file', 'edits', 'unlisted.ini')
    await mkdir(dirname(unlistedInSettled), { recursive: true })
    await writeFile(unlistedInSettled, 'unexpected-bytes')
    await writeFile(
      join(ws.paths.journalDir, 'e-unlisted-file.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-unlisted-file',
          folderPath: ws.simsFolder,
          backupId: null,
          status: 'undone',
          undoneAt: '2026-11-24T12:32:00.000Z',
          steps: []
        })
      )
    )

    // Orphan holding dirs (missing journal entry): ALL kept (Mods/, edits/Options.ini, stray file, and empty)!
    const orphanWithMod = join(ws.paths.holdingDir, 'orphan-with-mod', 'Mods', 'precious.package')
    await mkdir(dirname(orphanWithMod), { recursive: true })
    await writeFile(orphanWithMod, 'do-not-touch-me')

    const orphanWithEdits = join(ws.paths.holdingDir, 'orphan-with-edits', 'edits', 'Options.ini')
    await mkdir(dirname(orphanWithEdits), { recursive: true })
    await writeFile(orphanWithEdits, '[options]\n')

    const orphanStray = join(ws.paths.holdingDir, 'orphan-stray', 'note.txt')
    await mkdir(dirname(orphanStray), { recursive: true })
    await writeFile(orphanStray, 'keep-me')

    await mkdir(join(ws.paths.holdingDir, 'orphan-empty', 'Mods', 'Sub'), { recursive: true })

    const res = await pruneBackups(ws.deps, ws.simsFolder)
    expect(res.status).toBe('done')

    expect(await pathExists(join(ws.paths.holdingDir, 'e-real-undo'))).toBe(false)
    expect(await pathExists(join(ws.paths.holdingDir, 'e-copyleft-ok'))).toBe(false)
    expect(await pathExists(join(ws.paths.holdingDir, 'e-cannot-undo'))).toBe(false)

    // Protected & orphan ones remain untouched!
    expect(await pathExists(unsafeTo)).toBe(true)
    expect(await pathExists(unlistedInSettled)).toBe(true)
    expect(await pathExists(orphanWithMod)).toBe(true)
    expect(await pathExists(orphanWithEdits)).toBe(true)
    expect(await pathExists(orphanStray)).toBe(true)
    expect(await pathExists(join(ws.paths.holdingDir, 'orphan-empty'))).toBe(true)
  })

  const unsafeStateCases: { name: string; plant: (ws: Workspace, b1Id: string) => Promise<void> }[] = [
    {
      name: 'unreadable/corrupt journal .json',
      plant: async (ws) => {
        await mkdir(ws.paths.journalDir, { recursive: true })
        await writeFile(join(ws.paths.journalDir, '20261124-120099-badj.json'), '{not-valid-json')
      }
    },
    {
      name: 'non-.json file in journalDir',
      plant: async (ws) => {
        await mkdir(ws.paths.journalDir, { recursive: true })
        await writeFile(join(ws.paths.journalDir, 'notes.txt'), 'unexpected')
      }
    },
    {
      name: '.sims-helper-tmp file in journalDir',
      plant: async (ws) => {
        await mkdir(ws.paths.journalDir, { recursive: true })
        await writeFile(join(ws.paths.journalDir, 'e1.json.a1b2c3.sims-helper-tmp'), '{}')
      }
    },
    {
      name: '.sims-helper-tmp file in backupsDir',
      plant: async (ws, b1Id) => {
        await writeFile(join(ws.paths.backupsDir, b1Id, 'manifest.json.a1b2c3.sims-helper-tmp'), '{}')
      }
    },
    {
      name: 'corrupt manifest.json in backupsDir',
      plant: async (ws, b1Id) => {
        await writeFile(manifestFile(ws.paths.backupsDir, b1Id), '{corrupt-manifest')
      }
    }
  ]

  it.each(unsafeStateCases)(
    'fails closed (canPrune: false, refused unsafe-state, 0 gate ops) on $name',
    async ({ plant }) => {
      const ws = await makeWorkspace(TOOLS)
      const b1 = await makeVerifiedBackup(ws, 'p.package', '1')
      await makeVerifiedBackup(ws, 'p.package', '2')
      await makeVerifiedBackup(ws, 'p.package', '3')

      await plant(ws, b1.id)
      const mark = ws.gate.requests.length

      const summary = await backupSummary(ws.deps, ws.simsFolder)
      expect(summary.canPrune).toBe(false)
      expect(ws.gate.requests.length).toBe(mark)

      const res = await pruneBackups(ws.deps, ws.simsFolder)
      expect(res).toEqual({ status: 'refused', why: 'unsafe-state' })
      expect(ws.gate.requests.length).toBe(mark)
    }
  )

  const unsafeSymlinkCases: { name: string; plant: (ws: Workspace, b1Id: string) => Promise<void> }[] = [
    {
      name: 'symlink inside backupsDir',
      plant: async (ws) => {
        await symlink(ws.mods, join(ws.paths.backupsDir, '20261124-000001-link'))
      }
    },
    {
      name: 'symlink inside Donor/files/',
      plant: async (ws, b1Id) => {
        await symlink(
          join(ws.simsFolder, 'Options.ini'),
          join(ws.paths.backupsDir, b1Id, 'files', 'Mods', 'sneaky-link.package')
        )
      }
    }
  ]

  it.skipIf(process.platform === 'win32').each(unsafeSymlinkCases)(
    'fails closed (canPrune: false, refused unsafe-state, 0 gate ops) on $name',
    async ({ plant }) => {
      const ws = await makeWorkspace(TOOLS)
      const b1 = await makeVerifiedBackup(ws, 'p.package', '1')
      await makeVerifiedBackup(ws, 'p.package', '2')
      await makeVerifiedBackup(ws, 'p.package', '3')

      await plant(ws, b1.id)
      const mark = ws.gate.requests.length

      const summary = await backupSummary(ws.deps, ws.simsFolder)
      expect(summary.canPrune).toBe(false)
      expect(ws.gate.requests.length).toBe(mark)

      const res = await pruneBackups(ws.deps, ws.simsFolder)
      expect(res).toEqual({ status: 'refused', why: 'unsafe-state' })
      expect(ws.gate.requests.length).toBe(mark)
    }
  )

  it('enforces strict Phase-1-before-Phase-2 ordering so a failed Phase 1 never touches files and a failed Phase 2 leaves zero half-pruned verified manifests', async () => {
    // 1. Fail Phase 1 -> Phase 2 never runs at all
    const ws1 = await makeWorkspace(TOOLS)
    const b1 = await makeVerifiedBackup(ws1, 'item.package', 'v1')
    await makeVerifiedBackup(ws1, 'item.package', 'v2')
    await makeVerifiedBackup(ws1, 'item.package', 'v3')

    const mark1 = ws1.gate.requests.length
    ws1.gate.hooks.beforeRequest = () => ({ status: 'failed', opsDone: 0, detail: 'simulated phase 1 failure' })

    const failedPhase1 = await pruneBackups(ws1.deps, ws1.simsFolder)
    expect(failedPhase1.status).toBe('failed')
    expect(ws1.gate.requests.slice(mark1)).toHaveLength(1)
    expect(await pathExists(manifestFile(ws1.paths.backupsDir, b1.id))).toBe(true)
    expect(await pathExists(join(ws1.paths.backupsDir, b1.id, 'files', 'Mods', 'item.package'))).toBe(true)

    // 2. Fail mid-Phase 2 -> Phase 1 already removed non-root manifests, so zero half-pruned verified manifests exist
    const ws2 = await makeWorkspace(TOOLS)
    const d1 = await makeVerifiedBackup(ws2, 'item.package', 'v1')
    await makeVerifiedBackup(ws2, 'item.package', 'v2')
    const d3 = await makeVerifiedBackup(ws2, 'item.package', 'v3')

    const mark2 = ws2.gate.requests.length
    let pruneReqNum = 0
    ws2.gate.hooks.beforeRequest = () => {
      pruneReqNum += 1
      if (pruneReqNum === 2) return { status: 'failed', opsDone: 0, detail: 'simulated phase 2 failure' }
      return undefined
    }

    const failedPhase2 = await pruneBackups(ws2.deps, ws2.simsFolder)
    expect(failedPhase2.status).toBe('failed')
    expect(ws2.gate.requests.slice(mark2).length).toBe(2)
    expect(await pathExists(manifestFile(ws2.paths.backupsDir, d1.id))).toBe(false)

    const newest = await newestVerified(ws2.paths.backupsDir, ws2.simsFolder)
    expect(newest?.record.id).toBe(d3.id)
    expect(await backupStatus(ws2.deps, ws2.simsFolder)).toEqual({
      state: 'verified',
      backupId: d3.id,
      at: d3.at
    })
  })

  it('chunks large Phase 2 file deletions at <= 200 ops per gate request and refuses busy while a backup is in flight', async () => {
    const ws = await makeWorkspace(TOOLS)
    for (let i = 0; i < 230; i += 1) {
      await writeFile(join(ws.mods, `bulk_${i}.package`), `file-${i}`)
    }
    // Keep one shared file so b1 is a Donor (each of the 230 bulk files deleted individually in Phase 2!)
    await writeFile(join(ws.mods, 'shared_anchor.package'), 'anchor')
    const t0 = new Date('2026-11-20T08:00:00.000Z')
    await utimes(join(ws.mods, 'shared_anchor.package'), t0, t0)

    const b1 = await makeVerifiedBackup(ws)
    for (let i = 0; i < 230; i += 1) {
      await rm(join(ws.mods, `bulk_${i}.package`))
    }
    await makeVerifiedBackup(ws, 'after_1.package', 'a1')
    await makeVerifiedBackup(ws, 'after_2.package', 'a2')

    const mark = ws.gate.requests.length
    const pruned = await pruneBackups(ws.deps, ws.simsFolder)
    expect(pruned.status).toBe('done')
    const reqs = ws.gate.requests.slice(mark)
    expect(reqs.length).toBeGreaterThanOrEqual(3) // 1 Phase 1 + >= 2 Phase 2 chunks of <= 200
    for (const r of reqs) {
      expect(r.ops.length).toBeLessThanOrEqual(200)
    }
    expect(await pathExists(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'shared_anchor.package'))).toBe(true)
    expect(await pathExists(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'bulk_0.package'))).toBe(false)

    // Busy refusal before acquiring lock while createBackup is in flight, and backupSummary serializes on lock
    let releaseBackup!: () => void
    ws.gate.hooks.beforeRequest = async () => {
      ws.gate.hooks.beforeRequest = undefined
      await new Promise<void>((resolve) => {
        releaseBackup = resolve
      })
      return undefined
    }
    const runningBackup = createBackup(ws.deps, ws.simsFolder)
    await new Promise((r) => setTimeout(r, 15))
    expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'busy' })

    let summarySettled = false
    const pendingSummary = backupSummary(ws.deps, ws.simsFolder).then((s) => {
      summarySettled = true
      return s
    })
    await new Promise((r) => setTimeout(r, 15))
    expect(summarySettled).toBe(false)

    releaseBackup()
    await runningBackup
    const settledSummary = await pendingSummary
    expect(summarySettled).toBe(true)
    expect(settledSummary.verifiedCount).toBe(3)

    // Busy refusal re-checked after acquiring oneAtATime(deps) lock
    let releaseLock!: () => void
    const heldLock = oneAtATime(
      ws.deps,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve
        })
    )
    await Promise.resolve()
    const queuedPrune = pruneBackups(ws.deps, ws.simsFolder)
    let releaseTracked!: () => void
    const heldTracked = tracked(
      ws.deps,
      () =>
        new Promise<void>((resolve) => {
          releaseTracked = resolve
        })
    )
    releaseLock()
    await heldLock
    expect(await queuedPrune).toEqual({ status: 'refused', why: 'busy' })
    releaseTracked()
    await heldTracked
  })

  it('isolates backups per Sims folder and protects paths case-insensitively', async () => {
    const ws = await makeWorkspace(TOOLS)

    // Create Folder B with 1 oldest verified backup
    const folderB = join(ws.root, 'SecondSims', 'The Sims 4')
    await mkdir(join(folderB, 'Mods'), { recursive: true })
    await writeFile(join(folderB, 'Options.ini'), '[options]\nmodsdisabled = 0\n')
    await writeFile(join(folderB, 'Mods', 'folder_b_only.package'), 'folder-b-precious')
    const bFolderB = await createBackup(ws.deps, folderB)
    if (bFolderB.status !== 'verified') throw new Error('folderB backup failed')

    // Create 4 newer verified backups for Folder A
    const a1 = await makeVerifiedBackup(ws, 'a_mod.package', '1')
    const a2 = await makeVerifiedBackup(ws, 'a_mod.package', '2')
    const a3 = await makeVerifiedBackup(ws, 'a_mod.package', '3')
    const a4 = await makeVerifiedBackup(ws, 'a_mod.package', '4')

    // Mutate a4's manifest to reference a1's lamp_a.package with different letter case -> must STILL protect it!
    const m4 = await readManifest(ws.paths.backupsDir, a4.id)
    if (!m4) throw new Error('missing m4')
    const patchedFiles = m4.files.map((line) =>
      line.path === 'Mods/BuildBuy/lamp_a.package'
        ? { ...line, path: 'Mods/BuildBuy/LAMP_A.PACKAGE', storedIn: a1.id.toUpperCase() }
        : line
    )
    // Also remove lamp_a from a3 (keeping record.files and record.bytes valid!) so ONLY a4's uppercased storedIn/path protects a1's lamp_a.package
    const m3 = await readManifest(ws.paths.backupsDir, a3.id)
    if (!m3) throw new Error('missing m3')
    const m3Files = m3.files.filter((l) => l.path !== 'Mods/BuildBuy/lamp_a.package')
    await writeFile(
      manifestFile(ws.paths.backupsDir, a3.id),
      manifestJson({
        ...m3,
        record: {
          ...m3.record,
          files: m3Files.length,
          bytes: m3Files.reduce((sum, f) => sum + f.bytes, 0)
        },
        files: m3Files
      })
    )
    await writeFile(manifestFile(ws.paths.backupsDir, a4.id), manifestJson({ ...m4, files: patchedFiles }))

    const res = await pruneBackups(ws.deps, ws.simsFolder)
    expect(res.status).toBe('done')
    if (res.status !== 'done') return

    // Folder B's single backup is completely untouched!
    expect(await pathExists(manifestFile(ws.paths.backupsDir, bFolderB.record.id))).toBe(true)
    expect(
      await pathExists(join(ws.paths.backupsDir, bFolderB.record.id, 'files', 'Mods', 'folder_b_only.package'))
    ).toBe(true)
    expect(await backupStatus(ws.deps, folderB)).toEqual({
      state: 'verified',
      backupId: bFolderB.record.id,
      at: bFolderB.record.at
    })

    // Folder A's a1 & a2 manifests removed, a3 & a4 kept, AND a1's lamp_a.package protected despite case mismatch!
    expect(await pathExists(manifestFile(ws.paths.backupsDir, a1.id))).toBe(false)
    expect(await pathExists(manifestFile(ws.paths.backupsDir, a2.id))).toBe(false)
    expect(await pathExists(join(ws.paths.backupsDir, a1.id, 'files', 'Mods', 'BuildBuy', 'lamp_a.package'))).toBe(
      true
    )
    expect(await pathExists(join(ws.paths.backupsDir, a1.id, 'files', 'Mods', 'a_mod.package'))).toBe(false)
  })

  it('verifies SHA-256 hashes on intact fallback so same-size byte corruption in newest 2 backups keeps oldest hash-intact backup', async () => {
    const ws = await makeWorkspace(TOOLS)
    const b1 = await makeVerifiedBackup(ws, 'critical.package', 'v1-intact-8bytes')
    const b2 = await makeVerifiedBackup(ws, 'critical.package', 'v2-intact-8bytes')
    const b3 = await makeVerifiedBackup(ws, 'critical.package', 'v3-intact-8bytes')

    const b1Sha = await sha256File(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'critical.package'))

    // Corrupt b2 and b3 stored copies on disk with SAME byte length (16 bytes)
    await writeFile(join(ws.paths.backupsDir, b2.id, 'files', 'Mods', 'critical.package'), 'XXXXXXXXX-8bytes')
    await writeFile(join(ws.paths.backupsDir, b3.id, 'files', 'Mods', 'critical.package'), 'YYYYYYYYY-8bytes')

    // All 3 must be protected (b3 & b2 as newest 2, b1 as newest hash-intact!)
    const summary = await backupSummary(ws.deps, ws.simsFolder)
    expect(summary.reclaimableBackups).toBe(0)
    expect(summary.canPrune).toBe(false)
    expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'nothing-to-prune' })
    expect(await pathExists(manifestFile(ws.paths.backupsDir, b1.id))).toBe(true)
    expect(await sha256File(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'critical.package'))).toBe(b1Sha)

    // If a 4th older backup b0 existed before b1, b1 is kept as newest hash-intact while only b0 would be pruned;
    // and if ALL 3 verified backups have same-size corruption, prune fails closed (unsafe-state) and deletes 0!
    await writeFile(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'critical.package'), 'ZZZZZZZZZ-8bytes')
    expect((await backupSummary(ws.deps, ws.simsFolder)).canPrune).toBe(false)
    expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'unsafe-state' })
  })

  const manifestMutations: { name: string; mutate: (m: Manifest) => unknown }[] = [
    {
      name: 'backslash in manifest file path',
      mutate: (m) => ({
        ...m,
        files: m.files.map((f, i) => (i === 0 ? { ...f, path: 'Mods\\evil.package' } : f))
      })
    },
    {
      name: 'drive-letter colon in manifest file path',
      mutate: (m) => ({
        ...m,
        files: m.files.map((f, i) => (i === 0 ? { ...f, path: 'C:/Windows/win.ini' } : f))
      })
    },
    {
      name: 'non-ISO or OS path in record.at',
      mutate: (m) => ({
        ...m,
        record: { ...m.record, at: 'C:\\Users\\Lila\\secret' }
      })
    },
    {
      name: 'verified manifest files count mismatch',
      mutate: (m) => ({
        ...m,
        record: { ...m.record, files: m.files.length + 1 }
      })
    },
    {
      name: 'verified manifest bytes total mismatch',
      mutate: (m) => ({
        ...m,
        record: { ...m.record, bytes: m.record.bytes + 10 }
      })
    }
  ]

  it.each(manifestMutations)('rejects malformed manifest: $name', async ({ mutate }) => {
    const ws = await makeWorkspace(TOOLS)
    const b1 = await makeVerifiedBackup(ws, 'm.package', '1')
    await makeVerifiedBackup(ws, 'm.package', '2')
    await makeVerifiedBackup(ws, 'm.package', '3')

    const orig = await readManifest(ws.paths.backupsDir, b1.id)
    if (!orig) throw new Error('missing orig')
    await writeFile(manifestFile(ws.paths.backupsDir, b1.id), JSON.stringify(mutate(orig)))

    const mark = ws.gate.requests.length
    expect((await backupSummary(ws.deps, ws.simsFolder)).canPrune).toBe(false)
    expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'unsafe-state' })
    expect(ws.gate.requests.length).toBe(mark)
  })

  function baseValidJournalEntry(ws: Workspace, id = 'e-bad') {
    return sampleJournalEntry({
      id,
      folderPath: ws.simsFolder,
      backupId: null,
      steps: [
        {
          kind: 'move',
          from: join(ws.mods, 'download.zip'),
          to: join(ws.paths.holdingDir, id, 'Mods', 'download.zip'),
          bytes: 65_536,
          sha256: 'a'.repeat(64),
          state: 'applied'
        }
      ]
    })
  }

  const journalMutations: { name: string; build: (ws: Workspace) => Record<string, unknown> }[] = [
    { name: 'invalid status', build: (ws) => ({ ...baseValidJournalEntry(ws), status: 'bogus' }) },
    { name: 'invalid undo', build: (ws) => ({ ...baseValidJournalEntry(ws), undo: 'maybe' }) },
    { name: 'empty string backupId', build: (ws) => ({ ...baseValidJournalEntry(ws), backupId: '' }) },
    { name: 'non-object step', build: (ws) => ({ ...baseValidJournalEntry(ws), steps: [null] }) },
    {
      name: 'relative move path',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: 'Mods/rel.package',
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'rel.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'negative move bytes',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: join(ws.mods, 'a.package'),
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'a.package'),
            bytes: -1,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'invalid step state',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [{ kind: 'remove-cache', path: join(ws.simsFolder, 'localthumbcache.package'), state: 'halfway' }]
      })
    },
    {
      name: 'dot-dot segment in folderPath',
      build: (ws) => ({ ...baseValidJournalEntry(ws), folderPath: `${ws.simsFolder}/../The Sims 4` })
    },
    {
      name: 'dot segment in move.from',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: `${ws.mods}/./a.package`,
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'a.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'dot-dot segment in move.from',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: `${ws.mods}/../Saves/Slot_00000001.save`,
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'a.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'dot-dot backslash segment in move.from',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: `${ws.mods}\\..\\Saves\\Slot_00000001.save`,
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'a.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'dot-dot segment in move.to',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: join(ws.mods, 'a.package'),
            to: `${ws.paths.holdingDir}/e-bad/../other/a.package`,
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'dot-dot segment in edit.savedCopy',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'edit',
            path: join(ws.simsFolder, 'Options.ini'),
            savedCopy: `${ws.paths.holdingDir}/e-bad/../other/Options.ini`,
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'dot-dot segment in remove-cache.path',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [{ kind: 'remove-cache', path: `${ws.simsFolder}/Mods/../localthumbcache.package`, state: 'applied' }]
      })
    },
    {
      name: 'move.from inside holdingDir',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        status: 'undone',
        undo: 'cannot-undo',
        steps: [
          {
            kind: 'move',
            from: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'other.package'),
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'held.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'reverted'
          }
        ]
      })
    },
    {
      name: 'move.from outside entry.folderPath',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: join(ws.root, 'OutsideSims', 'a.package'),
            to: join(ws.paths.holdingDir, 'e-bad', 'Mods', 'a.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'move.to inside another entry holdingDir',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'move',
            from: join(ws.mods, 'a.package'),
            to: join(ws.paths.holdingDir, 'other-entry', 'Mods', 'a.package'),
            bytes: 5,
            sha256: 'a'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'edit.path inside holdingDir',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'edit',
            path: join(ws.paths.holdingDir, 'e-bad', 'Options.ini'),
            savedCopy: join(ws.paths.holdingDir, 'e-bad', 'edits', 'Options.ini'),
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'edit.savedCopy inside another entry holdingDir',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [
          {
            kind: 'edit',
            path: join(ws.simsFolder, 'Options.ini'),
            savedCopy: join(ws.paths.holdingDir, 'other-entry', 'edits', 'Options.ini'),
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64),
            state: 'applied'
          }
        ]
      })
    },
    {
      name: 'remove-cache.path inside holdingDir',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [{ kind: 'remove-cache', path: join(ws.paths.holdingDir, 'e-bad', 'localthumbcache.package'), state: 'applied' }]
      })
    },
    {
      name: 'remove-cache.path outside entry.folderPath',
      build: (ws) => ({
        ...baseValidJournalEntry(ws),
        steps: [{ kind: 'remove-cache', path: join(ws.root, 'OutsideSims', 'localthumbcache.package'), state: 'applied' }]
      })
    }
  ]

  it.each(journalMutations)(
    'rejects malformed journal entry (preserving backup counts): $name',
    async ({ build }) => {
      const ws = await makeWorkspace(TOOLS)
      await makeVerifiedBackup(ws, 'j.package', '1')
      await makeVerifiedBackup(ws, 'j.package', '2')
      await makeVerifiedBackup(ws, 'j.package', '3')

      await mkdir(ws.paths.journalDir, { recursive: true })
      await writeFile(join(ws.paths.journalDir, 'e-bad.json'), JSON.stringify(build(ws)))

      const mark = ws.gate.requests.length
      const summary = await backupSummary(ws.deps, ws.simsFolder)
      expect(summary.canPrune).toBe(false)
      expect(summary.verifiedCount).toBe(3)
      expect(summary.totalBytes).toBeGreaterThan(0)

      expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'unsafe-state' })
      expect(ws.gate.requests.length).toBe(mark)
    }
  )

  it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))(
    'fails closed on unreadable file payloads and protects canonical donor paths across aliased parent paths',
    async () => {
      const ws = await makeWorkspace(TOOLS)
      const b1 = await makeVerifiedBackup(ws, 'pay.package', 'payload-1')
      await makeVerifiedBackup(ws, 'pay.package', 'payload-2')
      await makeVerifiedBackup(ws, 'pay.package', 'payload-3')

      const targetFile = join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'pay.package')
      await chmod(targetFile, 0o000)

      const mark = ws.gate.requests.length
      expect((await backupSummary(ws.deps, ws.simsFolder)).canPrune).toBe(false)
      expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'unsafe-state' })
      expect(ws.gate.requests.length).toBe(mark)

      await chmod(targetFile, 0o600)

      // Canonical donor path protection when backupsDir parent is reached via an alias link
      const aliasParent = join(ws.root, 'AliasAppData')
      await symlink(ws.paths.dataDir, aliasParent)
      const aliasedDeps = {
        ...ws.deps,
        paths: {
          ...ws.paths,
          dataDir: aliasParent,
          backupsDir: join(aliasParent, 'backups'),
          holdingDir: join(aliasParent, 'holding'),
          journalDir: join(aliasParent, 'journal')
        }
      }
      aliasedDeps.gate = makeTestGate({
        fs: TOOLS.fs,
        dataDir: aliasParent,
        gameState: ws.deps.gameState,
        backupStatus: (folderPath) => backupStatus(aliasedDeps, folderPath)
      })
      const res = await pruneBackups(aliasedDeps, ws.simsFolder)
      expect(res.status).toBe('done')
      expect(await pathExists(join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'BuildBuy', 'lamp_a.package'))).toBe(
        true
      )
      expect(await pathExists(targetFile)).toBe(false)
    }
  )

  it('rechecks Phase 3 holding copies immediately after Phase 2 and reconciles mid-Phase-2 partial failures idempotently', async () => {
    // 1. Phase 3 immediate recheck: restored original disappears during Phase 2 -> held copy in holding/<id> is KEPT!
    const ws1 = await makeWorkspace(TOOLS)
    await makeVerifiedBackup(ws1, 'x.package', 'v1')
    await makeVerifiedBackup(ws1, 'x.package', 'v2')
    await makeVerifiedBackup(ws1, 'x.package', 'v3')

    const restoredOrig = join(ws1.mods, 'BuildBuy', 'lamp_a.package')
    const origBytes = await readFile(restoredOrig)
    const origSha = await sha256File(restoredOrig)
    const heldCopy = join(ws1.paths.holdingDir, 'e-race', 'Mods', 'BuildBuy', 'lamp_a.package')
    await mkdir(dirname(heldCopy), { recursive: true })
    await writeFile(heldCopy, origBytes)
    await mkdir(ws1.paths.journalDir, { recursive: true })
    await writeFile(
      join(ws1.paths.journalDir, 'e-race.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-race',
          folderPath: ws1.simsFolder,
          backupId: null,
          status: 'undone',
          undoneAt: '2026-11-24T12:40:00.000Z',
          steps: [
            {
              kind: 'move',
              from: restoredOrig,
              to: heldCopy,
              bytes: origBytes.byteLength,
              sha256: origSha,
              state: 'reverted'
            }
          ]
        })
      )
    )

    // Delete restoredOrig right after Phase 2 deletes files in backupsDir (before Phase 3 runs!)
    ws1.gate.hooks.afterOp = async (op) => {
      if (op.op === 'remove' && op.path.includes(join('backups', '20261124-120000-0001', 'files'))) {
        await rm(restoredOrig, { force: true })
      }
    }

    const raceRes = await pruneBackups(ws1.deps, ws1.simsFolder)
    expect(raceRes.status).toBe('done')
    // Held copy MUST survive because restoredOrig disappeared before Phase 3!
    expect(await pathExists(heldCopy)).toBe(true)
    expect(await sha256File(heldCopy)).toBe(origSha)

    // 2. Mid-Phase-2 partial failure (after deleting 1 of 2 donor files) -> retry completes cleanly -> 3rd run nothing-to-prune
    const ws2 = await makeWorkspace(TOOLS)
    const u1 = join(ws2.mods, 'unreferenced_1.package')
    const u2 = join(ws2.mods, 'unreferenced_2.package')
    await writeFile(u1, 'drop-me-1')
    await writeFile(u2, 'drop-me-2')
    const d1 = await makeVerifiedBackup(ws2)
    await rm(u1)
    await rm(u2)
    await makeVerifiedBackup(ws2, 'keep_new_1.package', 'k1')
    await makeVerifiedBackup(ws2, 'keep_new_2.package', 'k2')

    let donorFileRemoves = 0
    ws2.gate.hooks.beforeOp = (op) => {
      if (op.op === 'remove' && op.path.includes(join(d1.id, 'files'))) {
        donorFileRemoves += 1
        if (donorFileRemoves === 2) return 'simulated crash mid-phase-2'
      }
      return undefined
    }

    const firstTry = await pruneBackups(ws2.deps, ws2.simsFolder)
    expect(firstTry.status).toBe('failed')
    expect(await pathExists(manifestFile(ws2.paths.backupsDir, d1.id))).toBe(false)
    expect(await pathExists(join(ws2.paths.backupsDir, d1.id, 'files', 'Mods', 'unreferenced_1.package'))).toBe(false)
    expect(await pathExists(join(ws2.paths.backupsDir, d1.id, 'files', 'Mods', 'unreferenced_2.package'))).toBe(true)

    ws2.gate.hooks.beforeOp = undefined
    const secondTry = await pruneBackups(ws2.deps, ws2.simsFolder)
    expect(secondTry.status).toBe('done')
    expect(await pathExists(join(ws2.paths.backupsDir, d1.id, 'files', 'Mods', 'unreferenced_2.package'))).toBe(false)
    expect(await pathExists(join(ws2.paths.backupsDir, d1.id, 'files', 'Mods', 'BuildBuy', 'lamp_a.package'))).toBe(
      true
    )

    expect(await pruneBackups(ws2.deps, ws2.simsFolder)).toEqual({ status: 'refused', why: 'nothing-to-prune' })
  })

  it('keeps settled edit holding copies when live file hash drifted after undo or cannot-undo apply, and prunes once live hash matches', async () => {
    const ws = await makeWorkspace(TOOLS)
    await makeVerifiedBackup(ws, 'ed.package', '1')
    await makeVerifiedBackup(ws, 'ed.package', '2')
    await makeVerifiedBackup(ws, 'ed.package', '3')
    await mkdir(ws.paths.journalDir, { recursive: true })

    const liveOpts = join(ws.simsFolder, 'Options.ini')
    const beforeText = '[options]\nmodsdisabled = 1\nscriptmodsenabled = 0\n'
    const afterText = '[options]\nmodsdisabled = 0\nscriptmodsenabled = 1\n'
    const driftedText = '[options]\nmodsdisabled = 1\nscriptmodsenabled = 1\nfullscreen = 1\n'

    // 1. Undone/reverted edit where live Options.ini was modified AFTER undo -> must KEEP savedCopy!
    const undoneSaved = join(ws.paths.holdingDir, 'e-edit-undone-drift', 'edits', 'Options.ini')
    await mkdir(dirname(undoneSaved), { recursive: true })
    await writeFile(undoneSaved, beforeText)
    const beforeSha = await sha256File(undoneSaved)
    await writeFile(liveOpts, afterText)
    const afterSha = await sha256File(liveOpts)
    await writeFile(liveOpts, driftedText)

    await writeFile(
      join(ws.paths.journalDir, 'e-edit-undone-drift.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-edit-undone-drift',
          folderPath: ws.simsFolder,
          backupId: null,
          status: 'undone',
          undoneAt: '2026-11-25T10:00:00.000Z',
          steps: [
            {
              kind: 'edit',
              path: liveOpts,
              savedCopy: undoneSaved,
              beforeSha256: beforeSha,
              afterSha256: afterSha,
              state: 'reverted'
            }
          ]
        })
      )
    )

    // 2. Done/cannot-undo applied edit where live Options.ini drifted away from afterSha256 -> must KEEP savedCopy!
    const appliedSaved = join(ws.paths.holdingDir, 'e-edit-applied-drift', 'edits', 'Options.ini')
    await mkdir(dirname(appliedSaved), { recursive: true })
    await writeFile(appliedSaved, beforeText)
    await writeFile(
      join(ws.paths.journalDir, 'e-edit-applied-drift.json'),
      JSON.stringify(
        sampleJournalEntry({
          id: 'e-edit-applied-drift',
          folderPath: ws.simsFolder,
          backupId: null,
          status: 'done',
          undo: 'cannot-undo',
          steps: [
            {
              kind: 'edit',
              path: liveOpts,
              savedCopy: appliedSaved,
              beforeSha256: beforeSha,
              afterSha256: afterSha,
              state: 'applied'
            }
          ]
        })
      )
    )

    const res1 = await pruneBackups(ws.deps, ws.simsFolder)
    expect(res1.status).toBe('done')
    expect(await pathExists(undoneSaved)).toBe(true)
    expect(await pathExists(appliedSaved)).toBe(true)

    // Restore live Options.ini to beforeText -> undone/reverted entry now matches liveSha === beforeSha256 and prunes, while applied-drift stays kept!
    await writeFile(liveOpts, beforeText)
    const res2 = await pruneBackups(ws.deps, ws.simsFolder)
    expect(res2.status).toBe('done')
    expect(await pathExists(undoneSaved)).toBe(false)
    expect(await pathExists(appliedSaved)).toBe(true)

    // Set live Options.ini to afterText -> done/cannot-undo entry now matches liveSha === afterSha256 and prunes!
    await writeFile(liveOpts, afterText)
    const res3 = await pruneBackups(ws.deps, ws.simsFolder)
    expect(res3.status).toBe('done')
    expect(await pathExists(appliedSaved)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'enforces canonical root containment in verifyHoldingDirReadyToRemove when a parent directory inside Mods symlinks into holdingDir or outside folderPath',
    async () => {
      const ws = await makeWorkspace(TOOLS)
      await makeVerifiedBackup(ws, 'c.package', '1')
      await makeVerifiedBackup(ws, 'c.package', '2')
      await makeVerifiedBackup(ws, 'c.package', '3')
      await mkdir(ws.paths.journalDir, { recursive: true })

      // Symlink Mods/TrapDir -> holding/e-canon-trap/Mods so step.from is lexically inside folderPath,
      // isFile() on lstat(step.from) is true, yet realFrom resolves inside holdingDir!
      const heldDir = join(ws.paths.holdingDir, 'e-canon-trap', 'Mods')
      await mkdir(heldDir, { recursive: true })
      const heldA = join(heldDir, 'a.package')
      const heldB = join(heldDir, 'b.package')
      await writeFile(heldA, 'precious-bytes')
      await writeFile(heldB, 'precious-bytes')
      const sha = await sha256File(heldA)
      await symlink(heldDir, join(ws.mods, 'TrapDir'))

      await writeFile(
        join(ws.paths.journalDir, 'e-canon-trap.json'),
        JSON.stringify(
          sampleJournalEntry({
            id: 'e-canon-trap',
            folderPath: ws.simsFolder,
            backupId: null,
            status: 'undone',
            undoneAt: '2026-11-25T11:00:00.000Z',
            steps: [
              {
                kind: 'move',
                from: join(ws.mods, 'TrapDir', 'a.package'),
                to: heldB,
                bytes: 14,
                sha256: sha,
                state: 'reverted'
              }
            ]
          })
        )
      )

      const mark = ws.gate.requests.length
      expect((await backupSummary(ws.deps, ws.simsFolder)).canPrune).toBe(false)
      expect(await pruneBackups(ws.deps, ws.simsFolder)).toEqual({ status: 'refused', why: 'unsafe-state' })
      expect(ws.gate.requests.length).toBe(mark)
      expect(await pathExists(heldA)).toBe(true)
      expect(await pathExists(heldB)).toBe(true)
    }
  )

  it('keys storedCopiesHashIntact cache by exact canonical path without lowercasing so distinct-case files on case-sensitive volumes cannot collide', async () => {
    const hashCache = new Map<string, string>()
    const goodSha = '1'.repeat(64)
    const corruptSha = '2'.repeat(64)
    const hashedPaths: string[] = []

    const intact = await storedCopiesHashIntact(
      '/casevol/backups',
      [
        { path: 'Mods/a.package', bytes: 4, mtimeMs: 1, sha256: goodSha, storedIn: 'b1' },
        { path: 'Mods/A.package', bytes: 4, mtimeMs: 1, sha256: goodSha, storedIn: 'b1' }
      ],
      hashCache,
      {
        checkInPlace: async () => true,
        resolveReal: async (p) => p,
        hashFile: async (p) => {
          hashedPaths.push(p)
          return /[\\/]A\.package$/.test(p) ? corruptSha : goodSha
        }
      }
    )

    expect(intact).toBe(false)
    expect(hashedPaths).toEqual([
      join('/casevol/backups', 'b1', 'files', 'Mods', 'a.package'),
      join('/casevol/backups', 'b1', 'files', 'Mods', 'A.package')
    ])
    expect(hashCache.size).toBe(2)
  })

  it('reads entire file payload in chunks and fails closed on mid-file read errors or premature 0-byte reads', async () => {
    // 1. Direct unit checks on canReadFilePayload
    let closedCount = 0
    const prematureZeroReader = async (): Promise<ReadOnlyFile> => ({
      size: 128,
      read: async () => 0,
      close: async () => {
        closedCount += 1
      }
    })
    expect(await canReadFilePayload('/fake/nonempty.package', prematureZeroReader)).toBe(false)
    expect(closedCount).toBe(1)

    const midFileErrorReader = async (): Promise<ReadOnlyFile> => ({
      size: 150_000,
      read: async (_buf, position, length = 0) => {
        if (position >= 65_536) throw new Error('EIO at second chunk')
        return Math.min(length, 65_536)
      },
      close: async () => {
        closedCount += 1
      }
    })
    expect(await canReadFilePayload('/fake/large.package', midFileErrorReader)).toBe(false)
    expect(closedCount).toBe(2)

    // 2. Full planner / pruneBackupsNow integration: >128 KB stored file fails on chunk 2 (position >= 65536) -> unsafe-state, 0 gate ops
    const ws = await makeWorkspace(TOOLS)
    const bigPayload = 'X'.repeat(140_000)
    const b1 = await makeVerifiedBackup(ws, 'big_mod.package', bigPayload)
    await makeVerifiedBackup(ws, 'big_mod.package', 'small-v2')
    await makeVerifiedBackup(ws, 'big_mod.package', 'small-v3')

    const b1BigStored = join(ws.paths.backupsDir, b1.id, 'files', 'Mods', 'big_mod.package')
    const mark = ws.gate.requests.length

    const failSecondChunkOpen = async (file: string): Promise<ReadOnlyFile> => {
      const real = await openForRead(file)
      if (file !== b1BigStored) return real
      return {
        size: real.size,
        read: async (buf, position, length) => {
          if (position > 0) throw new Error('simulated mid-file read failure past 64 KB')
          return await real.read(buf, position, length)
        },
        close: () => real.close()
      }
    }

    expect((await readBackupSummary(ws.deps, ws.simsFolder, failSecondChunkOpen)).canPrune).toBe(false)
    expect(await pruneBackupsNow(ws.deps, ws.simsFolder, failSecondChunkOpen)).toEqual({
      status: 'refused',
      why: 'unsafe-state'
    })
    expect(ws.gate.requests.length).toBe(mark)

    // Premature 0-byte read on non-empty file in backupsDir also fails closed with 0 gate ops
    const prematureZeroOpen = async (file: string): Promise<ReadOnlyFile> => {
      const real = await openForRead(file)
      if (file !== b1BigStored) return real
      return {
        size: real.size,
        read: async () => 0,
        close: () => real.close()
      }
    }

    expect((await readBackupSummary(ws.deps, ws.simsFolder, prematureZeroOpen)).canPrune).toBe(false)
    expect(await pruneBackupsNow(ws.deps, ws.simsFolder, prematureZeroOpen)).toEqual({
      status: 'refused',
      why: 'unsafe-state'
    })
    expect(ws.gate.requests.length).toBe(mark)
  })
})
