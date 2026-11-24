// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FixOutcome,
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
        newText: '[options]\r\nfullscreen=1\r\nmodsdisabled=0\r\nscriptmodsenabled=1\r\n'
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
    expect(result.entries.map((e) => e.groupId)).toEqual(['dir:a', 'dir:b'])
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
        at: '2026-11-24T12:05:00.000Z'
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
