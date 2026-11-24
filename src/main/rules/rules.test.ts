// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Finding, ModFile, RuleId } from '../../shared/model.ts'
import { sampleScan } from '../../shared/testing/sample.ts'
import { runRules } from './index.ts'
import { archive, cleanScan, crashLog, log, other, pkg, script, type ScanInput } from './testing.ts'

const CLEAN_FACTS = cleanScan().facts
const sha = (c: string) => c.repeat(64)

function only(scan: ScanInput, rule: RuleId): Finding[] {
  return runRules(scan).filter((f) => f.rule === rule)
}

function withFiles(files: ModFile[], change: Parameters<typeof cleanScan>[0] = {}): ScanInput {
  return cleanScan({ files, ...change })
}

describe('a clean scan', () => {
  it('gives no findings', () => {
    expect(runRules(cleanScan())).toEqual([])
  })
})

describe('mods-off', () => {
  it('fires as stop when both switches are off and mods exist', () => {
    const scan = cleanScan({ facts: { ...CLEAN_FACTS, options: { status: 'ok', mods: 'off', scriptMods: 'off' } } })
    const [finding] = only(scan, 'mods-off')
    expect(finding).toMatchObject({
      id: 'mods-off',
      severity: 'stop',
      certainty: 'file-problem',
      fixes: [{ fix: 'turn-mods-on' }],
      next: 'none',
      files: [],
      groupIds: []
    })
    expect(finding!.evidence).toEqual(['Options.ini: modsdisabled = 1', 'Options.ini: scriptmodsenabled = 0'])
    expect(finding!.detail).toContain("Don't save your game until mods are back on")
  })

  it('fires when only script mods are off', () => {
    const scan = cleanScan({ facts: { ...CLEAN_FACTS, options: { status: 'ok', mods: 'on', scriptMods: 'off' } } })
    expect(only(scan, 'mods-off')[0]!.evidence).toEqual(['Options.ini: scriptmodsenabled = 0'])
  })

  it('stays silent when only script mods are off and she has no script mods', () => {
    const scan = withFiles([pkg('CAS/dress.package')], { facts: { ...CLEAN_FACTS, options: { status: 'ok', mods: 'on', scriptMods: 'off' } } })
    expect(only(scan, 'mods-off')).toEqual([])
  })

  it('fires only the mods-off variant when both switches are off and she has only package files', () => {
    const scan = withFiles([pkg('CAS/dress.package')], { facts: { ...CLEAN_FACTS, options: { status: 'ok', mods: 'off', scriptMods: 'off' } } })
    const [finding] = only(scan, 'mods-off')
    expect(finding!.title).toBe('Your mods are turned off')
    expect(finding!.evidence).toEqual(['Options.ini: modsdisabled = 1'])
    expect(finding!.detail).toContain("Don't save your game until mods are back on.")
  })

  it('fires the mods-off variant when mods are off and she has only a script mod', () => {
    const scan = withFiles([script('Mod/mod.ts4script')], { facts: { ...CLEAN_FACTS, options: { status: 'ok', mods: 'off', scriptMods: 'on' } } })
    const [finding] = only(scan, 'mods-off')
    expect(finding!.title).toBe('Your mods are turned off')
    expect(finding!.evidence).toEqual(['Options.ini: modsdisabled = 1'])
  })

  it('stays silent with no package or script, when a switch is only missing, or when Options.ini was not read', () => {
    const off = { ...CLEAN_FACTS, options: { status: 'ok', mods: 'off', scriptMods: 'off' } as const }
    expect(only(withFiles([archive('a.zip'), other('readme.txt')], { facts: off }), 'mods-off')).toEqual([])
    expect(only(cleanScan({ facts: { ...CLEAN_FACTS, options: { status: 'ok', mods: 'missing', scriptMods: 'missing' } } }), 'mods-off')).toEqual([])
    expect(only(cleanScan({ facts: { ...CLEAN_FACTS, options: { status: 'missing' } } }), 'mods-off')).toEqual([])
    expect(only(cleanScan({ facts: { ...CLEAN_FACTS, options: { status: 'unreadable', detail: 'EACCES' } } }), 'mods-off')).toEqual([])
  })
})

describe('folder-in-onedrive', () => {
  it('fires when the Sims folder is in OneDrive', () => {
    const clean = cleanScan()
    const [finding] = only(cleanScan({ folder: { ...clean.folder, inOneDrive: true } }), 'folder-in-onedrive')
    expect(finding).toMatchObject({ severity: 'warn', certainty: 'worth-testing', fixes: [], next: 'none' })
    expect(finding!.evidence).toEqual([`Sims folder: ${clean.folder.path}`])
  })
})

describe('two-sims-folders', () => {
  it('fires when another Sims folder exists, and offers to pick a folder', () => {
    const clean = cleanScan()
    const other = { path: 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: true, newestFileAt: new Date('2026-09-01T00:00:00.000Z') }
    const [finding] = only(cleanScan({ otherFolders: [other] }), 'two-sims-folders')
    expect(finding).toMatchObject({ severity: 'warn', certainty: 'worth-testing', fixes: [], next: 'pick-folder' })
    expect(finding!.evidence).toEqual([
      `Checking: ${clean.folder.path}`,
      `Also found: ${other.path} (newest file 2026-09-01T00:00:00.000Z)`
    ])
    expect(finding!.detail).toContain('2 Sims 4 folders')
  })
})

describe('log-names-mod', () => {
  const hint = 'c:/users/modauthor/projects/wicked_wardrobe/outfit_picker'

  it('fires once per group when a hint uniquely matches a script entry', () => {
    const scan = cleanScan({ logs: [log({ modHints: [hint] }), log({ file: 'mc_lastexception.html', kind: 'mccc', modHints: [hint] })] })
    const findings = only(scan, 'log-names-mod')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      id: 'log-names-mod:cf:901234',
      severity: 'warn',
      certainty: 'likely',
      files: ['WickedWardrobe/wardrobe.ts4script'],
      groupIds: ['cf:901234'],
      fixes: [{ fix: 'disable-group', groupId: 'cf:901234' }],
      next: 'none'
    })
    expect(findings[0]!.title).toBe('Wicked Wardrobe may be causing errors')
    expect(findings[0]!.evidence.join('\n')).toContain('wicked_wardrobe/outfit_picker.pyc')
  })

  it('fires on the sample scan, which has a matching hint', () => {
    const { findings: _f, ...scan } = sampleScan()
    expect(only(scan, 'log-names-mod').map((f) => f.id)).toEqual(['log-names-mod:cf:901234'])
  })

  it('gives one finding per named group, ordered by label', () => {
    const files = [
      script('Zed/zed.ts4script', ['zed_mod/core.pyc'], { groupId: 'cf:2' }),
      script('Alpha/alpha.ts4script', ['alpha_mod/core.pyc'], { groupId: 'cf:1' })
    ]
    const scan = withFiles(files, {
      labels: { 'cf:1': 'Alpha', 'cf:2': 'Zed' },
      logs: [log({ modHints: ['x:/build/zed_mod/core', 'x:/build/alpha_mod/core'] })]
    })
    expect(only(scan, 'log-names-mod').map((f) => f.id)).toEqual(['log-names-mod:cf:1', 'log-names-mod:cf:2'])
  })

  it('never matches an entry named __init__', () => {
    const files = [script('Pkg/pkg.ts4script', ['__init__.pyc', 'pkg/__init__.pyc'], { groupId: 'cf:7' })]
    const scan = withFiles(files, { logs: [log({ modHints: ['c:/dev/pkg/__init__', 'c:/dev/other/__init__'] })] })
    expect(only(scan, 'log-names-mod')).toEqual([])
  })

  it('names nobody when the longest match is in two groups', () => {
    const files = [
      script('A/a.ts4script', ['shared_lib/util.pyc'], { groupId: 'dir:a' }),
      script('B/b.ts4script', ['shared_lib/util.pyc'], { groupId: 'dir:b' })
    ]
    const scan = withFiles(files, { logs: [log({ modHints: ['c:/dev/shared_lib/util'] })] })
    expect(only(scan, 'log-names-mod')).toEqual([])
  })

  it('lets the longest match win over a shorter one in another group', () => {
    const files = [
      script('A/a.ts4script', ['mod_a/util.pyc'], { groupId: 'dir:a' }),
      script('B/b.ts4script', ['util.pyc'], { groupId: 'dir:b' })
    ]
    const scan = withFiles(files, { logs: [log({ modHints: ['c:/dev/mod_a/util'] })] })
    expect(only(scan, 'log-names-mod').map((f) => f.id)).toEqual(['log-names-mod:dir:a'])
  })

  it('matches only after a slash, ignores case, and skips broken scripts and non-Python entries', () => {
    const files = [
      script('A/a.ts4script', ['My_Mod/Picker.pyc', 'my_mod/notes.txt'], { groupId: 'dir:a' }),
      script('B/b.ts4script', [], { groupId: 'dir:b', script: { status: 'broken', detail: 'bad zip' } })
    ]
    const hit = withFiles(files, { logs: [log({ modHints: ['c:/x/my_mod/picker'] })] })
    expect(only(hit, 'log-names-mod').map((f) => f.id)).toEqual(['log-names-mod:dir:a'])
    for (const miss of ['c:/x/notmy_mod/picker', 'my_mod/picker', 'c:/x/my_mod/notes']) {
      expect(only(withFiles(files, { logs: [log({ modHints: [miss] })] }), 'log-names-mod'), miss).toEqual([])
    }
  })

  it('never names a mod from a crash log, even one with hints', () => {
    const scan = cleanScan({ logs: [crashLog({ modHints: [hint] })] })
    expect(only(scan, 'log-names-mod')).toEqual([])
    const [crash] = only(scan, 'crash-without-cause')
    expect(crash).toMatchObject({ files: [], groupIds: [], fixes: [], next: 'fifty-fifty' })
    expect(`${crash!.title} ${crash!.detail}`).not.toContain('Wicked Wardrobe')
  })

  it('ignores a log older than the named mod file (the mod was updated after the error)', () => {
    const updatedScript = script('WickedWardrobe/wardrobe.ts4script', ['wicked_wardrobe/outfit_picker.pyc'], {
      groupId: 'cf:901234',
      modifiedAt: '2026-11-22T12:00:00.000Z'
    })
    const staleLog = log({ fileModifiedAt: '2026-11-20T12:00:00.000Z', modHints: [hint] })
    expect(only(withFiles([updatedScript], { logs: [staleLog] }), 'log-names-mod')).toEqual([])

    const sameTimeLog = log({ fileModifiedAt: '2026-11-22T12:00:00.000Z', modHints: [hint] })
    expect(only(withFiles([updatedScript], { logs: [sameTimeLog] }), 'log-names-mod').map((f) => f.id)).toEqual(['log-names-mod:cf:901234'])

    const newerLog = log({ file: 'lastException_new.txt', kind: 'exception', fileModifiedAt: '2026-11-23T12:00:00.000Z', modHints: [hint] })
    const olderMccc = log({ file: 'MCCC/mc_lastexception.html', kind: 'mccc', fileModifiedAt: '2026-11-19T12:00:00.000Z', modHints: [hint] })
    const [mixed] = only(withFiles([updatedScript], { logs: [newerLog, olderMccc] }), 'log-names-mod')
    expect(mixed!.detail).toContain('Your last exception log mentions')
    expect(mixed!.evidence).toHaveLength(1)
    expect(mixed!.evidence[0]).toContain('lastException_new.txt')

    const untouchedScript = script('OtherMod/other.ts4script', ['other_mod/core.pyc'], {
      groupId: 'dir:othermod',
      modifiedAt: '2026-11-10T00:00:00.000Z'
    })
    const sharedLog = log({
      fileModifiedAt: '2026-11-20T12:00:00.000Z',
      modHints: [hint, 'c:/dev/other_mod/core']
    })
    expect(only(withFiles([updatedScript, untouchedScript], { logs: [sharedLog] }), 'log-names-mod').map((f) => f.id)).toEqual([
      'log-names-mod:dir:othermod'
    ])
  })
})

describe('script-too-deep', () => {
  it('fires once for every script more than one folder down', () => {
    const files = [
      script('ScriptMods/CoolMod/cool_mod.ts4script', ['cool_mod/a.pyc'], { groupId: 'dir:scriptmods' }),
      script('Gameplay/Tweaks/DeepMod/deep_mod.ts4script', ['deep_mod/a.pyc'], { groupId: 'dir:gameplay' }),
      script('ValidMod/valid.ts4script', ['valid/a.pyc'], { groupId: 'dir:validmod' })
    ]
    const findings = only(withFiles(files), 'script-too-deep')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      certainty: 'file-problem',
      files: ['ScriptMods/CoolMod/cool_mod.ts4script', 'Gameplay/Tweaks/DeepMod/deep_mod.ts4script'],
      groupIds: ['dir:scriptmods', 'dir:gameplay'],
      fixes: [{ fix: 'move-script-up', files: ['ScriptMods/CoolMod/cool_mod.ts4script', 'Gameplay/Tweaks/DeepMod/deep_mod.ts4script'] }]
    })
    expect(findings[0]!.evidence).toEqual([
      'ScriptMods/CoolMod/cool_mod.ts4script (2 folders deep)',
      'Gameplay/Tweaks/DeepMod/deep_mod.ts4script (3 folders deep)'
    ])
  })
})

describe('package-too-deep', () => {
  const files = [pkg('CAS/good.package'), pkg('CAS/a/b/c/four.package'), pkg('CAS/a/b/c/d/e/six.package')]

  it('uses the depth her Resource.cfg allows', () => {
    const scan = withFiles(files)
    const at3 = { ...scan, inventory: { ...scan.inventory, resourceCfg: { status: 'ok', maxPackageDepth: 3 } as const } }
    const [finding] = only(at3, 'package-too-deep')
    expect(finding).toMatchObject({ severity: 'warn', certainty: 'file-problem', fixes: [], next: 'none' })
    expect(finding!.files).toEqual(['CAS/a/b/c/four.package', 'CAS/a/b/c/d/e/six.package'])
    expect(finding!.detail).toContain('3 folders down')
  })

  it('counts a missing Resource.cfg as 5, and skips the rule when it is unreadable', () => {
    const scan = withFiles(files)
    const missing = { ...scan, inventory: { ...scan.inventory, resourceCfg: { status: 'missing' } as const } }
    expect(only(missing, 'package-too-deep')[0]!.files).toEqual(['CAS/a/b/c/d/e/six.package'])
    const unreadable = { ...scan, inventory: { ...scan.inventory, resourceCfg: { status: 'unreadable', detail: 'EACCES' } as const } }
    expect(only(unreadable, 'package-too-deep')).toEqual([])
  })
})

describe('archive-in-mods', () => {
  it('fires for every archive and offers to set them aside', () => {
    const files = [pkg('a.package'), archive('Unextracted_CC_Bundle.zip'), archive('Downloads/ZippedScriptMod.7z')]
    const [finding] = only(withFiles(files), 'archive-in-mods')
    expect(finding).toMatchObject({
      severity: 'warn',
      certainty: 'file-problem',
      files: ['Unextracted_CC_Bundle.zip', 'Downloads/ZippedScriptMod.7z'],
      fixes: [{ fix: 'set-aside-files', files: ['Unextracted_CC_Bundle.zip', 'Downloads/ZippedScriptMod.7z'] }]
    })
  })
})

describe('broken-package', () => {
  it('fires for broken packages and scripts, never for unreadable ones', () => {
    const files = [
      pkg('bad_magic.package', { dbpf: { status: 'broken', problem: 'bad-magic', detail: 'not DBPF' } }),
      pkg('locked.package', { dbpf: { status: 'unreadable', detail: 'EBUSY' } }),
      script('Bad/bad.ts4script', [], { script: { status: 'broken', detail: 'central directory missing' } }),
      script('Locked/locked.ts4script', [], { script: { status: 'unreadable', detail: 'EBUSY' } })
    ]
    const [finding] = only(withFiles(files), 'broken-package')
    expect(finding).toMatchObject({
      severity: 'warn',
      certainty: 'file-problem',
      files: ['bad_magic.package', 'Bad/bad.ts4script'],
      fixes: [{ fix: 'set-aside-files', files: ['bad_magic.package', 'Bad/bad.ts4script'] }]
    })
    expect(finding!.evidence).toEqual(['bad_magic.package: bad-magic (not DBPF)', 'Bad/bad.ts4script: central directory missing'])
  })
})

describe('wrong-game-package', () => {
  it('fires for packages from another game', () => {
    const files = [pkg('wrong_game_sims3.package', { dbpf: { status: 'wrong-game', major: 2, minor: 0, game: 'sims3' } })]
    const [finding] = only(withFiles(files), 'wrong-game-package')
    expect(finding).toMatchObject({
      severity: 'warn',
      certainty: 'file-problem',
      files: ['wrong_game_sims3.package'],
      fixes: [{ fix: 'set-aside-files', files: ['wrong_game_sims3.package'] }]
    })
    expect(finding!.evidence).toEqual(['wrong_game_sims3.package: package version 2.0 (sims3)'])
    expect(finding!.detail).toContain('The Sims 3')
  })
})

describe('duplicate-files', () => {
  const hashed = (c: string) => ({ status: 'hashed', sha256: sha(c) }) as const

  it('keeps the copy in a CurseForge group, and lists the others in the fix', () => {
    const files = [
      pkg('A/hair.package', { hash: hashed('a'), depth: 1, groupId: 'dir:a' }),
      pkg('Deep/x/y/hair.package', { hash: hashed('a'), groupId: 'cf:55' }),
      pkg('hair.package', { hash: hashed('a') })
    ]
    const [finding] = only(withFiles(files), 'duplicate-files')
    expect(finding).toMatchObject({ severity: 'warn', certainty: 'file-problem', next: 'none' })
    expect(finding!.fixes).toEqual([{ fix: 'set-aside-files', files: ['hair.package', 'A/hair.package'] }])
    expect(finding!.files).toEqual(['Deep/x/y/hair.package', 'hair.package', 'A/hair.package'])
  })

  it('keeps CurseForge even inside a backup-named folder, else avoids backup/copy/old folders, else shallower, else by name', () => {
    const files = [
      // Fixture `duplicates`: HelperMod/ beats BackupCopy/ (folder contains backup/copy), CurseForge/ beats CAS/Hair/ (shallower)
      pkg('CAS/Hair/sample_hair_01.package', { hash: hashed('b') }),
      pkg('CurseForge/sample_hair_01.package', { hash: hashed('b') }),
      script('HelperMod/helper_mod.ts4script', ['helper_mod/actions.pyc'], { hash: hashed('c') }),
      script('BackupCopy/helper_mod.ts4script', ['helper_mod/actions.pyc'], { hash: hashed('c') })
    ]
    const [finding] = only(withFiles(files), 'duplicate-files')
    expect(finding!.fixes).toEqual([
      { fix: 'set-aside-files', files: ['CAS/Hair/sample_hair_01.package', 'BackupCopy/helper_mod.ts4script'] }
    ])
    expect(finding!.detail).toContain('2 files are exact copies')

    // Non-backup deeper folder beats shallower backup/old/copy folder; CurseForge still wins over non-backup; filename "old" is not a folder
    const edgeFiles = [
      pkg('Old/deep.package', { hash: hashed('1') }),
      pkg('CAS/Hair/deep.package', { hash: hashed('1') }),
      pkg('my_copy_dir/item.package', { hash: hashed('2') }),
      pkg('Zed/item.package', { hash: hashed('2') }),
      pkg('Backup/cf_item.package', { hash: hashed('3'), groupId: 'cf:88' }),
      pkg('Clean/cf_item.package', { hash: hashed('3') }),
      pkg('old_hair.package', { hash: hashed('4') }),
      pkg('Clean/old_hair.package', { hash: hashed('4') }),
      pkg('Alpha/same.package', { hash: hashed('5') }),
      pkg('Beta/same.package', { hash: hashed('5') })
    ]
    const [edgeFinding] = only(withFiles(edgeFiles), 'duplicate-files')
    expect(edgeFinding!.fixes).toEqual([
      {
        fix: 'set-aside-files',
        files: ['Beta/same.package', 'Clean/cf_item.package', 'Old/deep.package', 'Clean/old_hair.package', 'my_copy_dir/item.package']
      }
    ])
  })

  it('counts a folder as a backup folder only when a whole word in its name says so', () => {
    const keptAndExtra = (paths: [string, string]) => {
      const [finding] = only(withFiles(paths.map((p) => pkg(p, { hash: hashed('e') }))), 'duplicate-files')
      return finding!.evidence
    }
    // "Household", "Gold" and "Folder" only contain the letters of "old": same depth, so the first by name stays.
    expect(keptAndExtra(['Household/x.package', 'Mods/x.package'])).toEqual(['Keeps: Household/x.package', 'Extra copy: Mods/x.package'])
    expect(keptAndExtra(['Gold/x.package', 'Mods/x.package'])).toEqual(['Keeps: Gold/x.package', 'Extra copy: Mods/x.package'])
    expect(keptAndExtra(['Folder/x.package', 'Mods/x.package'])).toEqual(['Keeps: Folder/x.package', 'Extra copy: Mods/x.package'])
    expect(keptAndExtra(['Copyright Free/x.package', 'Mods/x.package'])).toEqual([
      'Keeps: Copyright Free/x.package',
      'Extra copy: Mods/x.package'
    ])
    // Whole words, split on non-letters and on a lower-to-upper change, in any case.
    for (const backup of ['BackupCopy', 'my backups', 'mods.bak', 'Copy of CAS', 'copies2', 'OLD', 'old_mods', 'hairOlder', 'Mods - Copy (2)']) {
      expect(keptAndExtra([`${backup}/x.package`, 'Zed/x.package']), backup).toEqual(['Keeps: Zed/x.package', `Extra copy: ${backup}/x.package`])
    }
  })

  it('ignores files that were not hashed, and files that are not mods', () => {
    const files = [
      pkg('a.package', { hash: { status: 'not-needed' } }),
      pkg('b.package', { hash: { status: 'unreadable', detail: 'EBUSY' } }),
      other('A/readme.txt', { hash: hashed('d') }),
      other('B/readme.txt', { hash: hashed('d') })
    ]
    expect(only(withFiles(files), 'duplicate-files')).toEqual([])
  })
})

describe('script-older-than-update', () => {
  it('fires as an info hint for scripts dated before the game update', () => {
    const files = [
      script('Old/old.ts4script', ['old/a.pyc'], { modifiedAt: '2026-10-01T00:00:00.000Z' }),
      script('New/new.ts4script', ['new/a.pyc'], { modifiedAt: '2026-11-16T00:00:00.000Z' })
    ]
    const [finding] = only(withFiles(files), 'script-older-than-update')
    expect(finding).toMatchObject({
      severity: 'info',
      certainty: 'worth-testing',
      files: ['Old/old.ts4script'],
      groupIds: ['dir:old'],
      fixes: [],
      next: 'none'
    })
    expect(finding!.detail).toContain('only a hint, not proof')
  })

  it('stays silent without a game update date', () => {
    const files = [script('Old/old.ts4script', ['old/a.pyc'], { modifiedAt: '2020-01-01T00:00:00.000Z' })]
    expect(only(withFiles(files, { facts: { ...CLEAN_FACTS, gameUpdatedAt: null } }), 'script-older-than-update')).toEqual([])
  })
})

describe('stale-thumbnail-cache', () => {
  it('fires when the newest mod file is newer than the cache', () => {
    const scan = cleanScan({ facts: { ...CLEAN_FACTS, thumbCacheAt: '2026-11-17T00:00:00.000Z' } })
    const [finding] = only(scan, 'stale-thumbnail-cache')
    expect(finding).toMatchObject({ severity: 'info', certainty: 'file-problem', fixes: [{ fix: 'clear-caches' }], files: [], groupIds: [] })
    expect(finding!.evidence).toEqual([
      'localthumbcache.package: 2026-11-17T00:00:00.000Z',
      'Newest mod: Hair/cozy_braids.package (2026-11-18T18:05:00.000Z)'
    ])
  })

  it('stays silent with no cache file, or when only non-mod files are newer', () => {
    expect(only(cleanScan({ facts: { ...CLEAN_FACTS, thumbCacheAt: null } }), 'stale-thumbnail-cache')).toEqual([])
    const files = [pkg('a.package'), other('notes.txt', { modifiedAt: '2026-11-23T00:00:00.000Z' })]
    expect(only(withFiles(files), 'stale-thumbnail-cache')).toEqual([])
  })

  it('ignores an invalid mod timestamp when another mod file is newer than the cache', () => {
    const files = [
      pkg('bad_date.package', { modifiedAt: 'not-a-date' }),
      pkg('newer.package', { modifiedAt: '2026-11-22T00:00:00.000Z' })
    ]
    const [finding] = only(withFiles(files, { facts: { ...CLEAN_FACTS, thumbCacheAt: '2026-11-20T00:00:00.000Z' } }), 'stale-thumbnail-cache')
    expect(finding).toMatchObject({ rule: 'stale-thumbnail-cache', fixes: [{ fix: 'clear-caches' }] })
    expect(finding!.evidence[1]).toBe('Newest mod: newer.package (2026-11-22T00:00:00.000Z)')
  })
})

describe('crash-without-cause', () => {
  it('fires when a crash log exists and no log named a mod', () => {
    const scan = cleanScan({ logs: [crashLog(), log({ modHints: [] })] })
    const [finding] = only(scan, 'crash-without-cause')
    expect(finding).toMatchObject({ severity: 'warn', certainty: 'worth-testing', fixes: [], next: 'fifty-fifty' })
    expect(finding!.evidence).toEqual(['lastCrash.txt: crash at 2026-11-23 15:14:00, game 1.129.39.1030'])
  })

  it('with no mods at all, does not point to 50/50 and suggests Repair in the EA app', () => {
    for (const files of [[], [other('readme.txt'), archive('notes.zip')]]) {
      const scan = withFiles(files, { logs: [crashLog()] })
      const [finding] = only(scan, 'crash-without-cause')
      expect(finding).toMatchObject({ severity: 'warn', certainty: 'worth-testing', fixes: [], next: 'none' })
      expect(finding!.title).toContain('no mods')
      expect(finding!.detail).toContain('no mods')
      expect(finding!.detail).toContain('Repair in the EA app')
      expect(`${finding!.title} ${finding!.detail}`).not.toContain('50/50')
    }
  })

  it('stays silent when another log named a mod', () => {
    const scan = cleanScan({ logs: [crashLog(), log({ modHints: ['c:/dev/wicked_wardrobe/outfit_picker'] })] })
    expect(only(scan, 'crash-without-cause')).toEqual([])
  })

  it('fires when a crash log exists and the only exception log is older than the named mod', () => {
    const updatedScript = script('WickedWardrobe/wardrobe.ts4script', ['wicked_wardrobe/outfit_picker.pyc'], {
      groupId: 'cf:901234',
      modifiedAt: '2026-11-24T00:00:00.000Z'
    })
    const staleLog = log({ fileModifiedAt: '2026-11-20T12:00:00.000Z', modHints: ['c:/dev/wicked_wardrobe/outfit_picker'] })
    const [finding] = only(withFiles([updatedScript], { logs: [crashLog(), staleLog] }), 'crash-without-cause')
    expect(finding).toMatchObject({ rule: 'crash-without-cause', next: 'fifty-fifty' })
  })
})

describe('runRules', () => {
  it('puts stop first, then warn, then info, in rule order', () => {
    const files = [
      script('Deep/x/deep.ts4script', ['deep/a.pyc'], { modifiedAt: '2026-01-01T00:00:00.000Z' }),
      archive('bundle.zip')
    ]
    const scan = withFiles(files, {
      facts: { options: { status: 'ok', mods: 'off', scriptMods: 'off' }, gameUpdatedAt: '2026-11-15T17:00:00.000Z', thumbCacheAt: '2025-01-01T00:00:00.000Z' },
      logs: [crashLog()]
    })
    expect(runRules(scan).map((f) => f.rule)).toEqual([
      'mods-off',
      'script-too-deep',
      'archive-in-mods',
      'crash-without-cause',
      'script-older-than-update',
      'stale-thumbnail-cache'
    ])
  })

  it('runs on 5,300 files in under a second', () => {
    const files: ModFile[] = []
    for (let i = 0; i < 5300; i += 1) {
      const folder = `Folder${i % 200}`
      if (i % 10 === 0) {
        files.push(script(`${folder}/mod${i}.ts4script`, [`mod${i}/__init__.pyc`, `mod${i}/core.pyc`, `mod${i}/ui.pyc`], {
          hash: i % 20 === 0 ? { status: 'hashed', sha256: sha('e') } : { status: 'not-needed' }
        }))
      } else {
        files.push(pkg(`${folder}/sub/cc${i}.package`, { hash: i % 7 === 0 ? { status: 'hashed', sha256: sha('f') } : { status: 'not-needed' } }))
      }
    }
    const hints = Array.from({ length: 60 }, (_, i) => `c:/dev/mod${i * 10}/core`)
    const scan = withFiles(files, { logs: Array.from({ length: 10 }, () => log({ modHints: hints })) })
    const started = performance.now()
    const findings = runRules(scan)
    expect(performance.now() - started).toBeLessThan(1000)
    // 60 hints land in 20 folder groups (mod0 and mod200 share Folder0, and so on)
    expect(findings.filter((f) => f.rule === 'log-names-mod')).toHaveLength(20)
  })
})

/** A scan where every rule but crash-without-cause fires, and one where it does. */
function everythingScan(withCause: boolean): ScanInput {
  const files = [
    script('WickedWardrobe/wardrobe.ts4script', ['wicked_wardrobe/outfit_picker.pyc'], { groupId: 'cf:901234', modifiedAt: '2026-10-01T00:00:00.000Z' }),
    script('ScriptMods/CoolMod/cool_mod.ts4script', ['cool_mod/tweaks.pyc'], { modifiedAt: '2026-11-16T00:00:00.000Z' }),
    pkg('CAS/a/b/c/d/e/too_deep.package'),
    archive('Unextracted_CC_Bundle.zip'),
    pkg('corrupt_bad_magic.package', { dbpf: { status: 'broken', problem: 'bad-magic', detail: 'magic was PK' } }),
    pkg('wrong_game_sims3.package', { dbpf: { status: 'wrong-game', major: 2, minor: 0, game: 'sims3' } }),
    pkg('CAS/Hair/sample_hair_01.package', { hash: { status: 'hashed', sha256: sha('a') }, modifiedAt: '2026-11-22T00:00:00.000Z' }),
    pkg('CurseForge/sample_hair_01.package', { hash: { status: 'hashed', sha256: sha('a') } })
  ]
  const clean = cleanScan()
  return withFiles(files, {
    folder: { ...clean.folder, inOneDrive: true },
    otherFolders: [{ path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4', inOneDrive: false, newestFileAt: new Date('2026-09-10T10:00:00.000Z') }],
    facts: { options: { status: 'ok', mods: 'off', scriptMods: 'off' }, gameUpdatedAt: '2026-11-15T17:00:00.000Z', thumbCacheAt: '2026-11-01T10:00:00.000Z' },
    logs: [
      crashLog(),
      log({ modHints: withCause ? ['c:/users/modauthor/projects/wicked_wardrobe/outfit_picker'] : ['t:/ingame/gameplay/scripts/server/zone'] })
    ]
  })
}

describe('the words on real findings', () => {
  it('match the reviewed snapshot', () => {
    const words = (withCause: boolean) =>
      runRules(everythingScan(withCause)).map((f) => ({ id: f.id, severity: f.severity, certainty: f.certainty, title: f.title, detail: f.detail }))
    expect({ withLogNamingAMod: words(true), withCrashOnly: words(false) }).toMatchSnapshot()
  })

  it('cover every rule', () => {
    const rules = new Set([...runRules(everythingScan(true)), ...runRules(everythingScan(false))].map((f) => f.rule))
    expect(rules.size).toBe(13)
  })

  it('never show a path, module name, hint or category id', () => {
    for (const withCause of [true, false]) {
      const scan = everythingScan(withCause)
      const technical = [
        scan.folder.path,
        ...scan.otherFolders.map((f) => f.path),
        ...scan.inventory.files.flatMap((f) => [f.relPath, f.relPath.split('/').pop()!, ...(f.kind === 'script' && f.script.status === 'ok' ? f.script.entries : [])]),
        ...scan.logs.flatMap((l) => [l.file, ...(l.categoryId ? [l.categoryId] : []), ...l.modHints])
      ]
      for (const finding of runRules(scan)) {
        for (const text of technical) {
          expect(`${finding.title} ${finding.detail}`, `${finding.id} shows ${text}`).not.toContain(text)
        }
      }
    }
  })
})
