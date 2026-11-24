// @vitest-environment node
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { writeDbpf } from '../../../scripts/fixtures/dbpf.ts'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import type { Inventory, Progress } from '../../shared/model.ts'
import { createFixtureHost } from '../locate/fixture-host.ts'
import { locate } from '../locate/index.ts'
import { buildInventory, readCurseForge, readResourceCfg } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(THIS_DIR, '../../..')
const SPECS_DIR = join(REPO_ROOT, 'scripts/fixtures/specs')
const FIXTURES_DIR = join(REPO_ROOT, 'test/fixtures')

function fixtureCurseForgePath(fixtureRoot: string): string {
  return join(
    fixtureRoot,
    'Users',
    'Player',
    'AppData',
    'Roaming',
    'CurseForge',
    'agent',
    'GameInstances',
    'AddonGameInstance.json'
  )
}

async function scanFixture(name: string): Promise<Inventory> {
  const root = join(FIXTURES_DIR, name)
  const located = await locate(createFixtureHost(root))
  expect(located.userFolders.length, `${name} userFolders`).toBeGreaterThan(0)
  const modsDir = join(located.userFolders[0]!.path, 'Mods')
  return await buildInventory({
    modsDir,
    curseForgeInstanceFile: fixtureCurseForgePath(root)
  })
}

function assertGroupingInvariants(inv: Inventory): void {
  const byGroupId = new Map(inv.groups.map((g) => [g.id, g]))
  expect(byGroupId.size).toBe(inv.groups.length)

  const seenFiles = new Set<string>()
  for (const group of inv.groups) {
    expect(group.id).toBe(group.id.toLowerCase())
    expect(group.files.length).toBeGreaterThan(0)
    let sumBytes = 0
    let hasScript = false
    for (const relPath of group.files) {
      expect(seenFiles.has(relPath), `duplicate membership for ${relPath}`).toBe(false)
      seenFiles.add(relPath)
      const file = inv.files.find((f) => f.relPath === relPath)
      expect(file, `missing file ${relPath}`).toBeDefined()
      expect(file!.groupId).toBe(group.id)
      sumBytes += file!.bytes
      if (file!.kind === 'script') hasScript = true
    }
    expect(group.bytes).toBe(sumBytes)
    expect(group.hasScript).toBe(hasScript)
  }

  expect(seenFiles.size).toBe(inv.files.length)
  for (const file of inv.files) {
    expect(byGroupId.has(file.groupId), `missing group ${file.groupId}`).toBe(true)
    expect(file.relPath.toLowerCase()).not.toBe('resource.cfg')
  }

  // Files must be sorted by relPath.
  const sorted = [...inv.files.map((f) => f.relPath)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  expect(inv.files.map((f) => f.relPath)).toEqual(sorted)
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  async function walk(dir: string, rel: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        snapshot.set(relPath, `link ${await readlink(full)}`)
      } else if (info.isDirectory()) {
        snapshot.set(relPath, `dir ${info.mtimeMs}`)
        await walk(full, relPath)
      } else {
        const hash = createHash('sha256')
          .update(await readFile(full))
          .digest('hex')
        snapshot.set(relPath, `file ${info.size} ${info.mtimeMs} ${hash}`)
      }
    }
  }
  await walk(root, '')
  return snapshot
}

describe('buildInventory on fixtures', () => {
  it('clean: reads packages, scripts, Resource.cfg, and assigns folder/loose groups', async () => {
    const inv = await scanFixture('clean')
    assertGroupingInvariants(inv)

    expect(inv.modsDirState).toBe('present')
    expect(inv.skipped).toEqual([])
    expect(inv.resourceCfg).toEqual({ status: 'ok', maxPackageDepth: 5 })
    expect(inv.curseForge).toEqual({ status: 'not-found' })
    expect(inv.files.map((f) => f.relPath)).toEqual([
      'BuildBuy/Kitchen/pastel_kettle.package',
      'CAS/Hair/sample_waves.package',
      'MCCC/mc_cmd_center.ts4script',
      'cozy_rug.package'
    ])

    const rug = inv.files.find((f) => f.relPath === 'cozy_rug.package')!
    expect(rug.depth).toBe(0)
    expect(rug.kind).toBe('package')
    if (rug.kind === 'package') expect(rug.dbpf).toEqual({ status: 'ok', keyCount: 2 })
    expect(rug.hash).toEqual({ status: 'not-needed' })
    expect(rug.groupId).toBe('file:cozy_rug.package')

    const rugGroup = inv.groups.find((g) => g.id === 'file:cozy_rug.package')!
    expect(rugGroup.label).toBe('cozy_rug')
    expect(rugGroup.source).toBe('loose')

    const mccc = inv.files.find((f) => f.relPath === 'MCCC/mc_cmd_center.ts4script')!
    expect(mccc.depth).toBe(1)
    expect(mccc.kind).toBe('script')
    if (mccc.kind === 'script') {
      expect(mccc.script).toEqual({
        status: 'ok',
        entries: ['mc_cmd_center/__init__.pyc', 'mc_cmd_center/mc_utils.pyc']
      })
    }
    expect(mccc.groupId).toBe('dir:mccc')
    const mcccGroup = inv.groups.find((g) => g.id === 'dir:mccc')!
    expect(mcccGroup.label).toBe('MCCC')
    expect(mcccGroup.source).toBe('folder')
    expect(mcccGroup.hasScript).toBe(true)
  })

  it('nested-scripts: handles French folder name, 3-level Resource.cfg, and file depths', async () => {
    const inv = await scanFixture('nested-scripts')
    assertGroupingInvariants(inv)

    expect(inv.modsDir).toContain('Les\u00A0Sims\u00A04')
    expect(inv.resourceCfg).toEqual({ status: 'ok', maxPackageDepth: 3 })

    const depthByPath = Object.fromEntries(inv.files.map((f) => [f.relPath, f.depth]))
    expect(depthByPath).toEqual({
      'CAS/Outfits/Formal/Winter/Coats/Wool/too_deep_for_default.package': 6,
      'CAS/Outfits/Formal/Winter/too_deep_for_cfg.package': 4,
      'CAS/good_dress.package': 1,
      'Gameplay/Tweaks/DeepMod/deep_mod.ts4script': 3,
      'ScriptMods/CoolMod/cool_mod.ts4script': 2,
      'ValidMod/valid_helper.ts4script': 1
    })
  })

  it('duplicates: hashes same-size files and skips unique-size files', async () => {
    const inv = await scanFixture('duplicates')
    assertGroupingInvariants(inv)

    const hairA = inv.files.find((f) => f.relPath === 'CAS/Hair/sample_hair_01.package')!
    const hairB = inv.files.find((f) => f.relPath === 'CurseForge/sample_hair_01.package')!
    expect(hairA.hash.status).toBe('hashed')
    expect(hairB.hash.status).toBe('hashed')
    if (hairA.hash.status === 'hashed' && hairB.hash.status === 'hashed') {
      expect(hairA.hash.sha256).toBe(hairB.hash.sha256)
      expect(hairA.hash.sha256).toMatch(/^[0-9a-f]{64}$/)
    }

    const scriptA = inv.files.find((f) => f.relPath === 'HelperMod/helper_mod.ts4script')!
    const scriptB = inv.files.find((f) => f.relPath === 'BackupCopy/helper_mod.ts4script')!
    expect(scriptA.hash.status).toBe('hashed')
    expect(scriptB.hash.status).toBe('hashed')
    if (scriptA.hash.status === 'hashed' && scriptB.hash.status === 'hashed') {
      expect(scriptA.hash.sha256).toBe(scriptB.hash.sha256)
    }

    // lamp_a and lamp_b share byte size (1 key each) so both are hashed, with distinct hashes.
    const lampA = inv.files.find((f) => f.relPath === 'BuildBuy/lamp_a.package')!
    const lampB = inv.files.find((f) => f.relPath === 'BuildBuy/lamp_b.package')!
    expect(lampA.hash.status).toBe('hashed')
    expect(lampB.hash.status).toBe('hashed')
    if (lampA.hash.status === 'hashed' && lampB.hash.status === 'hashed') {
      expect(lampA.hash.sha256).not.toBe(lampB.hash.sha256)
    }

    // Verify a unique-size file added in a temp copy gets not-needed.
    const dir = await mkdtemp(join(tmpdir(), 'sims-dup-unique-'))
    try {
      const mods = join(dir, 'Mods')
      await mkdir(mods, { recursive: true })
      const dupBuf = writeDbpf({ keys: [{ type: 1, group: 0, instance: 1n }] })
      await writeFile(join(mods, 'a.package'), dupBuf)
      await writeFile(join(mods, 'b.package'), dupBuf)
      await writeFile(join(mods, 'unique.txt'), 'unique length content here!')

      const tempInv = await buildInventory({ modsDir: mods, curseForgeInstanceFile: null })
      assertGroupingInvariants(tempInv)
      expect(tempInv.files.find((f) => f.relPath === 'a.package')!.hash.status).toBe('hashed')
      expect(tempInv.files.find((f) => f.relPath === 'b.package')!.hash.status).toBe('hashed')
      expect(tempInv.files.find((f) => f.relPath === 'unique.txt')!.hash).toEqual({ status: 'not-needed' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('broken-packages: marks archives as archive and summarizes package states', async () => {
    const inv = await scanFixture('broken-packages')
    assertGroupingInvariants(inv)

    const archives = inv.files.filter((f) => f.kind === 'archive').map((f) => f.relPath)
    expect(archives).toEqual(['Downloads/ZippedScriptMod.zip', 'Unextracted_CC_Bundle.zip'])

    const badMagic = inv.files.find((f) => f.relPath === 'corrupt_bad_magic.package')!
    expect(badMagic.kind).toBe('package')
    if (badMagic.kind === 'package') {
      expect(badMagic.dbpf.status).toBe('broken')
      if (badMagic.dbpf.status === 'broken') expect(badMagic.dbpf.problem).toBe('bad-magic')
    }

    const sims3 = inv.files.find((f) => f.relPath === 'wrong_game_sims3.package')!
    expect(sims3.kind).toBe('package')
    if (sims3.kind === 'package') {
      expect(sims3.dbpf).toEqual({ status: 'wrong-game', major: 2, minor: 0, game: 'sims3' })
    }
  })

  it('exceptions: reads CurseForge instance and assigns cf: groups', async () => {
    const inv = await scanFixture('exceptions')
    assertGroupingInvariants(inv)

    expect(inv.curseForge.status).toBe('found')
    if (inv.curseForge.status === 'found') {
      expect(inv.curseForge.addons).toHaveLength(2)
    }

    const sofa = inv.files.find((f) => f.relPath === 'sample_cozy_sofa.package')!
    expect(sofa.groupId).toBe('cf:900101')
    const sofaGroup = inv.groups.find((g) => g.id === 'cf:900101')!
    expect(sofaGroup.label).toBe('Sample Cozy Sofa CC')
    expect(sofaGroup.source).toBe('curseforge')
    expect(sofaGroup.curseForge).toEqual({
      addonId: 900101,
      fileId: 5500101,
      fileDate: '2026-11-15T12:00:00.000Z'
    })

    const wardrobe = inv.files.find((f) => f.relPath === 'WickedWardrobe/wicked_wardrobe.ts4script')!
    expect(wardrobe.groupId).toBe('cf:900202')
    const wardrobeGroup = inv.groups.find((g) => g.id === 'cf:900202')!
    expect(wardrobeGroup.label).toBe('Wicked Wardrobe Script Mod')
    expect(wardrobeGroup.hasScript).toBe(true)

    const mcccLog = inv.files.find((f) => f.relPath === 'MCCC/mc_lastexception.html')!
    expect(mcccLog.kind).toBe('other')
    expect(mcccLog.groupId).toBe('dir:mccc')
  })

  it('big: scans 5,000 packages and 300 scripts and reports progress', async () => {
    const root = join(FIXTURES_DIR, 'big')
    const located = await locate(createFixtureHost(root))
    const modsDir = join(located.userFolders[0]!.path, 'Mods')
    const events: Progress[] = []

    const inv = await buildInventory({
      modsDir,
      curseForgeInstanceFile: null,
      onProgress: (p) => events.push(p)
    })
    assertGroupingInvariants(inv)

    const packageCount = inv.files.filter((f) => f.kind === 'package').length
    const scriptCount = inv.files.filter((f) => f.kind === 'script').length
    expect(packageCount).toBe(5000)
    expect(scriptCount).toBe(300)
    expect(inv.files.length).toBe(5300)
    expect(inv.skipped).toEqual([])

    expect(events.length).toBeGreaterThan(0)
    expect(events[0]!.stage).toBe('counting')
    expect(events[0]!.total).toBeNull()
    const modEvents = events.filter((e) => e.stage === 'mods')
    expect(modEvents.length).toBeGreaterThan(0)
    expect(modEvents[modEvents.length - 1]!.done).toBe(5300)
    expect(modEvents[modEvents.length - 1]!.total).toBe(5300)
  }, 30_000)
})

describe('buildInventory safety and edge cases', () => {
  it('read-only proof: leaves every file, folder, date and hash untouched', async () => {
    const workDir = await realpath(await mkdtemp(join(tmpdir(), 'sims-inv-ro-')))
    try {
      for (const name of ['exceptions', 'broken-packages']) {
        const root = join(workDir, name)
        await generateFixture(await loadSpec(join(SPECS_DIR, `${name}.json`)), root)
        const before = await snapshotTree(root)
        expect(before.size).toBeGreaterThan(20)

        const located = await locate(createFixtureHost(root))
        const modsDir = join(located.userFolders[0]!.path, 'Mods')
        const inv = await buildInventory({
          modsDir,
          curseForgeInstanceFile: fixtureCurseForgePath(root)
        })
        expect(inv.files.length).toBeGreaterThan(0)
        expect(await snapshotTree(root), name).toEqual(before)
      }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('handles a Mods folder with a looping symlink and never leaves Mods', async () => {
    const workDir = await realpath(await mkdtemp(join(tmpdir(), 'sims-inv-links-')))
    try {
      const modsDir = join(workDir, 'Mods')
      const subDir = join(modsDir, 'Sub')
      const outsideDir = join(workDir, 'Outside')
      await mkdir(subDir, { recursive: true })
      await mkdir(outsideDir, { recursive: true })

      const pkgBytes = writeDbpf({ keys: [{ type: 1, group: 0, instance: 1n }] })
      await writeFile(join(subDir, 'inside.package'), pkgBytes)
      await writeFile(join(outsideDir, 'secret.package'), pkgBytes)

      // Loop back to Mods and to Sub, plus a link escaping outside Mods.
      const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'
      await symlink(modsDir, join(subDir, 'loop_to_root'), dirLinkType)
      await symlink(subDir, join(modsDir, 'alias_to_sub'), dirLinkType)
      await symlink(outsideDir, join(modsDir, 'escape_dir'), dirLinkType)
      if (process.platform !== 'win32') {
        await symlink(join(outsideDir, 'secret.package'), join(modsDir, 'escape_file.package'), 'file')
      }

      const inv = await buildInventory({ modsDir, curseForgeInstanceFile: null })
      assertGroupingInvariants(inv)

      expect(inv.files.map((f) => f.relPath)).toEqual(['Sub/inside.package'])
      expect(inv.files.some((f) => f.relPath.includes('secret'))).toBe(false)
      expect(inv.files.some((f) => f.relPath.includes('escape'))).toBe(false)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('returns modsDirState missing and empty lists when Mods does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-inv-missing-'))
    try {
      const modsDir = join(dir, 'Mods')
      const inv = await buildInventory({ modsDir, curseForgeInstanceFile: null })
      expect(inv).toEqual({
        modsDir,
        modsDirState: 'missing',
        files: [],
        groups: [],
        resourceCfg: { status: 'missing' },
        curseForge: { status: 'not-found' },
        skipped: []
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('handles case-insensitive extensions (.PACKAGE, .RAR, .7Z) and Resource.cfg edge cases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-inv-ext-'))
    try {
      const modsDir = join(dir, 'Mods')
      await mkdir(modsDir, { recursive: true })
      await writeFile(join(modsDir, 'UPPER.PACKAGE'), writeDbpf({ keys: [] }))
      await writeFile(join(modsDir, 'Packed.RAR'), 'rar-bytes')
      await writeFile(join(modsDir, 'Archive.7Z'), '7z-bytes')

      const inv = await buildInventory({ modsDir, curseForgeInstanceFile: null })
      assertGroupingInvariants(inv)
      expect(inv.resourceCfg).toEqual({ status: 'missing' })

      const kinds = Object.fromEntries(inv.files.map((f) => [f.relPath, f.kind]))
      expect(kinds).toEqual({
        'Archive.7Z': 'archive',
        'Packed.RAR': 'archive',
        'UPPER.PACKAGE': 'package'
      })

      await writeFile(join(modsDir, 'Resource.cfg'), 'Priority 500\r\nPackedFile *.package\r\n')
      expect(await readResourceCfg(modsDir)).toEqual({ status: 'ok', maxPackageDepth: 0 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('readCurseForge never throws and reports unreadable on bad JSON or unexpected shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-cf-test-'))
    try {
      expect(await readCurseForge(null)).toEqual({ status: 'not-found' })
      expect(await readCurseForge(join(dir, 'nope.json'))).toEqual({ status: 'not-found' })

      const badJson = join(dir, 'bad.json')
      await writeFile(badJson, '{not valid json')
      expect((await readCurseForge(badJson)).status).toBe('unreadable')

      const notArray = join(dir, 'obj.json')
      await writeFile(notArray, '{"gameID": 78062}')
      expect((await readCurseForge(notArray)).status).toBe('unreadable')

      const badAddons = join(dir, 'bad-addons.json')
      await writeFile(badAddons, JSON.stringify([{ gameID: 78062, installedAddons: 'oops' }]))
      expect((await readCurseForge(badAddons)).status).toBe('unreadable')

      const otherGameOnly = join(dir, 'other-game.json')
      await writeFile(otherGameOnly, JSON.stringify([{ gameID: 1, installedAddons: [] }]))
      expect(await readCurseForge(otherGameOnly)).toEqual({ status: 'not-found' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('matches CurseForge addons by case-insensitive relPath, base name, and module name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-cf-match-'))
    try {
      const modsDir = join(dir, 'Mods')
      await mkdir(join(modsDir, 'CustomDir'), { recursive: true })
      const pkg = writeDbpf({ keys: [] })
      await writeFile(join(modsDir, 'CustomDir', 'MOD_MAIN.PACKAGE'), pkg)
      await writeFile(join(modsDir, 'CustomDir', 'helper_part.package'), pkg)
      await writeFile(join(modsDir, 'CustomDir', 'unrelated.package'), pkg)

      const cfFile = join(dir, 'AddonGameInstance.json')
      await writeFile(
        cfFile,
        JSON.stringify([
          {
            gameID: 78062,
            installedAddons: [
              {
                addonID: 4242,
                installed: true,
                installedFile: {
                  id: 99,
                  displayName: 'Multi-File Mod',
                  fileNameOnDisk: 'SomeOtherFolder\\mod_main.package',
                  fileDate: '2026-11-15T12:00:00Z',
                  modules: [{ name: 'HELPER_PART.package', fingerprint: 123 }]
                }
              }
            ]
          }
        ])
      )

      const inv = await buildInventory({ modsDir, curseForgeInstanceFile: cfFile })
      assertGroupingInvariants(inv)

      const cfGroup = inv.groups.find((g) => g.id === 'cf:4242')
      expect(cfGroup?.files).toEqual(['CustomDir/MOD_MAIN.PACKAGE', 'CustomDir/helper_part.package'])
      const dirGroup = inv.groups.find((g) => g.id === 'dir:customdir')
      expect(dirGroup?.files).toEqual(['CustomDir/unrelated.package'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records unreadable folders and broken links in skipped', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'sims-inv-skip-')))
    try {
      const modsDir = join(dir, 'Mods')
      await mkdir(modsDir, { recursive: true })
      await writeFile(join(modsDir, 'good.package'), writeDbpf({ keys: [] }))

      if (process.platform !== 'win32') {
        await symlink(join(modsDir, 'nonexistent_target'), join(modsDir, 'broken_link.package'))
      }

      const lockedDir = join(modsDir, 'Locked')
      await mkdir(lockedDir, { recursive: true })
      await writeFile(join(lockedDir, 'hidden.package'), writeDbpf({ keys: [] }))

      const canTestChmod = process.platform !== 'win32' && process.getuid?.() !== 0
      if (canTestChmod) {
        await chmod(lockedDir, 0o000)
      }

      try {
        const inv = await buildInventory({ modsDir, curseForgeInstanceFile: null })
        assertGroupingInvariants(inv)
        expect(inv.files.some((f) => f.relPath === 'good.package')).toBe(true)
        if (process.platform !== 'win32') {
          expect(inv.skipped.some((s) => s.relPath === 'broken_link.package')).toBe(true)
        }
        if (canTestChmod) {
          expect(inv.skipped.some((s) => s.relPath === 'Locked')).toBe(true)
        }
      } finally {
        if (canTestChmod) {
          await chmod(lockedDir, 0o755)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
