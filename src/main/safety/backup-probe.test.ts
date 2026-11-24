// @vitest-environment node
// Windows CI proof for PR 9 (.github/workflows/pr-09-backup.yml). `npm test` skips it; the workflow sets
// SIMS_HELPER_PROBE=backup after `npm run fixtures -- big`.
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createBackup, runAction, undo } from './index.ts'
import { makeWorkspace, SIMS_REL, snapshotTree } from './testing/harness.ts'
import type { WorkspaceTools } from './testing/harness.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const BIG = join(THIS_DIR, '../../../test/fixtures/big')
const roots: string[] = []
const TOOLS: WorkspaceTools = {
  fs: { mkdir: (p) => mkdir(p), copyFile, rename, writeFile, rm, utimes },
  makeTempRoot: async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-probe-')))
    roots.push(root)
    return root
  },
  generate: async (_spec, out) => {
    await cp(BIG, out, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  }
}

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.runIf(process.env.SIMS_HELPER_PROBE === 'backup')('backup probe on the big fixture', () => {
  it('backs up, runs one action and undoes it exactly, within twice the baseline time', async () => {
    const baseline = JSON.parse(await readFile(join(THIS_DIR, 'perf-baseline.json'), 'utf8')) as { windowsBigBackupMs: number | null }
    const ws = await makeWorkspace(TOOLS, 'big')
    const before = await snapshotTree(ws.simsFolder)

    const started = performance.now()
    const backup = await createBackup(ws.deps, ws.simsFolder)
    const backupMs = Math.round(performance.now() - started)
    expect(backup.status).toBe('verified')
    if (backup.status !== 'verified') return
    const backupRequests = ws.gate.requests.filter((r) => r.reason === 'backup')
    expect(backupRequests.length).toBeGreaterThan(2)
    for (const request of backupRequests) expect(request.ops.length).toBeLessThanOrEqual(200)

    // One group's worth of files: the first Mods folder that holds files of its own.
    const tops = (await readdir(ws.mods, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    let top = ''
    let files: string[] = []
    for (const name of tops.sort()) {
      files = (await readdir(join(ws.mods, name), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
      top = name
      if (files.length > 0) break
    }
    expect(files.length, 'a Mods folder with files').toBeGreaterThan(0)
    const outcome = await runAction(ws.deps, {
      action: 'disable-group',
      summary: `Set aside ${top}`,
      origin: { by: 'fix' },
      folderPath: ws.simsFolder,
      groupId: `dir:${top.toLowerCase()}`,
      steps: files.slice(0, 20).map((name) => ({
        kind: 'move' as const,
        from: join(ws.mods, top, name),
        to: join(ws.paths.holdingDir, 'probe', 'Mods', top, name)
      }))
    })
    expect(outcome).toMatchObject({ status: 'done' })
    if (outcome.status !== 'done') return
    const undone = await undo(ws.deps, outcome.entry.id)
    expect(undone).toMatchObject({ status: 'done' })
    const totalMs = Math.round(performance.now() - started)
    expect(await snapshotTree(ws.simsFolder)).toEqual(before)

    process.stdout.write(
      `backup probe: ${backup.record.files} files, ${backup.record.bytes} bytes, backup ${backupMs} ms, ` +
        `backup + action + undo ${totalMs} ms, baseline ${baseline.windowsBigBackupMs ?? 'none yet'}\n`
    )
    if (baseline.windowsBigBackupMs !== null) expect(backupMs).toBeLessThan(2 * baseline.windowsBigBackupMs)
  }, 600_000)
})
