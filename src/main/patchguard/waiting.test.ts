// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { JournalEntry } from '../../shared/model.ts'
import { SAMPLE_SHA_A } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import { createContext } from '../services.ts'
import { clearHoldingEntry, listWaitingOnMods } from './waiting.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const P16_SPEC = join(THIS_DIR, '../../../scripts/fixtures/specs/p16-patch-guard.json')

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop()!, { recursive: true, force: true })
  }
})

async function makeWaitingHarness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-p16-waiting-')))
  temps.push(root)

  const fixtureDir = join(root, 'p16-patch-guard')
  const spec = await loadSpec(P16_SPEC)
  await generateFixture(spec, fixtureDir)

  const userRoot = join(fixtureDir, 'Users', 'Player')
  const documentsDir = join(userRoot, 'Documents')
  const simsFolder = join(documentsDir, 'Electronic Arts', 'The Sims 4')
  const modsDir = join(simsFolder, 'Mods')
  const localAppData = join(userRoot, 'AppData', 'Local')
  const appData = join(userRoot, 'AppData', 'Roaming')
  const desktopDir = join(userRoot, 'Desktop')
  const programFiles = join(fixtureDir, 'Program Files')
  const installDir = join(programFiles, 'EA Games', 'The Sims 4')

  await mkdir(localAppData, { recursive: true })
  await mkdir(desktopDir, { recursive: true })

  const paths = appPaths({ localAppData, appData, desktopDir, env: {} })
  await mkdir(paths.stateDir, { recursive: true })
  await mkdir(paths.journalDir, { recursive: true })
  await writeFile(join(paths.stateDir, 'settings.json'), JSON.stringify({ welcome: 'seen', folderPath: simsFolder }))

  const host: Host = {
    documentsDir,
    env: { USERNAME: 'Player', ProgramFiles: programFiles },
    async readRegistry() {
      return installDir
    },
    async listProcesses() {
      return []
    },
    async fileVersion() {
      return '1.130.12.1020'
    }
  }

  const ctx = createContext({
    host,
    paths,
    clock: { now: () => new Date('2026-11-27T10:00:00.000Z') },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    },
    emit: () => {},
    reveal: () => {}
  })

  async function addSetAsideEntry(input: {
    id: string
    at: string
    groupId: string
    label: string
    relPath: string
    /** Extra mod files moved by the same entry (a multi-file mod group). */
    moreRelPaths?: string[]
    origin?: JournalEntry['origin']
    status?: JournalEntry['status']
  }) {
    const relPaths = [input.relPath, ...(input.moreRelPaths ?? [])]
    const heldFiles = relPaths.map((rel) => join(paths.holdingDir, input.id, 'Mods', ...rel.split('/')))
    for (const held of heldFiles) {
      await mkdir(dirname(held), { recursive: true })
      await writeFile(held, 'old-mod-bytes')
    }
    const heldFile = heldFiles[0]!
    const entry: JournalEntry = {
      id: input.id,
      at: input.at,
      action: 'disable-group',
      summary: `Set aside ${input.label}`,
      origin: input.origin ?? { by: 'fix' },
      folderPath: simsFolder,
      groupId: input.groupId,
      groupLabel: input.label,
      hasScript: true,
      backupId: '20261122-120000-b001',
      steps: relPaths.map((rel, i) => ({
        kind: 'move' as const,
        from: join(modsDir, ...rel.split('/')),
        to: heldFiles[i]!,
        bytes: 13,
        sha256: SAMPLE_SHA_A,
        state: 'applied' as const
      })),
      status: input.status ?? 'done',
      undo: 'can-undo',
      undoneAt: null
    }
    await writeFile(join(paths.journalDir, `${input.id}.json`), JSON.stringify(entry), 'utf8')
    return { entry, heldFile, heldFiles }
  }

  async function addModuleToAddon(addonId: number, name: string) {
    const cfFile = paths.curseForgeInstanceFile!
    const raw = JSON.parse(await readFile(cfFile, 'utf8')) as Array<{
      installedAddons: Array<{ addonID: number; installedFile: { modules: Array<{ name: string; fingerprint: number }> } }>
    }>
    const addon = raw[0]!.installedAddons.find((a) => a.addonID === addonId)!
    addon.installedFile.modules.push({ name, fingerprint: 700000 + addon.installedFile.modules.length })
    await writeFile(cfFile, JSON.stringify(raw, null, 2), 'utf8')
  }

  async function putInMods(relPath: string, when: string) {
    const file = join(modsDir, ...relPath.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'new-mod-bytes')
    const date = new Date(when)
    await utimes(file, date, date)
    return file
  }

  return { ctx, paths, simsFolder, modsDir, addSetAsideEntry, addModuleToAddon, putInMods }
}

describe('patchguard waiting and clear-holding', () => {
  it('classifies four set-aside groups into waiting, updated, back-in-mods, and not-curseforge from fixture AddonGameInstance.json', async () => {
    const { ctx, addSetAsideEntry } = await makeWaitingHarness()

    // Fixture TS4_x64.exe mtime is 2026-11-20T18:00:00.000Z.
    // All four entries below are newer (2026-11-22T12:00:00.000Z):
    await addSetAsideEntry({
      id: '20261122-120001-w001',
      at: '2026-11-22T12:00:01.000Z',
      groupId: 'cf:160101',
      label: 'Waiting Script Mod',
      relPath: 'WaitingMod/waiting_mod.ts4script'
    })
    await addSetAsideEntry({
      id: '20261122-120002-u002',
      at: '2026-11-22T12:00:02.000Z',
      groupId: 'cf:160102',
      label: 'Updated Script Mod',
      relPath: 'UpdatedMod/updated_mod.ts4script'
    })
    await addSetAsideEntry({
      id: '20261122-120003-b003',
      at: '2026-11-22T12:00:03.000Z',
      groupId: 'cf:160103',
      label: 'Back In Mods Script',
      relPath: 'BackInMods/back_in_mods.ts4script'
    })
    await addSetAsideEntry({
      id: '20261122-120004-m004',
      at: '2026-11-22T12:00:04.000Z',
      groupId: 'dir:manualscript',
      label: 'Manual Script Mod',
      relPath: 'ManualScript/manual.ts4script'
    })

    // Excluded entries: older than game update, fifty-fifty origin, and already undone
    await addSetAsideEntry({
      id: '20261110-100000-old1',
      at: '2026-11-10T10:00:00.000Z',
      groupId: 'cf:160199',
      label: 'Old Set Aside',
      relPath: 'OldMod/old.ts4script'
    })
    await addSetAsideEntry({
      id: '20261122-120005-ff01',
      at: '2026-11-22T12:00:05.000Z',
      groupId: 'dir:fiftymod',
      label: 'Fifty Mod',
      relPath: 'FiftyMod/fifty.ts4script',
      origin: { by: 'fifty-fifty', sessionId: 's1', round: 1 }
    })
    await addSetAsideEntry({
      id: '20261122-120006-un01',
      at: '2026-11-22T12:00:06.000Z',
      groupId: 'dir:undonemod',
      label: 'Undone Mod',
      relPath: 'UndoneMod/undone.ts4script',
      status: 'undone'
    })

    const waiting = await listWaitingOnMods(ctx)
    expect(waiting).toEqual([
      {
        groupId: 'cf:160103',
        label: 'Back In Mods Script',
        entryId: '20261122-120003-b003',
        setAsideAt: '2026-11-22T12:00:03.000Z',
        state: 'back-in-mods',
        updatedAt: '2026-11-26T14:00:00.000Z'
      },
      {
        groupId: 'dir:manualscript',
        label: 'Manual Script Mod',
        entryId: '20261122-120004-m004',
        setAsideAt: '2026-11-22T12:00:04.000Z',
        state: 'not-curseforge',
        updatedAt: null
      },
      {
        groupId: 'cf:160102',
        label: 'Updated Script Mod',
        entryId: '20261122-120002-u002',
        setAsideAt: '2026-11-22T12:00:02.000Z',
        state: 'updated',
        updatedAt: '2026-11-25T15:00:00.000Z'
      },
      {
        groupId: 'cf:160101',
        label: 'Waiting Script Mod',
        entryId: '20261122-120001-w001',
        setAsideAt: '2026-11-22T12:00:01.000Z',
        state: 'waiting',
        updatedAt: null
      }
    ])
  })

  it('clear-holding refuses missing entries and non-back-in-mods entries without deleting holding files', async () => {
    const { ctx, addSetAsideEntry } = await makeWaitingHarness()

    const waiting = await addSetAsideEntry({
      id: '20261122-120001-w001',
      at: '2026-11-22T12:00:01.000Z',
      groupId: 'cf:160101',
      label: 'Waiting Script Mod',
      relPath: 'WaitingMod/waiting_mod.ts4script'
    })
    const updated = await addSetAsideEntry({
      id: '20261122-120002-u002',
      at: '2026-11-22T12:00:02.000Z',
      groupId: 'cf:160102',
      label: 'Updated Script Mod',
      relPath: 'UpdatedMod/updated_mod.ts4script'
    })
    const manual = await addSetAsideEntry({
      id: '20261122-120004-m004',
      at: '2026-11-22T12:00:04.000Z',
      groupId: 'dir:manualscript',
      label: 'Manual Script Mod',
      relPath: 'ManualScript/manual.ts4script'
    })

    expect(await clearHoldingEntry(ctx, 'does-not-exist')).toEqual({ kind: 'refused', why: 'not-found' })
    expect(await clearHoldingEntry(ctx, '../escape')).toEqual({ kind: 'refused', why: 'not-found' })
    expect(await clearHoldingEntry(ctx, waiting.entry.id)).toEqual({ kind: 'refused', why: 'not-back-in-mods' })
    expect(await clearHoldingEntry(ctx, updated.entry.id)).toEqual({ kind: 'refused', why: 'not-back-in-mods' })
    expect(await clearHoldingEntry(ctx, manual.entry.id)).toEqual({ kind: 'refused', why: 'not-back-in-mods' })

    // Holding files are still intact
    expect((await stat(waiting.heldFile)).isFile()).toBe(true)
    expect((await stat(updated.heldFile)).isFile()).toBe(true)
    expect((await stat(manual.heldFile)).isFile()).toBe(true)
  })

  it('clear-holding removes holding folder for a back-in-mods entry, leaves Mods untouched, and removes it from Waiting on', async () => {
    const { ctx, paths, modsDir, addSetAsideEntry } = await makeWaitingHarness()

    const backInMods = await addSetAsideEntry({
      id: '20261122-120003-b003',
      at: '2026-11-22T12:00:03.000Z',
      groupId: 'cf:160103',
      label: 'Back In Mods Script',
      relPath: 'BackInMods/back_in_mods.ts4script'
    })

    const modsFile = join(modsDir, 'BackInMods', 'back_in_mods.ts4script')
    const modsBefore = await readFile(modsFile)

    const result = await clearHoldingEntry(ctx, backInMods.entry.id)
    expect(result).toEqual({ kind: 'done' })

    // Holding folder is gone
    await expect(stat(join(paths.holdingDir, backInMods.entry.id))).rejects.toThrow()
    // New copy in Mods/ is completely untouched
    expect(await readFile(modsFile)).toEqual(modsBefore)
    // Entry no longer appears in Waiting on or disabled groups
    expect(await listWaitingOnMods(ctx)).toEqual([])
    expect(await ctx.fixes.disabledGroups(backInMods.entry.folderPath)).toEqual([])
    // Journal entry is settled as undone / cannot-undo so Undo can never put the old copy back
    const journalEntry = JSON.parse(
      await readFile(join(paths.journalDir, `${backInMods.entry.id}.json`), 'utf8')
    ) as JournalEntry
    expect(journalEntry.status).toBe('undone')
    expect(journalEntry.undo).toBe('cannot-undo')
  })

  it('ignores non-mod files like readme.txt in CurseForge modules so unrelated docs never trigger back-in-mods', async () => {
    const { ctx, paths, modsDir, addSetAsideEntry } = await makeWaitingHarness()

    // Overwrite AddonGameInstance.json so addon 160101 includes a readme.txt module
    const cfFile = paths.curseForgeInstanceFile!
    const raw = JSON.parse(await readFile(cfFile, 'utf8')) as Array<{
      gameID: number
      installedAddons: Array<{ addonID: number; installedFile: { modules: Array<{ name: string; fingerprint: number }> } }>
    }>
    const addon = raw[0]!.installedAddons.find((a) => a.addonID === 160101)!
    addon.installedFile.modules.push({ name: 'readme.txt', fingerprint: 999999 })
    await writeFile(cfFile, JSON.stringify(raw, null, 2), 'utf8')

    // Put an unrelated newer readme.txt in Mods/Other/
    const otherReadme = join(modsDir, 'Other', 'readme.txt')
    await mkdir(dirname(otherReadme), { recursive: true })
    await writeFile(otherReadme, 'some other mod readme')
    const newerDate = new Date('2026-11-26T15:00:00.000Z')
    await utimes(otherReadme, newerDate, newerDate)

    const waitingEntry = await addSetAsideEntry({
      id: '20261122-120001-wdoc',
      at: '2026-11-22T12:00:01.000Z',
      groupId: 'cf:160101',
      label: 'Waiting Script Mod',
      relPath: 'WaitingMod/waiting_mod.ts4script'
    })

    const list = await listWaitingOnMods(ctx)
    expect(list).toEqual([
      {
        groupId: 'cf:160101',
        label: 'Waiting Script Mod',
        entryId: waitingEntry.entry.id,
        setAsideAt: '2026-11-22T12:00:01.000Z',
        state: 'waiting',
        updatedAt: null
      }
    ])

    expect(await clearHoldingEntry(ctx, waitingEntry.entry.id)).toEqual({
      kind: 'refused',
      why: 'not-back-in-mods'
    })
    expect((await stat(waitingEntry.heldFile)).isFile()).toBe(true)
  })

  it('ignores an unrelated .package in another folder whose mtime is older than setAsideAt', async () => {
    const { ctx, paths, modsDir, addSetAsideEntry } = await makeWaitingHarness()

    const cfFile = paths.curseForgeInstanceFile!
    const raw = JSON.parse(await readFile(cfFile, 'utf8')) as Array<{
      gameID: number
      installedAddons: Array<{ addonID: number; installedFile: { modules: Array<{ name: string; fingerprint: number }> } }>
    }>
    const addon = raw[0]!.installedAddons.find((a) => a.addonID === 160101)!
    addon.installedFile.modules.push({ name: 'shared_tuning.package', fingerprint: 888888 })
    await writeFile(cfFile, JSON.stringify(raw, null, 2), 'utf8')

    // Put an older shared_tuning.package in another folder (older than setAsideAt 2026-11-22T12:00:01Z)
    const olderPkg = join(modsDir, 'Other', 'shared_tuning.package')
    await mkdir(dirname(olderPkg), { recursive: true })
    await writeFile(olderPkg, 'old-package')
    const olderDate = new Date('2026-11-10T10:00:00.000Z')
    await utimes(olderPkg, olderDate, olderDate)

    const waitingEntry = await addSetAsideEntry({
      id: '20261122-120001-wold',
      at: '2026-11-22T12:00:01.000Z',
      groupId: 'cf:160101',
      label: 'Waiting Script Mod',
      relPath: 'WaitingMod/waiting_mod.ts4script'
    })

    const list = await listWaitingOnMods(ctx)
    expect(list).toEqual([
      {
        groupId: 'cf:160101',
        label: 'Waiting Script Mod',
        entryId: waitingEntry.entry.id,
        setAsideAt: '2026-11-22T12:00:01.000Z',
        state: 'waiting',
        updatedAt: null
      }
    ])
    expect(await clearHoldingEntry(ctx, waitingEntry.entry.id)).toEqual({
      kind: 'refused',
      why: 'not-back-in-mods'
    })
  })

  it('a multi-file mod is back in Mods only when every set-aside file is back, never after a partial reinstall', async () => {
    const { ctx, addSetAsideEntry, putInMods } = await makeWaitingHarness()

    const multi = await addSetAsideEntry({
      id: '20261122-120001-mf01',
      at: '2026-11-22T12:00:01.000Z',
      groupId: 'cf:160101',
      label: 'Multi File Mod',
      relPath: 'MultiMod/multi_a.package',
      moreRelPaths: ['MultiMod/multi_b.package']
    })

    // Only one of the two files came back at its old place.
    await putInMods('MultiMod/multi_a.package', '2026-11-26T15:00:00.000Z')
    const partial = await listWaitingOnMods(ctx)
    expect(partial).toHaveLength(1)
    expect(partial[0]!.state).not.toBe('back-in-mods')
    expect(['waiting', 'updated']).toContain(partial[0]!.state)
    expect(await clearHoldingEntry(ctx, multi.entry.id)).toEqual({ kind: 'refused', why: 'not-back-in-mods' })
    for (const held of multi.heldFiles) expect((await stat(held)).isFile()).toBe(true)

    // Both files are back: now it is back in Mods.
    await putInMods('MultiMod/multi_b.package', '2026-11-26T15:00:00.000Z')
    const both = await listWaitingOnMods(ctx)
    expect(both[0]!.state).toBe('back-in-mods')
  })

  it('a multi-file CurseForge mod with a newer version is not back in Mods when only one file name came back', async () => {
    const { ctx, addSetAsideEntry, putInMods } = await makeWaitingHarness()

    // Addon 160102 has a newer CurseForge file (2026-11-25) than the set-aside time.
    const multi = await addSetAsideEntry({
      id: '20261122-120002-mf02',
      at: '2026-11-22T12:00:02.000Z',
      groupId: 'cf:160102',
      label: 'Updated Multi Mod',
      relPath: 'UpdatedMod/updated_mod.ts4script',
      moreRelPaths: ['UpdatedMod/updated_tuning.package']
    })
    await putInMods('Reinstalled/updated_mod.ts4script', '2026-11-26T15:00:00.000Z')

    const list = await listWaitingOnMods(ctx)
    expect(list[0]).toMatchObject({ entryId: multi.entry.id, state: 'updated' })
    expect(await clearHoldingEntry(ctx, multi.entry.id)).toEqual({ kind: 'refused', why: 'not-back-in-mods' })
  })

  it('an unrelated mod with the same file name never makes a set-aside CurseForge mod back in Mods', async () => {
    const { ctx, addSetAsideEntry, addModuleToAddon, putInMods } = await makeWaitingHarness()

    // Addon 160101's CurseForge file (2026-11-15) has NOT advanced past the set-aside time.
    await addModuleToAddon(160101, 'helper.package')
    const entry = await addSetAsideEntry({
      id: '20261122-120001-hc01',
      at: '2026-11-22T12:00:01.000Z',
      groupId: 'cf:160101',
      label: 'Waiting Script Mod',
      relPath: 'WaitingMod/helper.package'
    })
    // An Ask Tyler delivery drops a newer file with the same name in its own folder.
    await putInMods('From Tyler - Other/helper.package', '2026-11-26T15:00:00.000Z')

    const list = await listWaitingOnMods(ctx)
    expect(list).toEqual([
      {
        groupId: 'cf:160101',
        label: 'Waiting Script Mod',
        entryId: entry.entry.id,
        setAsideAt: '2026-11-22T12:00:01.000Z',
        state: 'waiting',
        updatedAt: null
      }
    ])
    expect(await clearHoldingEntry(ctx, entry.entry.id)).toEqual({ kind: 'refused', why: 'not-back-in-mods' })
    expect((await stat(entry.heldFile)).isFile()).toBe(true)
  })

  it('clear-holding settles the journal entry BEFORE removing the holding folder', async () => {
    const { ctx, paths, addSetAsideEntry } = await makeWaitingHarness()

    const backInMods = await addSetAsideEntry({
      id: '20261122-120003-ord1',
      at: '2026-11-22T12:00:03.000Z',
      groupId: 'cf:160103',
      label: 'Back In Mods Script',
      relPath: 'BackInMods/back_in_mods.ts4script'
    })

    const observedOps: string[] = []
    const origRun = ctx.gate.run
    const wrappedCtx = {
      ...ctx,
      gate: {
        async run(req: Parameters<typeof origRun>[0]) {
          for (const op of req.ops) {
            observedOps.push(`${op.op}:${'path' in op ? op.path : ''}`)
          }
          return origRun(req)
        }
      }
    }

    const result = await clearHoldingEntry(wrappedCtx, backInMods.entry.id)
    expect(result).toEqual({ kind: 'done' })
    expect(observedOps).toEqual([
      `write:${join(paths.journalDir, `${backInMods.entry.id}.json`)}`,
      `remove:${join(paths.holdingDir, backInMods.entry.id)}`
    ])
  })
})
