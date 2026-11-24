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
  fs: { mkdir: (p) => mkdir(p), copyFile, rename, writeFile, rm, utimes },
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
interface Manifest { record: { id: string; state: string; files: number; bytes: number; folderPath: string }; files: ManifestFile[] }

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

  it('fails when a copy differs from its source, and that backup does not count', async () => {
    const ws = await makeWorkspace(TOOLS)
    let corrupted = false
    ws.gate.hooks.afterOp = async (op) => {
      if (op.op === 'copy' && !corrupted && op.from.endsWith('lamp_b.package')) {
        corrupted = true
        await writeFile(op.to, 'not the same bytes')
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
      action: 'move-script-up',
      summary: 'Moved a script mod up',
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: null,
      steps: [{ kind: 'move', from, to }]
    })

    expect(outcome.status).toBe('done')
    expect(await pathExists(to)).toBe(true)
    expect((await backupStatus(ws.deps, ws.simsFolder)).state).toBe('verified')
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
