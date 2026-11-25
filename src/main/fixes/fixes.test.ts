// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FixOutcome,
  FixRefusal,
  JournalEntry,
  ModFile,
  ModGroup,
  Progress,
  Scan
} from '../../shared/model.ts'
import { SAMPLE_SHA_A, sampleJournalEntry, sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import { CACHE_NAMES, type ActionPlan, type FixDeps, type OnProgress, type Safety } from '../ports.ts'
import { DISABLE } from './disable.ts'
import {
  applyFix,
  clearCaches,
  disabledGroups,
  planFix,
  putBack,
  setAside
} from './index.ts'

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

function makeFakeSafety(overrides: Partial<Safety> = {}): Safety & {
  ranPlans: ActionPlan[]
  undoneIds: string[]
} {
  const ranPlans: ActionPlan[] = []
  const undoneIds: string[] = []
  const journal: JournalEntry[] = []

  return {
    ranPlans,
    undoneIds,
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
          files: 10,
          bytes: 1000,
          state: 'verified'
        }
      }
    },
    async runAction(plan: ActionPlan, _onProgress?: OnProgress): Promise<FixOutcome> {
      ranPlans.push(plan)
      const entry = sampleJournalEntry({
        id: `entry-${ranPlans.length}`,
        action: plan.action,
        summary: plan.summary,
        origin: plan.origin,
        folderPath: plan.folderPath,
        groupId: plan.groupId,
        groupLabel: plan.groupLabel,
        hasScript: plan.hasScript,
        status: 'done',
        undo: plan.steps.every((s) => s.kind === 'remove-cache') ? 'cannot-undo' : 'can-undo'
      })
      journal.unshift(entry)
      return { status: 'done', entry }
    },
    async undo(entryId: string, _onProgress?: OnProgress): Promise<FixOutcome> {
      undoneIds.push(entryId)
      const existing = journal.find((e) => e.id === entryId)
      const updated = sampleJournalEntry({
        ...(existing ?? {}),
        id: entryId,
        status: 'undone',
        undoneAt: '2026-11-24T12:10:00.000Z'
      })
      if (existing) {
        existing.status = 'undone'
        existing.undoneAt = updated.undoneAt
      }
      return { status: 'done', entry: updated }
    },
    async listJournal() {
      return [...journal]
    },
    async recover() {
      return []
    },
    async closeUndo() {},
    ...overrides
  }
}

function makeDeps(safety: Safety, root = '/fake'): FixDeps {
  let seq = 0
  return {
    safety,
    paths: appPaths({
      localAppData: join(root, 'LocalAppData'),
      appData: join(root, 'Roaming'),
      desktopDir: join(root, 'Desktop')
    }),
    newId() {
      seq += 1
      return `20261124-12000${seq}-abcd`
    }
  }
}

describe('DISABLE mechanism', () => {
  it('plans move-to-holding steps keeping relative paths under holdingDir/<entryId>/Mods/', () => {
    expect(DISABLE.method).toBe('move-to-holding')
    const group: ModGroup = {
      id: 'dir:clothes',
      label: 'Clothes',
      source: 'folder',
      files: ['Clothes/shirt.package', 'Clothes/Sub/jacket.package'],
      bytes: 2048,
      hasScript: false,
      curseForge: null
    }

    const steps = DISABLE.plan(group, {
      modsDir: join('/sims', 'Mods'),
      holdingDir: join('/data', 'holding'),
      entryId: 'entry-1'
    })

    expect(steps).toEqual([
      {
        kind: 'move',
        from: join('/sims', 'Mods', 'Clothes', 'shirt.package'),
        to: join('/data', 'holding', 'entry-1', 'Mods', 'Clothes', 'shirt.package')
      },
      {
        kind: 'move',
        from: join('/sims', 'Mods', 'Clothes', 'Sub', 'jacket.package'),
        to: join('/data', 'holding', 'entry-1', 'Mods', 'Clothes', 'Sub', 'jacket.package')
      }
    ])
  })
})

describe('planFix', () => {
  const at = { holdingDir: join('/data', 'holding'), entryId: 'entry-42' }

  it('plans turn-mods-on keeping CRLF, unknown keys, comments, and other sections byte-for-byte', () => {
    const scan = sampleScan()
    const original = [
      '[options]',
      'fullscreen=1',
      'customkey = keep_me',
      'modsdisabled=1',
      'scriptmodsenabled=0',
      'showmodliststartup=1',
      '',
      '[other]',
      'modsdisabled=1',
      ''
    ].join('\r\n')

    const result = planFix(scan, { fix: 'turn-mods-on' }, { ...at, optionsText: original })
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') return

    expect(result.plan.action).toBe('turn-mods-on')
    expect(result.plan.steps).toHaveLength(1)
    const step = result.plan.steps[0]!
    expect(step.kind).toBe('edit')
    if (step.kind !== 'edit') return

    expect(step.path).toBe(join(scan.folder.path, 'Options.ini'))
    expect(step.newText).toBe(
      [
        '[options]',
        'fullscreen=1',
        'customkey = keep_me',
        'modsdisabled=0',
        'scriptmodsenabled=1',
        'showmodliststartup=1',
        '',
        '[other]',
        'modsdisabled=1',
        ''
      ].join('\r\n')
    )
  })

  it('adds missing keys into [options] preserving LF line endings', () => {
    const scan = sampleScan()
    const original = ['[options]', 'fullscreen=1', '', '[graphics]', 'edge=2', ''].join('\n')

    const result = planFix(scan, { fix: 'turn-mods-on' }, { ...at, optionsText: original })
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') return
    const step = result.plan.steps[0]!
    expect(step.kind).toBe('edit')
    if (step.kind !== 'edit') return

    expect(step.newText).toBe(
      ['[options]', 'fullscreen=1', 'modsdisabled=0', 'scriptmodsenabled=1', '', '[graphics]', 'edge=2', ''].join('\n')
    )
  })

  it('refuses turn-mods-on with nothing-to-do when keys are already enabled', () => {
    const scan = sampleScan()
    const original = ['[options]', 'modsdisabled=0', 'scriptmodsenabled=1', ''].join('\r\n')

    const result = planFix(scan, { fix: 'turn-mods-on' }, { ...at, optionsText: original })
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
  })

  it('plans move-script-up to the top folder (depth 1)', () => {
    const scan = sampleScan()
    const scriptRel = 'Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script'

    const result = planFix(scan, { fix: 'move-script-up', files: [scriptRel] }, at)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') return

    expect(result.plan.action).toBe('move-script-up')
    expect(result.plan.steps).toEqual([
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'Gameplay', 'WickedWardrobe', 'Scripts', 'wardrobe.ts4script'),
        to: join(scan.inventory.modsDir, 'Gameplay', 'wardrobe.ts4script')
      }
    ])
  })

  it('refuses move-script-up with file-changed when a file already sits at the destination', () => {
    const base = sampleScan()
    const collisionFile: ModFile = {
      kind: 'script',
      relPath: 'Gameplay/wardrobe.ts4script',
      bytes: 1000,
      modifiedAt: '2026-11-10T10:00:00.000Z',
      hash: { status: 'not-needed' },
      groupId: 'dir:gameplay',
      depth: 1,
      script: { status: 'ok', entries: ['other.pyc'] }
    }
    const scan: Scan = {
      ...base,
      inventory: {
        ...base.inventory,
        files: [...base.inventory.files, collisionFile]
      }
    }

    const result = planFix(
      scan,
      { fix: 'move-script-up', files: ['Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script'] },
      at
    )
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'file-changed' }
    })
  })

  it('refuses move-script-up with file-changed when a requested file is not in the scan', () => {
    const scan = sampleScan()
    const result = planFix(scan, { fix: 'move-script-up', files: ['Missing/Deep/mod.ts4script'] }, at)
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'file-changed' }
    })
  })

  it('plans set-aside-files into holdingDir/<entryId>/Mods/<relPath>', () => {
    const base = sampleScan()
    const archive: ModFile = {
      kind: 'archive',
      relPath: 'Downloads/bundle.zip',
      bytes: 5000,
      modifiedAt: '2026-11-18T10:00:00.000Z',
      hash: { status: 'not-needed' },
      groupId: 'dir:downloads',
      depth: 1
    }
    const scan: Scan = {
      ...base,
      inventory: { ...base.inventory, files: [...base.inventory.files, archive] }
    }

    const result = planFix(scan, { fix: 'set-aside-files', files: ['Downloads/bundle.zip'] }, at)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') return

    expect(result.plan.action).toBe('set-aside-files')
    expect(result.plan.steps).toEqual([
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'Downloads', 'bundle.zip'),
        to: join(at.holdingDir, at.entryId, 'Mods', 'Downloads', 'bundle.zip')
      }
    ])
  })

  it('refuses set-aside-files with file-changed when a file is missing from the scan', () => {
    const scan = sampleScan()
    const result = planFix(scan, { fix: 'set-aside-files', files: ['nope.zip'] }, at)
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'file-changed' }
    })
  })

  it('plans clear-caches for only existing CACHE_NAMES entries and refuses when none exist', () => {
    const scan = sampleScan()

    const planned = planFix(
      scan,
      { fix: 'clear-caches' },
      { ...at, existingCaches: ['localthumbcache.package', 'cachestr/', 'not-a-cache.package'] }
    )
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') return

    expect(planned.plan.action).toBe('clear-caches')
    expect(planned.plan.steps).toEqual([
      { kind: 'remove-cache', path: join(scan.folder.path, 'localthumbcache.package') },
      { kind: 'remove-cache', path: join(scan.folder.path, 'cachestr') }
    ])

    const empty = planFix(scan, { fix: 'clear-caches' }, { ...at, existingCaches: [] })
    expect(empty).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
  })

  it('plans disable-group using DISABLE and refuses unknown groups', () => {
    const scan = sampleScan()

    const planned = planFix(scan, { fix: 'disable-group', groupId: 'dir:hair' }, at)
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') return

    expect(planned.plan.action).toBe('disable-group')
    expect(planned.plan.groupId).toBe('dir:hair')
    expect(planned.plan.steps).toEqual([
      {
        kind: 'move',
        from: join(scan.inventory.modsDir, 'Hair', 'cozy_braids.package'),
        to: join(at.holdingDir, at.entryId, 'Mods', 'Hair', 'cozy_braids.package')
      }
    ])

    const unknown = planFix(scan, { fix: 'disable-group', groupId: 'dir:nope' }, at)
    expect(unknown).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'unknown-group' }
    })
  })

  it('refuses enable-group in planFix because enabling goes through safety.undo', () => {
    const scan = sampleScan()
    const result = planFix(scan, { fix: 'enable-group', groupId: 'dir:hair' }, at)
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
  })
})

describe('applyFix', () => {
  it('passes backup refusal and gate refusal back unchanged and forwards backup progress', async () => {
    const scan = sampleScan()
    const progressEvents: Progress[] = []

    const backupRefusedSafety = makeFakeSafety({
      async runAction(_plan, onProgress) {
        onProgress?.({ task: 'backup', stage: 'copying', done: 5, total: 10 })
        return { status: 'refused', refusal: { why: 'backup', reason: 'not-enough-space' } }
      }
    })
    const res1 = await applyFix(
      makeDeps(backupRefusedSafety),
      scan,
      { fix: 'disable-group', groupId: 'dir:hair' },
      (p) => progressEvents.push(p)
    )
    expect(res1).toEqual({
      status: 'refused',
      refusal: { why: 'backup', reason: 'not-enough-space' }
    })
    expect(progressEvents).toEqual([{ task: 'backup', stage: 'copying', done: 5, total: 10 }])

    const gateRefusedSafety = makeFakeSafety({
      async runAction() {
        return { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
      }
    })
    const res2 = await applyFix(makeDeps(gateRefusedSafety), scan, { fix: 'disable-group', groupId: 'dir:hair' })
    expect(res2).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'game-running' } }
    })
  })

  it('reads Options.ini from disk for turn-mods-on and passes the edited text to safety.runAction', async () => {
    const dir = await makeTempDir('sims-fixes-options-')
    await writeFile(
      join(dir, 'Options.ini'),
      '[options]\r\nfullscreen=1\r\nmodsdisabled=1\r\nscriptmodsenabled=0\r\n',
      'utf8'
    )
    const scan = sampleScan({
      folder: { path: dir, inOneDrive: false, newestFileAt: new Date('2026-11-24T12:00:00.000Z') }
    })
    const safety = makeFakeSafety()

    const res = await applyFix(makeDeps(safety, dir), scan, { fix: 'turn-mods-on' })
    expect(res.status).toBe('done')
    expect(safety.ranPlans).toHaveLength(1)
    expect(safety.ranPlans[0]!.steps).toEqual([
      {
        kind: 'edit',
        path: join(dir, 'Options.ini'),
        newText: '[options]\r\nfullscreen=1\r\nmodsdisabled=0\r\nscriptmodsenabled=1\r\n',
        beforeSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    ])
  })

  it('enables a disabled group by finding its done disable entry and calling safety.undo', async () => {
    const scan = sampleScan()
    const disableEntry = sampleJournalEntry({
      id: 'disable-entry-7',
      action: 'disable-group',
      summary: 'Set aside Hair',
      folderPath: scan.folder.path,
      groupId: 'dir:hair',
      status: 'done',
      undo: 'can-undo'
    })
    const safety = makeFakeSafety({
      async listJournal() {
        return [disableEntry]
      }
    })

    const res = await applyFix(makeDeps(safety), scan, { fix: 'enable-group', groupId: 'dir:hair' })
    expect(res.status).toBe('done')
    expect(safety.undoneIds).toEqual(['disable-entry-7'])
    expect(safety.ranPlans).toHaveLength(0)
  })
})

describe('setAside, putBack, clearCaches and disabledGroups', () => {
  const folderPath = '/sims/The Sims 4'
  const groups: ModGroup[] = [
    { id: 'dir:a', label: 'Mod A', source: 'folder', files: ['A/a.package'], bytes: 100, hasScript: false, curseForge: null },
    { id: 'dir:b', label: 'Mod B', source: 'folder', files: ['B/b.package'], bytes: 200, hasScript: true, curseForge: null },
    { id: 'dir:c', label: 'Mod C', source: 'folder', files: ['C/c.package'], bytes: 300, hasScript: false, curseForge: null }
  ]

  it('setAside runs one action per group in order and stops at the first non-done outcome', async () => {
    let call = 0
    const safety = makeFakeSafety({
      async runAction(plan) {
        call += 1
        if (call === 1) {
          return {
            status: 'done',
            entry: sampleJournalEntry({
              id: 'e-1',
              action: plan.action,
              summary: plan.summary,
              origin: plan.origin,
              folderPath: plan.folderPath,
              groupId: plan.groupId
            })
          }
        }
        return {
          status: 'stopped-part-way',
          entry: sampleJournalEntry({
            id: 'e-2',
            action: plan.action,
            summary: plan.summary,
            origin: plan.origin,
            folderPath: plan.folderPath,
            groupId: plan.groupId,
            status: 'needs-attention'
          }),
          detail: 'disk full'
        }
      }
    })

    const result = await setAside(
      makeDeps(safety),
      folderPath,
      groups,
      { by: 'fifty-fifty', sessionId: 'ff-1', round: 1 }
    )

    expect(result.status).toBe('stopped-part-way')
    if (result.status !== 'stopped-part-way') return
    // The half-moved Mod B was undone at once, so only the whole group before it is reported.
    expect(result.entries.map((e) => e.groupId)).toEqual(['dir:a'])
    expect(safety.undoneIds).toEqual(['e-2'])
    expect(result.detail).toBe('disk full')
    expect(call).toBe(2)
  })

  it('setAside returns refused when the first group is refused', async () => {
    const safety = makeFakeSafety({
      async runAction() {
        return { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
      }
    })

    const result = await setAside(makeDeps(safety), folderPath, groups, { by: 'fix' })
    expect(result).toEqual({
      status: 'refused',
      refusal: { why: 'gate', refusal: { reason: 'game-running' } }
    })
  })

  it('putBack undoes only the open disable entries of the requested groups', async () => {
    const entries: JournalEntry[] = [
      sampleJournalEntry({
        id: 'e-c',
        action: 'disable-group',
        summary: 'Set aside Mod C',
        folderPath,
        groupId: 'dir:c',
        status: 'done'
      }),
      sampleJournalEntry({
        id: 'e-b',
        action: 'disable-group',
        summary: 'Set aside Mod B',
        folderPath,
        groupId: 'dir:b',
        status: 'undone',
        undoneAt: '2026-11-24T12:08:00.000Z'
      }),
      sampleJournalEntry({
        id: 'e-a',
        action: 'disable-group',
        summary: 'Set aside Mod A',
        folderPath,
        groupId: 'dir:a',
        status: 'done'
      }),
      sampleJournalEntry({
        id: 'e-other',
        action: 'set-aside-files',
        summary: 'Set aside 1 zipped file from Mods',
        folderPath,
        groupId: null,
        status: 'done'
      })
    ]

    const safety = makeFakeSafety({
      async listJournal() {
        return entries
      }
    })

    const result = await putBack(makeDeps(safety), folderPath, ['dir:a', 'dir:b'])
    expect(result.status).toBe('done')
    expect(safety.undoneIds).toEqual(['e-a'])
  })

  it('disabledGroups lists only groups with a done disable-group entry for that folder', async () => {
    const safety = makeFakeSafety({
      async listJournal() {
        return [
          sampleJournalEntry({
            id: 'e-1',
            at: '2026-11-24T12:05:00.000Z',
            action: 'disable-group',
            summary: 'Set aside Wicked Wardrobe',
            folderPath,
            groupId: 'cf:901234',
            groupLabel: 'Wicked Wardrobe',
            status: 'done'
          }),
          sampleJournalEntry({
            id: 'e-2',
            at: '2026-11-24T12:04:00.000Z',
            action: 'disable-group',
            summary: 'Set aside Hair',
            folderPath,
            groupId: 'dir:hair',
            status: 'undone',
            undoneAt: '2026-11-24T12:06:00.000Z'
          }),
          sampleJournalEntry({
            id: 'e-3',
            at: '2026-11-24T12:03:00.000Z',
            action: 'disable-group',
            summary: 'Set aside Other Folder Mod',
            folderPath: '/other/folder',
            groupId: 'dir:other',
            status: 'done'
          })
        ]
      }
    })

    const list = await disabledGroups(makeDeps(safety), folderPath)
    expect(list).toEqual([
      {
        groupId: 'cf:901234',
        label: 'Wicked Wardrobe',
        entryId: 'e-1',
        at: '2026-11-24T12:05:00.000Z',
        origin: 'fix'
      }
    ])
  })

  it('clearCaches removes only existing CACHE_NAMES entries and nothing else', async () => {
    const dir = await makeTempDir('sims-fixes-caches-')
    await writeFile(join(dir, 'localthumbcache.package'), 'thumb')
    await writeFile(join(dir, 'Options.ini'), '[options]\r\n')
    await mkdir(join(dir, 'cachestr'), { recursive: true })
    await mkdir(join(dir, 'saves'), { recursive: true })

    const safety = makeFakeSafety()
    const result = await clearCaches(makeDeps(safety, dir), dir)

    expect(result.status).toBe('done')
    expect(safety.ranPlans).toHaveLength(1)
    expect(safety.ranPlans[0]!.steps).toEqual([
      { kind: 'remove-cache', path: join(dir, 'localthumbcache.package') },
      { kind: 'remove-cache', path: join(dir, 'cachestr') }
    ])
    // Double check every step is in CACHE_NAMES
    const allowed = new Set(CACHE_NAMES.map((n) => n.replace(/\/$/, '')))
    for (const step of safety.ranPlans[0]!.steps) {
      expect(step.kind).toBe('remove-cache')
      if (step.kind === 'remove-cache') {
        const baseName = step.path.slice(dir.length + 1)
        expect(allowed.has(baseName)).toBe(true)
      }
    }

    // Empty folder with no caches returns nothing-to-do
    const emptyDir = await makeTempDir('sims-fixes-nocache-')
    const emptyRes = await clearCaches(makeDeps(safety, emptyDir), emptyDir)
    expect(emptyRes).toEqual({
      status: 'refused',
      refusal: { why: 'out-of-date', detail: 'nothing-to-do' }
    })
    void SAMPLE_SHA_A
    void vi
  })
})

describe('review: Options.ini is never rewritten from a guess', () => {
  it('planFix refuses turn-mods-on when it is not given the current Options.ini text', () => {
    const scan = sampleScan()
    const result = planFix(scan, { fix: 'turn-mods-on' }, { holdingDir: '/data/holding', entryId: 'e1' })
    expect(result.status).toBe('refused')
  })

  it('applyFix refuses turn-mods-on when Options.ini is not plain UTF-8, so no byte outside the two keys changes', async () => {
    const dir = await makeTempDir('sims-fixes-latin1-')
    const bytes = Buffer.concat([
      Buffer.from('[options]\r\nmodsdisabled=1\r\nlastuser=', 'ascii'),
      Buffer.from([0xe9]), // a Latin-1 'é', not valid UTF-8
      Buffer.from('\r\n', 'ascii')
    ])
    await writeFile(join(dir, 'Options.ini'), bytes)
    const scan = sampleScan({
      folder: { path: dir, inOneDrive: false, newestFileAt: new Date('2026-11-24T12:00:00.000Z') }
    })
    const safety = makeFakeSafety()

    const res = await applyFix(makeDeps(safety, dir), scan, { fix: 'turn-mods-on' })
    expect(res.status).toBe('refused')
    expect(safety.ranPlans).toHaveLength(0)
  })

  it('applyFix keeps a UTF-8 byte order mark at the start of Options.ini', async () => {
    const dir = await makeTempDir('sims-fixes-bom-')
    await writeFile(join(dir, 'Options.ini'), '﻿[options]\r\nmodsdisabled=1\r\nscriptmodsenabled=0\r\n', 'utf8')
    const scan = sampleScan({
      folder: { path: dir, inOneDrive: false, newestFileAt: new Date('2026-11-24T12:00:00.000Z') }
    })
    const safety = makeFakeSafety()

    const res = await applyFix(makeDeps(safety, dir), scan, { fix: 'turn-mods-on' })
    expect(res.status).toBe('done')
    const step = safety.ranPlans[0]!.steps[0]!
    expect(step.kind === 'edit' && step.newText).toBe('﻿[options]\r\nmodsdisabled=0\r\nscriptmodsenabled=1\r\n')
  })
})

describe('review: one entry id for the journal entry and its holding folder', () => {
  const at = { holdingDir: join('/data', 'holding'), entryId: 'entry-77' }

  it('every plan planFix returns carries at.entryId, and its holding paths use that same id', () => {
    const scan = sampleScan()
    const groupId = scan.inventory.groups[0]!.id
    const requests: { request: Parameters<typeof planFix>[1]; extra?: object }[] = [
      { request: { fix: 'turn-mods-on' }, extra: { optionsText: '[options]\r\nmodsdisabled=1\r\n' } },
      { request: { fix: 'clear-caches' } },
      { request: { fix: 'set-aside-files', files: [scan.inventory.files[0]!.relPath] } },
      { request: { fix: 'disable-group', groupId } }
    ]
    for (const { request, extra } of requests) {
      const result = planFix(scan, request, { ...at, ...extra })
      expect(result.status).toBe('planned')
      if (result.status !== 'planned') continue
      expect(result.plan.entryId).toBe('entry-77')
      for (const step of result.plan.steps) {
        if (step.kind === 'move' && step.to.startsWith(at.holdingDir)) {
          expect(step.to.startsWith(join(at.holdingDir, 'entry-77'))).toBe(true)
        }
      }
    }
  })

  it('setAside gives each plan the id its holding folder uses', async () => {
    const safety = makeFakeSafety()
    const deps = makeDeps(safety)
    const group: ModGroup = {
      id: 'dir:a', label: 'Mod A', source: 'folder', files: ['A/a.package'], bytes: 1, hasScript: false, curseForge: null
    }
    await setAside(deps, '/sims/The Sims 4', [group], { by: 'fix' })
    const plan = safety.ranPlans[0]!
    const move = plan.steps[0]!
    expect(move.kind === 'move' && move.to.startsWith(join(deps.paths.holdingDir, plan.entryId))).toBe(true)
  })
})

describe('contract round 3: group label, script flag, edit hash, origin', () => {
  const at = { holdingDir: join('/data', 'holding'), entryId: 'entry-90' }

  it('a one-group plan carries the group label and script flag; every other plan carries null and false', () => {
    const scan = sampleScan()
    const wardrobe = planFix(scan, { fix: 'disable-group', groupId: 'cf:901234' }, at)
    expect(wardrobe.status === 'planned' && [wardrobe.plan.groupLabel, wardrobe.plan.hasScript]).toEqual([
      'Wicked Wardrobe',
      true
    ])
    const hair = planFix(scan, { fix: 'disable-group', groupId: 'dir:hair' }, at)
    expect(hair.status === 'planned' && [hair.plan.groupLabel, hair.plan.hasScript]).toEqual(['Hair', false])

    const others = [
      planFix(scan, { fix: 'turn-mods-on' }, { ...at, optionsText: '[options]\r\nmodsdisabled=1\r\n' }),
      planFix(scan, { fix: 'clear-caches' }, at),
      planFix(scan, { fix: 'set-aside-files', files: [scan.inventory.files[0]!.relPath] }, at)
    ]
    for (const result of others) {
      expect(result.status === 'planned' && [result.plan.groupLabel, result.plan.hasScript]).toEqual([null, false])
    }
  })

  it('setAside puts each group label and script flag on its plan', async () => {
    const safety = makeFakeSafety()
    const groups: ModGroup[] = [
      { id: 'dir:a', label: 'Mod A', source: 'folder', files: ['A/a.package'], bytes: 1, hasScript: false, curseForge: null },
      { id: 'dir:b', label: 'Mod B', source: 'folder', files: ['B/b.ts4script'], bytes: 1, hasScript: true, curseForge: null }
    ]
    await setAside(makeDeps(safety), '/sims/The Sims 4', groups, { by: 'fix' })
    expect(safety.ranPlans.map((p) => [p.groupLabel, p.hasScript])).toEqual([
      ['Mod A', false],
      ['Mod B', true]
    ])
  })

  it('clearCaches plans carry null and false', async () => {
    const dir = await makeTempDir('sims-fixes-caches3-')
    await writeFile(join(dir, 'localthumbcache.package'), 'thumb')
    const safety = makeFakeSafety()
    await clearCaches(makeDeps(safety, dir), dir)
    expect([safety.ranPlans[0]!.groupLabel, safety.ranPlans[0]!.hasScript]).toEqual([null, false])
  })

  it('the Options.ini edit carries the SHA-256 of the bytes applyFix read, with and without a byte order mark', async () => {
    for (const text of [
      '[options]\r\nmodsdisabled=1\r\nscriptmodsenabled=0\r\n',
      '\uFEFF[options]\r\nmodsdisabled=1\r\nscriptmodsenabled=0\r\n'
    ]) {
      const dir = await makeTempDir('sims-fixes-hash-')
      await writeFile(join(dir, 'Options.ini'), text, 'utf8')
      const bytes = await readFile(join(dir, 'Options.ini'))
      const scan = sampleScan({
        folder: { path: dir, inOneDrive: false, newestFileAt: new Date('2026-11-24T12:00:00.000Z') }
      })
      const safety = makeFakeSafety()

      await applyFix(makeDeps(safety, dir), scan, { fix: 'turn-mods-on' })
      const step = safety.ranPlans[0]!.steps[0]!
      expect(step.kind).toBe('edit')
      expect(step.kind === 'edit' && step.beforeSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(step.kind === 'edit' && step.beforeSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('disabledGroups takes the label from the entry, never from its summary, and says who set the group aside', async () => {
    const folderPath = '/sims/The Sims 4'
    const safety = makeFakeSafety({
      async listJournal() {
        return [
          sampleJournalEntry({
            id: 'e-1',
            at: '2026-11-24T12:05:00.000Z',
            action: 'disable-group',
            summary: 'Something the summary says',
            folderPath,
            groupId: 'cf:901234',
            groupLabel: 'Wicked Wardrobe',
            hasScript: true,
            status: 'done'
          }),
          sampleJournalEntry({
            id: 'e-2',
            at: '2026-11-24T12:04:00.000Z',
            action: 'disable-group',
            summary: 'Set aside Hair',
            origin: { by: 'fifty-fifty', sessionId: 'ff-1', round: 1 },
            folderPath,
            groupId: 'dir:hair',
            groupLabel: 'Hair',
            status: 'done'
          }),
          sampleJournalEntry({
            id: 'e-3',
            at: '2026-11-24T12:03:00.000Z',
            action: 'disable-group',
            summary: 'Set aside Old Entry',
            folderPath,
            groupId: 'dir:old',
            groupLabel: null,
            status: 'done'
          })
        ]
      }
    })

    expect(await disabledGroups(makeDeps(safety), folderPath)).toEqual([
      { groupId: 'cf:901234', label: 'Wicked Wardrobe', entryId: 'e-1', at: '2026-11-24T12:05:00.000Z', origin: 'fix' },
      { groupId: 'dir:hair', label: 'Hair', entryId: 'e-2', at: '2026-11-24T12:04:00.000Z', origin: 'fifty-fifty' },
      { groupId: 'dir:old', label: 'A mod', entryId: 'e-3', at: '2026-11-24T12:03:00.000Z', origin: 'fix' }
    ])
  })
})

describe('lead decision: a set-aside that stops part way is put back at once', () => {
  const folderPath = '/sims/The Sims 4'
  const groups: ModGroup[] = [
    { id: 'dir:a', label: 'Mod A', source: 'folder', files: ['A/a.package', 'A/a2.package'], bytes: 1, hasScript: false, curseForge: null },
    { id: 'dir:b', label: 'Mod B', source: 'folder', files: ['B/b.package', 'B/b2.package'], bytes: 1, hasScript: false, curseForge: null }
  ]

  /** A safety whose runAction stops part way on the given call, and whose undo answers as told. */
  function halfDoneSafety(opts: { stopOnCall: number; undo: 'done' | 'refused' | 'stopped-part-way' | 'throws' }) {
    let call = 0
    const halfEntry = (plan: ActionPlan, status: JournalEntry['status']) =>
      sampleJournalEntry({
        id: plan.entryId,
        action: plan.action,
        summary: plan.summary,
        origin: plan.origin,
        folderPath: plan.folderPath,
        groupId: plan.groupId,
        groupLabel: plan.groupLabel,
        hasScript: plan.hasScript,
        status
      })
    const plans = new Map<string, ActionPlan>()
    const base = makeFakeSafety()
    const safety = makeFakeSafety({
      async runAction(plan, onProgress) {
        call += 1
        plans.set(plan.entryId, plan)
        safety.ranPlans.push(plan)
        if (call === opts.stopOnCall) {
          return { status: 'stopped-part-way', entry: halfEntry(plan, 'needs-attention'), detail: 'disk full' }
        }
        return base.runAction(plan, onProgress)
      },
      async undo(entryId) {
        safety.undoneIds.push(entryId)
        const plan = plans.get(entryId)!
        if (opts.undo === 'throws') throw new Error('C:\\Users\\lila\\AppData journal locked')
        if (opts.undo === 'refused') {
          return { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
        }
        if (opts.undo === 'stopped-part-way') {
          return { status: 'stopped-part-way', entry: halfEntry(plan, 'needs-attention'), detail: 'a.package changed' }
        }
        return { status: 'done', entry: halfEntry(plan, 'undone') }
      }
    })
    return safety
  }

  it('setAside: the first group stops part way and the undo works, so nothing was set aside', async () => {
    const safety = halfDoneSafety({ stopOnCall: 1, undo: 'done' })
    const result = await setAside(makeDeps(safety), folderPath, groups, { by: 'fifty-fifty', sessionId: 'ff-1', round: 1 })
    expect(result).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(safety.undoneIds).toEqual([safety.ranPlans[0]!.entryId])
    expect(safety.ranPlans).toHaveLength(1)
  })

  it('setAside: a later group stops part way and the undo works, so only the whole groups before it stay set aside', async () => {
    const safety = halfDoneSafety({ stopOnCall: 2, undo: 'done' })
    const result = await setAside(makeDeps(safety), folderPath, groups, { by: 'fifty-fifty', sessionId: 'ff-1', round: 1 })
    expect(result.status).toBe('stopped-part-way')
    if (result.status !== 'stopped-part-way') return
    expect(result.entries.map((e) => [e.groupId, e.status])).toEqual([['dir:a', 'done']])
    expect(safety.undoneIds).toEqual([safety.ranPlans[1]!.entryId])
  })

  for (const undo of ['refused', 'stopped-part-way', 'throws'] as const) {
    it(`setAside: the undo of the half-moved group ${undo === 'throws' ? 'throws' : `is ${undo}`}, so its entry stays needs-attention`, async () => {
      const safety = halfDoneSafety({ stopOnCall: 1, undo })
      const result = await setAside(makeDeps(safety), folderPath, groups, { by: 'fix' })
      expect(result.status).toBe('stopped-part-way')
      if (result.status !== 'stopped-part-way') return
      expect(result.entries.map((e) => [e.groupId, e.status])).toEqual([['dir:a', 'needs-attention']])
      expect(JSON.stringify(result)).not.toContain('lila')
      expect(safety.ranPlans).toHaveLength(1)
    })

    it(`disable from Your mods: the undo of the half-moved group ${undo === 'throws' ? 'throws' : `is ${undo}`}, so it stays needs-attention`, async () => {
      const safety = halfDoneSafety({ stopOnCall: 1, undo })
      const result = await applyFix(makeDeps(safety), sampleScan(), { fix: 'disable-group', groupId: 'dir:hair' })
      expect(result.status).toBe('stopped-part-way')
      if (result.status !== 'stopped-part-way') return
      expect([result.entry.groupId, result.entry.status]).toEqual(['dir:hair', 'needs-attention'])
      expect(JSON.stringify(result)).not.toContain('lila')
    })
  }

  it("shows the undo's sentence, not the action's, when the undo of a half-moved group stops part way", async () => {
    const fromYourMods = await applyFix(makeDeps(halfDoneSafety({ stopOnCall: 1, undo: 'stopped-part-way' })), sampleScan(), {
      fix: 'disable-group',
      groupId: 'dir:hair'
    })
    expect(fromYourMods).toMatchObject({ status: 'stopped-part-way', detail: 'a.package changed' })

    const fromSetAside = await setAside(makeDeps(halfDoneSafety({ stopOnCall: 1, undo: 'stopped-part-way' })), folderPath, groups, {
      by: 'fix'
    })
    expect(fromSetAside).toMatchObject({ status: 'stopped-part-way', detail: 'a.package changed' })
  })

  it('disable from Your mods: stops part way and the undo works, so nothing was set aside', async () => {
    const safety = halfDoneSafety({ stopOnCall: 1, undo: 'done' })
    const result = await applyFix(makeDeps(safety), sampleScan(), { fix: 'disable-group', groupId: 'dir:hair' })
    expect(result).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(safety.undoneIds).toEqual([safety.ranPlans[0]!.entryId])
  })

  it('disable-group that failed at opsDone 0 with a failed journal replace returns not-started when undo drops it as nothing-to-do', async () => {
    const scan = sampleScan()
    const makeNeverRanStop = (plan: ActionPlan): FixOutcome => ({
      status: 'stopped-part-way',
      entry: sampleJournalEntry({
        id: plan.entryId,
        action: plan.action,
        summary: plan.summary,
        origin: plan.origin,
        folderPath: plan.folderPath,
        groupId: plan.groupId,
        groupLabel: plan.groupLabel,
        hasScript: plan.hasScript,
        status: 'needs-attention',
        steps: plan.steps.map((s) =>
          s.kind === 'move'
            ? { kind: 'move', from: s.from, to: s.to, bytes: 1, sha256: SAMPLE_SHA_A, state: 'pending' }
            : { kind: 'remove-cache', path: s.path, state: 'pending' }
        )
      }),
      detail: 'This change stopped part way through. You can undo what already moved from History.'
    })

    const applySafety = makeFakeSafety({
      async runAction(plan) {
        applySafety.ranPlans.push(plan)
        return makeNeverRanStop(plan)
      },
      async undo(entryId) {
        applySafety.undoneIds.push(entryId)
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }
    })
    const fromApply = await applyFix(makeDeps(applySafety), scan, { fix: 'disable-group', groupId: 'dir:hair' })
    expect(fromApply).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(applySafety.undoneIds).toEqual([applySafety.ranPlans[0]!.entryId])

    const setAsideFirstSafety = makeFakeSafety({
      async runAction(plan) {
        setAsideFirstSafety.ranPlans.push(plan)
        return makeNeverRanStop(plan)
      },
      async undo(entryId) {
        setAsideFirstSafety.undoneIds.push(entryId)
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }
    })
    const fromSetAsideFirst = await setAside(makeDeps(setAsideFirstSafety), folderPath, groups, { by: 'fix' })
    expect(fromSetAsideFirst).toEqual({ status: 'refused', refusal: { why: 'not-started' } })
    expect(setAsideFirstSafety.undoneIds).toEqual([setAsideFirstSafety.ranPlans[0]!.entryId])

    let call = 0
    const base = makeFakeSafety()
    const setAsideLaterSafety = makeFakeSafety({
      async runAction(plan, onProgress) {
        call += 1
        setAsideLaterSafety.ranPlans.push(plan)
        return call === 2 ? makeNeverRanStop(plan) : base.runAction(plan, onProgress)
      },
      async undo(entryId) {
        setAsideLaterSafety.undoneIds.push(entryId)
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }
    })
    const fromSetAsideLater = await setAside(makeDeps(setAsideLaterSafety), folderPath, groups, { by: 'fix' })
    expect(fromSetAsideLater.status).toBe('stopped-part-way')
    if (fromSetAsideLater.status === 'stopped-part-way') {
      expect(fromSetAsideLater.entries.map((e) => [e.groupId, e.status])).toEqual([['dir:a', 'done']])
    }
    expect(setAsideLaterSafety.undoneIds).toEqual([setAsideLaterSafety.ranPlans[1]!.entryId])

    // Any other refusal from undo (such as not-started when dropping the entry failed) keeps stopped-part-way.
    for (const refusal of [
      { why: 'not-started' } as const,
      { why: 'out-of-date', detail: 'file-changed' } as const
    ]) {
      const otherSafety = makeFakeSafety({
        async runAction(plan) {
          otherSafety.ranPlans.push(plan)
          return makeNeverRanStop(plan)
        },
        async undo(entryId) {
          otherSafety.undoneIds.push(entryId)
          return { status: 'refused', refusal }
        }
      })
      const kept = await applyFix(makeDeps(otherSafety), scan, { fix: 'disable-group', groupId: 'dir:hair' })
      expect(kept).toMatchObject({ status: 'stopped-part-way', entry: { groupId: 'dir:hair', status: 'needs-attention' } })
    }
  })

  it('a set-aside that moved a file keeps stopped-part-way when undo answers nothing-to-do (its entry could not be read)', async () => {
    const scan = sampleScan()
    // undo answers nothing-to-do for an entry it cannot read, too: a moved file must never be called not-started.
    const makeMovedOneStop = (plan: ActionPlan): FixOutcome => ({
      status: 'stopped-part-way',
      entry: sampleJournalEntry({
        id: plan.entryId,
        action: plan.action,
        summary: plan.summary,
        origin: plan.origin,
        folderPath: plan.folderPath,
        groupId: plan.groupId,
        groupLabel: plan.groupLabel,
        hasScript: plan.hasScript,
        status: 'needs-attention',
        steps: plan.steps.map((s, i) =>
          s.kind === 'move'
            ? { kind: 'move', from: s.from, to: s.to, bytes: 1, sha256: SAMPLE_SHA_A, state: i === 0 ? 'applied' : 'pending' }
            : { kind: 'remove-cache', path: s.path, state: 'pending' }
        )
      }),
      detail: 'This change stopped part way through. You can undo what already moved from History.'
    })
    const makeSafety = () => {
      const safety = makeFakeSafety({
        async runAction(plan) {
          safety.ranPlans.push(plan)
          return makeMovedOneStop(plan)
        },
        async undo(entryId) {
          safety.undoneIds.push(entryId)
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
        }
      })
      return safety
    }

    const applySafety = makeSafety()
    const fromApply = await applyFix(makeDeps(applySafety), scan, { fix: 'disable-group', groupId: 'dir:hair' })
    expect(fromApply).toMatchObject({ status: 'stopped-part-way', entry: { groupId: 'dir:hair', status: 'needs-attention' } })
    expect(applySafety.undoneIds).toEqual([applySafety.ranPlans[0]!.entryId])

    const setAsideSafety = makeSafety()
    const fromSetAside = await setAside(makeDeps(setAsideSafety), folderPath, groups, { by: 'fix' })
    expect(fromSetAside.status).toBe('stopped-part-way')
    expect(setAsideSafety.undoneIds).toEqual([setAsideSafety.ranPlans[0]!.entryId])
  })

  it('a half-moved group is in neither list: disabledGroups leaves it out and putBack does not touch it', async () => {
    const stuck = sampleJournalEntry({
      id: 'e-stuck',
      action: 'disable-group',
      summary: 'Set aside Mod A',
      folderPath,
      groupId: 'dir:a',
      groupLabel: 'Mod A',
      status: 'needs-attention'
    })
    const safety = makeFakeSafety({
      async listJournal() {
        return [stuck]
      }
    })
    expect(await disabledGroups(makeDeps(safety), folderPath)).toEqual([])
    expect(await putBack(makeDeps(safety), folderPath, ['dir:a'])).toEqual({ status: 'done', entries: [] })
    expect(safety.undoneIds).toEqual([])
  })
})

describe('a part-way stop after a refusal says why in plain words', () => {
  const folderPath = '/sims/The Sims 4'
  const groups: ModGroup[] = [
    { id: 'dir:a', label: 'Mod A', source: 'folder', files: ['A/a.package'], bytes: 100, hasScript: false, curseForge: null },
    { id: 'dir:b', label: 'Mod B', source: 'folder', files: ['B/b.package'], bytes: 200, hasScript: false, curseForge: null }
  ]
  const secretPath = 'C:\\Users\\her\\Documents\\Electronic Arts\\The Sims 4\\Saves\\Slot_00000001.save'
  const EVERY_REFUSAL: FixRefusal[] = [
    { why: 'gate', refusal: { reason: 'saves-or-tray', path: secretPath } },
    { why: 'gate', refusal: { reason: 'outside-allowed-area', path: secretPath } },
    { why: 'gate', refusal: { reason: 'link-escape', path: secretPath } },
    { why: 'gate', refusal: { reason: 'not-a-sims-folder', path: secretPath } },
    { why: 'gate', refusal: { reason: 'game-running' } },
    { why: 'gate', refusal: { reason: 'game-state-unknown' } },
    { why: 'gate', refusal: { reason: 'no-verified-backup', backup: 'none' } },
    { why: 'gate', refusal: { reason: 'no-verified-backup', backup: 'stale' } },
    { why: 'gate', refusal: { reason: 'no-verified-backup', backup: 'unknown' } },
    { why: 'gate', refusal: { reason: 'check-failed', path: secretPath } },
    ...(
      [
        'game-running',
        'game-state-unknown',
        'backup-folder-in-onedrive',
        'not-enough-space',
        'sims-folder-missing',
        'backup-already-running',
        'backup-folder-in-sims-folder',
        'backup-failed'
      ] as const
    ).map((reason): FixRefusal => ({ why: 'backup', reason })),
    ...(['no-scan', 'unknown-finding', 'unknown-group', 'file-changed', 'nothing-to-do'] as const).map(
      (detail): FixRefusal => ({ why: 'out-of-date', detail })
    ),
    { why: 'fifty-fifty-running' },
    { why: 'not-started' }
  ]
  const CODE_WORDS = [
    'saves-or-tray', 'outside-allowed-area', 'link-escape', 'not-a-sims-folder', 'game-running', 'game-state-unknown',
    'no-verified-backup', 'check-failed', 'backup-folder-in-onedrive', 'not-enough-space', 'sims-folder-missing',
    'backup-already-running', 'backup-folder-in-sims-folder', 'backup-failed', 'no-scan', 'unknown-finding',
    'unknown-group', 'file-changed', 'nothing-to-do', 'fifty-fifty', 'not-started', 'gate'
  ]

  function expectPlain(detail: string, refusal: FixRefusal): void {
    const where = JSON.stringify(refusal)
    expect(detail.length, where).toBeGreaterThan(0)
    for (const word of CODE_WORDS) expect(detail.toLowerCase(), where).not.toContain(word)
    expect(detail.replaceAll('50/50', ''), where).not.toMatch(/[()\\/:]/)
    expect(detail, where).not.toContain('Slot_')
    expect(detail, where).toMatch(/^[A-Z].*\.$/)
  }

  for (const refusal of EVERY_REFUSAL) {
    it(`setAside: ${JSON.stringify(refusal)} on a later group`, async () => {
      let call = 0
      const base = makeFakeSafety()
      const safety = makeFakeSafety({
        async runAction(plan, onProgress) {
          call += 1
          if (call === 1) return base.runAction(plan, onProgress)
          return { status: 'refused', refusal }
        }
      })
      const result = await setAside(makeDeps(safety), folderPath, groups, { by: 'fix' })
      expect(result.status).toBe('stopped-part-way')
      if (result.status !== 'stopped-part-way') return
      expectPlain(result.detail, refusal)
      expect(result.detail).toContain('set aside')
    })

    it(`putBack: ${JSON.stringify(refusal)} on a later group`, async () => {
      const entries = groups.map((g) =>
        sampleJournalEntry({ id: `e-${g.id}`, action: 'disable-group', folderPath, groupId: g.id, status: 'done' })
      )
      let call = 0
      const safety = makeFakeSafety({
        async listJournal() {
          return entries
        },
        async undo(entryId) {
          call += 1
          if (call === 1) {
            return { status: 'done', entry: sampleJournalEntry({ id: entryId, status: 'undone' }) }
          }
          return { status: 'refused', refusal }
        }
      })
      const result = await putBack(makeDeps(safety), folderPath, groups.map((g) => g.id))
      expect(result.status).toBe('stopped-part-way')
      if (result.status !== 'stopped-part-way') return
      expectPlain(result.detail, refusal)
      expect(result.detail).toContain('put back')
    })
  }
})
