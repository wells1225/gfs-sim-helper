// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Progress } from '../../shared/model.ts'
import { sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import type { AppContext, Fixes, Safety } from '../ports.ts'
import { createContext, onceRecovery } from '../services.ts'
import { fixHandlers } from './handlers.ts'
import { applyFix } from './index.ts'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

function makeHost(): Host {
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

async function makeContext(overrides: {
  safety?: Partial<Safety>
  fixes?: Partial<Fixes>
} = {}): Promise<{ ctx: AppContext; emitted: Progress[]; root: string }> {
  const root = await makeTempDir('sims-fix-handlers-')
  const paths = appPaths({
    localAppData: join(root, 'LocalAppData'),
    appData: join(root, 'Roaming'),
    desktopDir: join(root, 'Desktop')
  })
  await mkdir(paths.stateDir, { recursive: true })

  const emitted: Progress[] = []
  const base = createContext({
    host: makeHost(),
    paths,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    },
    emit: (p) => emitted.push(p),
    reveal: () => {}
  })

  const defaultEntry = sampleJournalEntry()

  const safety: Safety = {
    async backupStatus() {
      return { state: 'verified', backupId: 'b1', at: '2026-11-24T12:00:00.000Z' }
    },
    async createBackup() {
      return {
        status: 'verified',
        record: {
          id: 'b1',
          at: '2026-11-24T12:00:00.000Z',
          folderPath: '/sims',
          files: 1,
          bytes: 100,
          state: 'verified'
        }
      }
    },
    async runAction() {
      return { status: 'done', entry: defaultEntry }
    },
    async undo(entryId) {
      return {
        status: 'done',
        entry: sampleJournalEntry({ id: entryId, status: 'undone', undoneAt: '2026-11-24T12:15:00.000Z' })
      }
    },
    async listJournal() {
      return [defaultEntry]
    },
    async recover() {
      return []
    },
    async closeUndo() {},
    ...overrides.safety
  }

  const fixes: Fixes = {
    async apply(_scan, _request, onProgress) {
      onProgress?.({ task: 'backup', stage: 'copying', done: 1, total: 2 })
      return { status: 'done', entry: defaultEntry }
    },
    async setAside() {
      return { status: 'done', entries: [] }
    },
    async putBack() {
      return { status: 'done', entries: [] }
    },
    async clearCaches() {
      return { status: 'done', entry: defaultEntry }
    },
    async disabledGroups() {
      return []
    },
    ...overrides.fixes
  }

  return {
    root,
    emitted,
    ctx: {
      ...base,
      safety,
      fixes,
      // As services.ts builds it, but over this fake safety: once, lazy, never rejects.
      startupRecovery: onceRecovery(() => safety.recover())
    }
  }
}

describe('fixHandlers', () => {
  it('refuses fix:apply when there is no scan, unknown finding, unoffered fix, or unknown group', async () => {
    const { ctx } = await makeContext()
    const handlers = fixHandlers(ctx)

    // No scan yet
    expect(await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'no-scan' }
    })

    ctx.session.scan = sampleScan()

    // Unknown finding id
    expect(await handlers['fix:apply']({ via: 'finding', findingId: 'does-not-exist', fix: 'turn-mods-on' })).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'unknown-finding' }
    })

    // Fix not offered by that finding
    expect(await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'clear-caches' })).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'unknown-finding' }
    })

    // Unknown group
    expect(await handlers['fix:apply']({ via: 'group', fix: 'disable-group', groupId: 'dir:ghost' })).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'unknown-group' }
    })
  })

  it('resolves valid finding and group fix calls from ctx.session.scan and forwards progress', async () => {
    const applySpy = vi.fn<Fixes['apply']>(async (_scan, _request, onProgress) => {
      onProgress?.({ task: 'backup', stage: 'copying', done: 3, total: 5 })
      return { status: 'done', entry: sampleJournalEntry() }
    })
    const { ctx, emitted } = await makeContext({ fixes: { apply: applySpy } })
    const scan = sampleScan()
    ctx.session.scan = scan
    const handlers = fixHandlers(ctx)

    const res = await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
    expect(res.status).toBe('done')
    expect(applySpy).toHaveBeenCalledWith(scan, { fix: 'turn-mods-on' }, expect.any(Function))
    expect(emitted).toEqual([{ task: 'backup', stage: 'copying', done: 3, total: 5 }])

    const res2 = await handlers['fix:apply']({ via: 'group', fix: 'disable-group', groupId: 'dir:hair' })
    expect(res2.status).toBe('done')
    expect(applySpy).toHaveBeenLastCalledWith(
      scan,
      { fix: 'disable-group', groupId: 'dir:hair' },
      expect.any(Function)
    )
  })

  it('refuses fix:apply when fiftyfifty.json holds an active phase, and allows found or stopped', async () => {
    const { ctx } = await makeContext()
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)
    const stateFile = join(ctx.paths.stateDir, 'fiftyfifty.json')

    for (const activePhase of ['close-curseforge', 'ready-to-test', 'awaiting-answer']) {
      await writeFile(stateFile, JSON.stringify({ phase: activePhase }), 'utf8')
      const res = await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
      expect(res, `phase ${activePhase}`).toEqual({
        status: 'refused',
        refusal: { why: 'fifty-fifty-running' }
      })
    }

    for (const donePhase of ['found', 'stopped']) {
      await writeFile(stateFile, JSON.stringify({ phase: donePhase }), 'utf8')
      const res = await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
      expect(res.status, `phase ${donePhase}`).toBe('done')
    }
  })

  it('runs recovery once when index.ts and the handlers both ask for it', async () => {
    const recoverSpy = vi.fn<Safety['recover']>(async () => [])
    const listSpy = vi.fn<Safety['listJournal']>(async () => [sampleJournalEntry()])
    const { ctx } = await makeContext({ safety: { recover: recoverSpy, listJournal: listSpy } })

    // index.ts: after registerIpc, before the window opens.
    const handlers = fixHandlers(ctx)
    void ctx.startupRecovery()
    fixHandlers(ctx) // built again for the same context: still no second run

    const first = await handlers['journal:list'](undefined)
    const second = await handlers['journal:list'](undefined)
    ctx.session.scan = sampleScan()
    await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
    await handlers['journal:undo']({ entryId: 'e-1' })
    await handlers['groups:disabled'](undefined)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(recoverSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledTimes(2)
  })

  it('building the handlers does not start recovery; the first call that needs it does, once', async () => {
    const recoverSpy = vi.fn<Safety['recover']>(async () => [])
    const { ctx } = await makeContext({ safety: { recover: recoverSpy } })
    const handlers = fixHandlers(ctx)
    expect(recoverSpy).not.toHaveBeenCalled()

    await handlers['journal:list'](undefined)
    await handlers['journal:list'](undefined)
    expect(recoverSpy).toHaveBeenCalledTimes(1)
  })

  it('journal:recovery answers what the one start-up run did, and never starts a second', async () => {
    const put = sampleJournalEntry({ id: 'e-cut', status: 'undone', undoneAt: '2026-11-24T12:20:00.000Z' })
    const recoverSpy = vi.fn<Safety['recover']>(async () => [put])
    const { ctx } = await makeContext({ safety: { recover: recoverSpy } })
    void ctx.startupRecovery()
    const handlers = fixHandlers(ctx)

    expect(await handlers['journal:recovery'](undefined)).toEqual({ status: 'finished', touched: [put] })
    expect(await handlers['journal:recovery'](undefined)).toEqual({ status: 'finished', touched: [put] })
    expect(recoverSpy).toHaveBeenCalledTimes(1)
  })

  it('journal:recovery answers failed, with no error text, when recover throws or rejects', async () => {
    for (const recover of [
      async () => {
        throw new Error('C:\\Users\\Lila\\journal locked')
      },
      () => {
        throw new Error('C:\\Users\\Lila\\sync')
      }
    ] as Safety['recover'][]) {
      const { ctx } = await makeContext({ safety: { recover } })
      expect(() => fixHandlers(ctx)).not.toThrow()
      const answer = await fixHandlers(ctx)['journal:recovery'](undefined)
      expect(answer).toEqual({ status: 'failed' })
      expect(JSON.stringify(answer)).not.toContain('Lila')
    }
  })

  it('journal:list waits for startup recovery, and still answers when recovery failed', async () => {
    let finish!: () => void
    const order: string[] = []
    const recoverSpy = vi.fn<Safety['recover']>(
      () =>
        new Promise((resolve) => {
          finish = () => {
            order.push('recovered')
            resolve([])
          }
        })
    )
    const listSpy = vi.fn<Safety['listJournal']>(async () => {
      order.push('listed')
      return [sampleJournalEntry()]
    })
    const { ctx } = await makeContext({ safety: { recover: recoverSpy, listJournal: listSpy } })
    const listed = fixHandlers(ctx)['journal:list'](undefined)
    await new Promise((r) => setTimeout(r, 10))
    expect(listSpy).not.toHaveBeenCalled()
    finish()
    expect(await listed).toHaveLength(1)
    expect(order).toEqual(['recovered', 'listed'])

    const failing = await makeContext({
      safety: {
        recover: async () => {
          throw new Error('C:\\Users\\Lila\\journal locked')
        }
      }
    })
    expect(await fixHandlers(failing.ctx)['journal:list'](undefined)).toHaveLength(1)
  })

  it('fix:apply and journal:undo wait for startup recovery before changing anything', async () => {
    let finish!: () => void
    const recoverSpy = vi.fn<Safety['recover']>(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([])
        })
    )
    const applySpy = vi.fn<Fixes['apply']>(async () => ({ status: 'done', entry: sampleJournalEntry() }))
    const undoSpy = vi.fn<Safety['undo']>(async (entryId) => ({
      status: 'done',
      entry: sampleJournalEntry({ id: entryId, status: 'undone', undoneAt: '2026-11-24T12:15:00.000Z' })
    }))
    const { ctx } = await makeContext({ safety: { recover: recoverSpy, undo: undoSpy }, fixes: { apply: applySpy } })
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)

    const applied = handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
    const undone = handlers['journal:undo']({ entryId: 'e-1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(applySpy).not.toHaveBeenCalled()
    expect(undoSpy).not.toHaveBeenCalled()

    finish()
    expect((await applied).status).toBe('done')
    expect((await undone).status).toBe('done')
  })

  it('handles backup:status, journal:undo and groups:disabled with or without an active scan', async () => {
    const { ctx } = await makeContext({
      fixes: {
        async disabledGroups(folderPath) {
          return [
            {
              groupId: 'cf:901234',
              label: 'Wicked Wardrobe',
              entryId: 'e-1',
              at: '2026-11-24T12:00:00.000Z',
              origin: 'fix' as const
            }
          ].filter(() => folderPath.length > 0)
        }
      }
    })
    const handlers = fixHandlers(ctx)

    expect(await handlers['backup:status'](undefined)).toEqual({ state: 'none' })

    await writeFile(
      join(ctx.paths.stateDir, 'settings.json'),
      JSON.stringify({ welcome: 'seen', folderPath: '/saved/The Sims 4' }),
      'utf8'
    )
    expect(await handlers['backup:status'](undefined)).toEqual({
      state: 'verified',
      backupId: 'b1',
      at: '2026-11-24T12:00:00.000Z'
    })
    expect(await handlers['groups:disabled'](undefined)).toEqual([
      {
        groupId: 'cf:901234',
        label: 'Wicked Wardrobe',
        entryId: 'e-1',
        at: '2026-11-24T12:00:00.000Z',
        origin: 'fix'
      }
    ])

    const undone = await handlers['journal:undo']({ entryId: 'e-1' })
    expect(undone.status).toBe('done')
  })
})

describe('review: fix:apply checks the shape of what the window sends', () => {
  it('refuses a missing or malformed call instead of throwing, and never treats an unknown group fix as enable', async () => {
    const applied: unknown[] = []
    const { ctx } = await makeContext({
      fixes: {
        async apply(_scan, request) {
          applied.push(request)
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
        }
      }
    })
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)
    const apply = handlers['fix:apply'] as (req: unknown) => Promise<unknown>

    for (const bad of [
      null,
      undefined,
      {},
      { via: 'finding', findingId: 42, fix: 'turn-mods-on' },
      { via: 'group', fix: 'clear-caches', groupId: 'dir:hair' },
      { via: 'group', fix: 'enable-group', groupId: 7 }
    ]) {
      const res = (await apply(bad)) as { status: string }
      expect(res.status).toBe('refused')
    }
    expect(applied).toEqual([])
  })
})

describe('review: a fix that throws comes back as a calm refusal', () => {
  it('returns a refusal when fixes.apply throws before anything changed (the journal entry could not be written)', async () => {
    const { ctx } = await makeContext({
      fixes: {
        async apply() {
          throw new Error('journal entry could not be written: C:\\Users\\lila\\AppData')
        }
      }
    })
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)

    const res = await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
    expect(res).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(JSON.stringify(res)).not.toContain('lila')
  })

  it('a disable that stops part way and whose undo throws stays stopped-part-way, never not-started', async () => {
    const { ctx } = await makeContext({
      safety: {
        async runAction(plan) {
          return {
            status: 'stopped-part-way',
            entry: sampleJournalEntry({ id: plan.entryId, action: plan.action, groupId: plan.groupId, status: 'needs-attention' }),
            detail: 'disk full'
          }
        },
        async undo() {
          throw new Error('journal locked: C:\\Users\\lila\\AppData')
        }
      }
    })
    ctx.fixes.apply = (scan, request, onProgress) =>
      applyFix({ safety: ctx.safety, paths: ctx.paths, newId: () => 'e-half' }, scan, request, onProgress)
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)

    const res = await handlers['fix:apply']({ via: 'group', fix: 'disable-group', groupId: 'dir:hair' })
    expect(res.status).toBe('stopped-part-way')
    expect(JSON.stringify(res)).not.toContain('lila')
  })
})

describe('last check: an unreadable fiftyfifty.json blocks fixes', () => {
  it('treats a file it cannot read or understand as a 50/50 test in progress, for fix:apply and journal:undo', async () => {
    const { ctx } = await makeContext()
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)
    const stateFile = join(ctx.paths.stateDir, 'fiftyfifty.json')
    const refused = { status: 'refused', refusal: { why: 'fifty-fifty-running' } }

    for (const text of ['{ "phase": "awaiting', '', '{}', 'null', '[]', '{"phase":5}', '{"phase":null}']) {
      await writeFile(stateFile, text, 'utf8')
      expect(
        await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' }),
        `fix:apply with ${JSON.stringify(text)}`
      ).toEqual(refused)
      expect(
        await handlers['fix:apply']({ via: 'group', fix: 'disable-group', groupId: 'dir:hair' }),
        `disable-group with ${JSON.stringify(text)}`
      ).toEqual(refused)
      expect(await handlers['journal:undo']({ entryId: 'e-1' }), `journal:undo with ${JSON.stringify(text)}`).toEqual(
        refused
      )
    }

    // Something that is there but is not a readable file (works the same on Windows and macOS).
    await rm(stateFile)
    await mkdir(stateFile)
    expect(await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })).toEqual(refused)
  })

  it('still lets fixes through when there is no fiftyfifty.json at all', async () => {
    const { ctx } = await makeContext()
    ctx.session.scan = sampleScan()
    const handlers = fixHandlers(ctx)
    const res = await handlers['fix:apply']({ via: 'finding', findingId: 'mods-off', fix: 'turn-mods-on' })
    expect(res.status).toBe('done')
  })
})
