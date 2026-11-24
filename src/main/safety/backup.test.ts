// @vitest-environment node
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { sha256File } from '../fs-read.ts'
import { BACKUP_ALSO_SKIPS, CACHE_NAMES } from '../ports.ts'
import { backupStatus, createBackup, runAction } from './index.ts'
import { makeWorkspace, pathExists, snapshotTree } from './testing/harness.ts'
import type { WorkspaceTools } from './testing/harness.ts'

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/fixtures/specs')
const roots: string[] = []
const TOOLS: WorkspaceTools = {
  fs: { mkdir, copyFile, rename, writeFile, rm, utimes },
  makeTempRoot: async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-backup-')))
    roots.push(root)
    return root
  },
  generate: async (spec, out) => {
    await generateFixture(await loadSpec(join(SPECS, `${spec}.json`)), out)
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface ManifestFile { path: string; bytes: number; mtimeMs: number; sha256: string; storedIn: string }
interface SkippedLink { path: string; reason: string }
interface Manifest {
  record: { id: string; state: string; files: number; bytes: number; folderPath: string }
  files: ManifestFile[]
  skipped?: SkippedLink[]
}

async function readManifest(backupsDir: string, id: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(backupsDir, id, 'manifest.json'), 'utf8')) as Manifest
}

const SKIPPED_TOP = [...CACHE_NAMES, ...BACKUP_ALSO_SKIPS].map((n) => n.replace(/\/$/, '').toLowerCase())

function expectedFiles(tree: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rel, kind] of Object.entries(tree)) {
    if (kind === 'dir') continue
    if (SKIPPED_TOP.includes(rel.split('/')[0]!.toLowerCase())) continue
    out[rel] = kind
  }
  return out
}

function copyOps(ws: { gate: { requests: { reason: string; ops: { op: string }[] }[] } }, from = 0): number {
  return ws.gate.requests
    .slice(from)
    .filter((r) => r.reason === 'backup')
    .flatMap((r) => r.ops)
    .filter((op) => op.op === 'copy').length
}

describe('createBackup', () => {
  it('copies every file except the caches, checks each one, and leaves saves and Tray alone', async () => {
    const ws = await makeWorkspace(TOOLS)
    const before = await snapshotTree(ws.simsFolder)

    const result = await createBackup(ws.deps, ws.simsFolder)

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    const id = result.record.id
    const copied = await snapshotTree(join(ws.paths.backupsDir, id, 'files'))
    const want = expectedFiles(before)
    expect(Object.keys(want).some((p) => p.startsWith('saves/'))).toBe(true)
    expect(Object.keys(want).some((p) => p.startsWith('Tray/'))).toBe(true)
    expect(expectedFiles(copied)).toEqual(want)
    for (const name of ['localthumbcache.package', 'cachestr', 'avatarcache.package']) {
      expect(await pathExists(join(ws.paths.backupsDir, id, 'files', name))).toBe(false)
    }

    const manifest = await readManifest(ws.paths.backupsDir, id)
    expect(manifest.record.state).toBe('verified')
    expect(manifest.record.folderPath).toBe(ws.simsFolder)
    expect(manifest.record.files).toBe(Object.keys(want).length)
    expect(Object.fromEntries(manifest.files.map((f) => [f.path, f.sha256]))).toEqual(want)
    expect(manifest.files.every((f) => f.storedIn === id)).toBe(true)
    expect(result.record).toEqual(manifest.record)

    expect(await snapshotTree(ws.simsFolder)).toEqual(before)
    for (const request of ws.gate.requests) {
      expect(request.reason).toBe('backup')
      expect(request.ops.length).toBeLessThanOrEqual(200)
      if (request.ops.some((op) => op.op === 'copy')) expect(request.folderPath).toBe(ws.simsFolder)
    }
  })

  it('copies only what changed since the last verified backup, and the manifest still reaches every file', async () => {
    const ws = await makeWorkspace(TOOLS)
    const first = await createBackup(ws.deps, ws.simsFolder)
    expect(first.status).toBe('verified')
    if (first.status !== 'verified') return

    const changed = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    await writeFile(changed, 'a different lamp')
    await utimes(changed, new Date('2026-11-23T10:00:00Z'), new Date('2026-11-23T10:00:00Z'))

    const mark = ws.gate.requests.length
    const second = await createBackup(ws.deps, ws.simsFolder)
    expect(second.status).toBe('verified')
    if (second.status !== 'verified') return
    expect(copyOps(ws, mark)).toBe(1)

    const third = await createBackup(ws.deps, ws.simsFolder)
    expect(third.status).toBe('verified')
    if (third.status !== 'verified') return
    const manifest = await readManifest(ws.paths.backupsDir, third.record.id)
    const now = expectedFiles(await snapshotTree(ws.simsFolder))
    expect(manifest.files.map((f) => f.path).sort()).toEqual(Object.keys(now).sort())
    for (const file of manifest.files) {
      // The restore list: every line points at the backup that really holds its bytes.
      expect(file.storedIn === first.record.id || file.storedIn === second.record.id, file.path).toBe(true)
      const stored = join(ws.paths.backupsDir, file.storedIn, 'files', ...file.path.split('/'))
      expect(await sha256File(stored), file.path).toBe(file.sha256)
      expect(file.sha256, file.path).toBe(now[file.path])
    }
    expect(manifest.files.find((f) => f.path === 'Mods/BuildBuy/lamp_a.package')?.storedIn).toBe(second.record.id)
  })

  it.skipIf(process.platform === 'win32')(
    'skips and lists every link inside the Sims folder (in-folder, outside, folder and broken) without failing the backup',
    async () => {
      const ws = await makeWorkspace(TOOLS)
      const outside = join(ws.root, 'elsewhere.package')
      await writeFile(outside, 'not hers to back up')
      const { symlink } = await import('node:fs/promises')
      await symlink(outside, join(ws.mods, 'outside.package'))
      await symlink(join(ws.mods, 'BuildBuy', 'lamp_a.package'), join(ws.mods, 'in-folder.package'))
      await symlink(join(ws.mods, 'BuildBuy'), join(ws.mods, 'folder-link'))
      await symlink(join(ws.mods, 'no-such-file.package'), join(ws.mods, 'broken.package'))

      const result = await createBackup(ws.deps, ws.simsFolder)

      expect(result.status).toBe('verified')
      if (result.status !== 'verified') return
      const manifest = await readManifest(ws.paths.backupsDir, result.record.id)
      for (const name of ['outside.package', 'in-folder.package', 'folder-link', 'broken.package']) {
        expect(manifest.files.some((f) => f.path.includes(name)), name).toBe(false)
      }
      expect(manifest.skipped).toEqual([
        { path: 'Mods/broken.package', reason: 'link' },
        { path: 'Mods/folder-link', reason: 'link' },
        { path: 'Mods/in-folder.package', reason: 'link' },
        { path: 'Mods/outside.package', reason: 'link' }
      ])
      expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')
    }
  )

  it('skips and lists a folder link (junction on Windows) inside Mods without failing the backup', async () => {
    const ws = await makeWorkspace(TOOLS)
    const { symlink } = await import('node:fs/promises')
    await symlink(join(ws.mods, 'BuildBuy'), join(ws.mods, 'BuildBuyLink'), 'junction')

    const result = await createBackup(ws.deps, ws.simsFolder)

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    const manifest = await readManifest(ws.paths.backupsDir, result.record.id)
    expect(manifest.files.some((f) => f.path.includes('BuildBuyLink'))).toBe(false)
    expect(manifest.skipped).toEqual([{ path: 'Mods/BuildBuyLink', reason: 'link' }])
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')
  })

  it('succeeds even when the parent of dataDir does not exist yet (never mkdirs outside dataDir)', async () => {
    const ws = await makeWorkspace(TOOLS)
    await rm(dirname(ws.paths.dataDir), { recursive: true, force: true })

    const result = await createBackup(ws.deps, ws.simsFolder)

    expect(result.status).toBe('verified')
  })

  it('crashes during backup (after manifest create, mid-copy, before final verify write) keep the old backup and source intact', async () => {
    const ws = await makeWorkspace(TOOLS)
    const first = await createBackup(ws.deps, ws.simsFolder)
    if (first.status !== 'verified') throw new Error(first.status)
    await writeFile(join(ws.mods, 'added_after_first.package'), 'needs copying in backup 2')
    const afterAdd = await snapshotTree(ws.simsFolder)

    // Crash after writing copying manifest, before copies run.
    ws.gate.hooks.beforeRequest = (request) =>
      request.ops.some((op) => op.op === 'copy') ? { status: 'failed', opsDone: 0, detail: 'simulated crash' } : undefined
    const failed1 = await createBackup(ws.deps, ws.simsFolder)
    expect(failed1.status).toBe('failed')
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'stale',
      backupId: first.record.id,
      at: first.record.at
    })

    // Crash right before the final verified manifest write (leaving state: 'copying' on disk).
    ws.gate.hooks.beforeRequest = (request) => {
      const replace = request.ops.find((op) => op.op === 'write' && op.mode === 'replace')
      if (replace) throw new Error('power loss')
      return undefined
    }
    const failed2 = await createBackup(ws.deps, ws.simsFolder)
    expect(failed2.status).toBe('failed')
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'stale',
      backupId: first.record.id,
      at: first.record.at
    })
    expect(await snapshotTree(ws.simsFolder)).toEqual(afterAdd)
  })

  it('does not reuse a stale copy when bytes change within the same millisecond right after a backup', async () => {
    const ws = await makeWorkspace(TOOLS)
    const lamp = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    const now = new Date('2026-11-24T12:00:00.000Z')
    await utimes(lamp, now, now)
    ws.deps.clock = { now: () => now }

    const first = await createBackup(ws.deps, ws.simsFolder)
    if (first.status !== 'verified') throw new Error(first.status)

    // Same size, same whole-millisecond mtime as the previous backup, different bytes.
    const bytes = await readFile(lamp)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    await writeFile(lamp, bytes)
    await utimes(lamp, now, now)
    const updatedHash = await sha256File(lamp)

    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('stale')

    const mark = ws.gate.requests.length
    const second = await createBackup(ws.deps, ws.simsFolder)
    expect(second.status).toBe('verified')
    if (second.status !== 'verified') return
    expect(copyOps(ws, mark)).toBe(1)
    const manifest = await readManifest(ws.paths.backupsDir, second.record.id)
    const line = manifest.files.find((f) => f.path === 'Mods/BuildBuy/lamp_a.package')
    expect(line?.storedIn).toBe(second.record.id)
    expect(line?.sha256).toBe(updatedHash)
  })

  it('fails verification when the source changes (same size, new date) between listing and copy', async () => {
    const ws = await makeWorkspace(TOOLS)
    const lamp = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    let mutated = false
    ws.gate.hooks.beforeOp = async (op) => {
      if (op.op === 'copy' && !mutated && op.from === lamp) {
        mutated = true
        const bytes = await readFile(lamp)
        bytes[0] = bytes[0]! ^ 0xff
        await writeFile(lamp, bytes)
        await utimes(lamp, new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'))
      }
      return undefined
    }

    const result = await createBackup(ws.deps, ws.simsFolder)

    expect(mutated).toBe(true)
    expect(result.status).toBe('failed')
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({ state: 'none' })
  })

  it('fails when a copy differs from its source, and that backup does not count', async () => {
    const ws = await makeWorkspace(TOOLS)
    let corrupted = false
    ws.gate.hooks.afterOp = async (op) => {
      if (op.op === 'copy' && !corrupted && op.from.endsWith('lamp_b.package')) {
        corrupted = true
        // Same size, different bytes: only the SHA-256 check can catch it.
        const bytes = await readFile(op.to)
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
        await writeFile(op.to, bytes)
      }
    }

    const result = await createBackup(ws.deps, ws.simsFolder)

    expect(corrupted).toBe(true)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.detail).toContain('lamp_b.package')
    const ids = await (await import('node:fs/promises')).readdir(ws.paths.backupsDir)
    expect(ids).toHaveLength(1)
    expect((await readManifest(ws.paths.backupsDir, ids[0]!)).record.state).toBe('failed')
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({ state: 'none' })
  })

  it('fails, and does not count, when the gate stops part way through the copies', async () => {
    const ws = await makeWorkspace(TOOLS)
    ws.gate.hooks.beforeOp = (op) => (op.op === 'copy' && op.from.endsWith('lamp_a.package') ? 'disk full' : undefined)

    const result = await createBackup(ws.deps, ws.simsFolder)

    expect(result.status).toBe('failed')
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({ state: 'none' })
  })

  it('sends copying and checking progress, at most once every 100 ms', async () => {
    const ws = await makeWorkspace(TOOLS)
    const stages: string[] = []
    const result = await createBackup(ws.deps, ws.simsFolder, (p) => {
      expect(p.task).toBe('backup')
      stages.push(p.stage)
    })
    expect(result.status).toBe('verified')
    expect(stages).toContain('copying')
    expect(stages).toContain('checking')

    const frozen = await makeWorkspace(TOOLS)
    const at = new Date('2026-11-24T12:00:00Z')
    frozen.deps.clock = { now: () => at }
    let calls = 0
    await createBackup(frozen.deps, frozen.simsFolder, () => {
      calls += 1
    })
    expect(calls).toBe(1)
  })
})

describe('backupStatus', () => {
  it('is none before any backup, verified right after one', async () => {
    const ws = await makeWorkspace(TOOLS)
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({ state: 'none' })
    const result = await createBackup(ws.deps, ws.simsFolder)
    if (result.status !== 'verified') throw new Error(result.status)
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'verified',
      backupId: result.record.id,
      at: result.record.at
    })
  })

  it('is stale after a file appears in Mods, and after one changes', async () => {
    const ws = await makeWorkspace(TOOLS)
    const result = await createBackup(ws.deps, ws.simsFolder)
    if (result.status !== 'verified') throw new Error(result.status)

    await writeFile(join(ws.mods, 'new_hair.package'), 'new')
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('stale')

    await rm(join(ws.mods, 'new_hair.package'))
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')

    const lamp = join(ws.mods, 'BuildBuy', 'lamp_a.package')
    await utimes(lamp, new Date('2026-11-23T10:00:00Z'), new Date('2026-11-23T10:00:00Z'))
    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'stale',
      backupId: result.record.id,
      at: result.record.at
    })
  })

  it('ignores changes outside Mods, such as a new save', async () => {
    const ws = await makeWorkspace(TOOLS)
    await createBackup(ws.deps, ws.simsFolder)
    await writeFile(join(ws.simsFolder, 'saves', 'Slot_00000009.save'), 'played')
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')
  })

  it('stays verified after one of our own actions moved a file inside Mods', async () => {
    const ws = await makeWorkspace(TOOLS)
    await createBackup(ws.deps, ws.simsFolder)
    const from = join(ws.mods, 'HelperMod', 'helper_mod.ts4script')
    const to = join(ws.mods, 'helper_mod.ts4script')

    const outcome = await runAction(ws.deps, {
      entryId: 'move-script-1',
      action: 'move-script-up',
      summary: 'Moved a script mod up',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      groupLabel: null,
      hasScript: false,
      steps: [{ kind: 'move', from, to }]
    })

    expect(outcome.status).toBe('done')
    expect(await pathExists(to)).toBe(true)
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')

    // If that moved file is later altered in-place (even keeping its byte count), status becomes stale.
    const bytes = await readFile(to)
    bytes[0] = bytes[0]! ^ 0xff
    await writeFile(to, bytes)
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('stale')
  })

  it('picks the newer verified backup by timestamp even when two backups share the same second with reversed random suffixes', async () => {
    const ws = await makeWorkspace(TOOLS)
    const ids = ['20261124-120000-ffff', '20261124-120000-0001']
    const times = [new Date('2026-11-24T12:00:00.100Z'), new Date('2026-11-24T12:00:00.800Z')]
    let n = 0
    ws.deps.newId = () => ids[n]!
    ws.deps.clock = { now: () => times[Math.min(n, times.length - 1)]! }

    const first = await createBackup(ws.deps, ws.simsFolder)
    if (first.status !== 'verified') throw new Error(first.status)
    await writeFile(join(ws.mods, 'added.package'), 'brand new')
    n = 1
    const second = await createBackup(ws.deps, ws.simsFolder)
    if (second.status !== 'verified') throw new Error(second.status)

    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'verified',
      backupId: second.record.id,
      at: second.record.at
    })
  })

  it('does not let a journal move from an older backup excuse an unbacked-up file after a newer backup', async () => {
    const ws = await makeWorkspace(TOOLS)
    await createBackup(ws.deps, ws.simsFolder)
    const from = join(ws.mods, 'HelperMod', 'helper_mod.ts4script')
    const to = join(ws.mods, 'helper_mod.ts4script')
    const moved = await runAction(ws.deps, {
      entryId: 'move-old-1',
      action: 'move-script-up',
      summary: 'Moved a script mod up',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      groupLabel: null,
      hasScript: false,
      steps: [{ kind: 'move', from, to }]
    })
    if (moved.status !== 'done') throw new Error(moved.status)
    const size = (await readFile(to)).byteLength

    // Remove the moved file, take a fresh backup that does not have it, then drop a brand-new same-size file there.
    await rm(to)
    const fresh = await createBackup(ws.deps, ws.simsFolder)
    if (fresh.status !== 'verified') throw new Error(fresh.status)
    await writeFile(to, Buffer.alloc(size, 0x5a))

    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('stale')
  })

  it('is stale when an older backup folder that still holds the bytes was deleted, and the next backup copies them again', async () => {
    const ws = await makeWorkspace(TOOLS)
    const first = await createBackup(ws.deps, ws.simsFolder)
    if (first.status !== 'verified') throw new Error(first.status)
    await writeFile(join(ws.mods, 'new_hair.package'), 'new')
    const second = await createBackup(ws.deps, ws.simsFolder)
    if (second.status !== 'verified') throw new Error(second.status)
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')

    // Someone frees disk space by deleting the old backup. The newest list still points at it for almost every file.
    await rm(join(ws.paths.backupsDir, first.record.id), { recursive: true })

    expect(await backupStatus(ws.deps, ws.simsFolder)).toEqual({
      state: 'stale',
      backupId: second.record.id,
      at: second.record.at
    })

    const third = await createBackup(ws.deps, ws.simsFolder)
    if (third.status !== 'verified') throw new Error(third.status)
    const manifest = await readManifest(ws.paths.backupsDir, third.record.id)
    for (const file of manifest.files) {
      const stored = join(ws.paths.backupsDir, file.storedIn, 'files', ...file.path.split('/'))
      expect(await sha256File(stored), file.path).toBe(file.sha256)
    }
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')
  })

  it('is stale when one stored copy is gone, in Mods or in saves', async () => {
    for (const top of ['Mods/', 'saves/']) {
      const ws = await makeWorkspace(TOOLS)
      const result = await createBackup(ws.deps, ws.simsFolder)
      if (result.status !== 'verified') throw new Error(result.status)
      const manifest = await readManifest(ws.paths.backupsDir, result.record.id)
      const line = manifest.files.find((f) => f.path.startsWith(top))
      if (!line) throw new Error(`no ${top} file in the backup`)

      await rm(join(ws.paths.backupsDir, line.storedIn, 'files', ...line.path.split('/')))

      expect((await backupStatus(ws.deps, ws.simsFolder)).state, top).toBe('stale')
    }
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('is unknown when Mods cannot be read', async () => {
    const ws = await makeWorkspace(TOOLS)
    await createBackup(ws.deps, ws.simsFolder)
    const { chmod } = await import('node:fs/promises')
    await chmod(join(ws.mods, 'BuildBuy'), 0o000)
    try {
      expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('unknown')
    } finally {
      await chmod(join(ws.mods, 'BuildBuy'), 0o755)
    }
  })
})
