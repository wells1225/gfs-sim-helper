// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  archiveInModsWords,
  brokenPackageWords,
  crashWithoutCauseWords,
  duplicateFilesWords,
  type FindingWords,
  folderInOneDriveWords,
  logNamesModWords,
  modsOffWords,
  packageTooDeepWords,
  scriptOlderThanUpdateWords,
  scriptTooDeepWords,
  staleThumbnailCacheWords,
  twoSimsFoldersWords,
  wrongGamePackageWords
} from './findings.ts'

/** Every variant of every message, so a wording change shows up in review. */
const ALL_WORDS: Record<string, FindingWords> = {
  'mods-off: both': modsOffWords({ modsOff: true, scriptModsOff: true }),
  'mods-off: mods only': modsOffWords({ modsOff: true, scriptModsOff: false }),
  'mods-off: script mods only': modsOffWords({ modsOff: false, scriptModsOff: true }),
  'folder-in-onedrive': folderInOneDriveWords(),
  'two-sims-folders: 2': twoSimsFoldersWords({ folderCount: 2 }),
  'log-names-mod: CurseForge mod, last exception': logNamesModWords({
    mod: { label: 'Wicked Wardrobe', source: 'curseforge' },
    logKinds: ['exception']
  }),
  'log-names-mod: folder, Better Exceptions': logNamesModWords({
    mod: { label: 'Gameplay', source: 'folder' },
    logKinds: ['betterExceptions']
  }),
  'log-names-mod: loose file, UI exception': logNamesModWords({
    mod: { label: 'outfit_picker', source: 'loose' },
    logKinds: ['uiException']
  }),
  'log-names-mod: MCCC log': logNamesModWords({ mod: { label: 'MC Command Center', source: 'curseforge' }, logKinds: ['mccc'] }),
  'log-names-mod: several logs': logNamesModWords({
    mod: { label: 'Wicked Wardrobe', source: 'curseforge' },
    logKinds: ['exception', 'betterExceptions', 'mccc']
  }),
  'script-too-deep: 1': scriptTooDeepWords({ count: 1 }),
  'script-too-deep: 3': scriptTooDeepWords({ count: 3 }),
  'package-too-deep: 1, depth 5': packageTooDeepWords({ count: 1, maxDepth: 5 }),
  'package-too-deep: 2, depth 3': packageTooDeepWords({ count: 2, maxDepth: 3 }),
  'package-too-deep: 1, depth 1': packageTooDeepWords({ count: 1, maxDepth: 1 }),
  'package-too-deep: 2, depth 0': packageTooDeepWords({ count: 2, maxDepth: 0 }),
  'archive-in-mods: 1': archiveInModsWords({ count: 1 }),
  'archive-in-mods: 2': archiveInModsWords({ count: 2 }),
  'broken-package: 1': brokenPackageWords({ count: 1 }),
  'broken-package: 3': brokenPackageWords({ count: 3 }),
  'wrong-game-package: 1, Sims 3': wrongGamePackageWords({ count: 1, games: ['sims3'] }),
  'wrong-game-package: 2, Sims 2': wrongGamePackageWords({ count: 2, games: ['sims2', 'sims2'] }),
  'wrong-game-package: 1, unknown': wrongGamePackageWords({ count: 1, games: ['unknown'] }),
  'wrong-game-package: 2, mixed': wrongGamePackageWords({ count: 2, games: ['sims2', 'sims3'] }),
  'duplicate-files: 1': duplicateFilesWords({ extraCount: 1 }),
  'duplicate-files: 2': duplicateFilesWords({ extraCount: 2 }),
  'script-older-than-update: 1': scriptOlderThanUpdateWords({ count: 1 }),
  'script-older-than-update: 4': scriptOlderThanUpdateWords({ count: 4 }),
  'stale-thumbnail-cache': staleThumbnailCacheWords(),
  'crash-without-cause: 1': crashWithoutCauseWords({ crashCount: 1, hasMods: true }),
  'crash-without-cause: 2': crashWithoutCauseWords({ crashCount: 2, hasMods: true }),
  'crash-without-cause: 1, no mods': crashWithoutCauseWords({ crashCount: 1, hasMods: false }),
  'crash-without-cause: 2, no mods': crashWithoutCauseWords({ crashCount: 2, hasMods: false })
}

describe('finding words', () => {
  it('match the reviewed snapshot', () => {
    expect(ALL_WORDS).toMatchSnapshot()
  })

  it('tell her not to save while mods are off', () => {
    for (const key of ['mods-off: both', 'mods-off: mods only', 'mods-off: script mods only']) {
      expect(ALL_WORDS[key]!.detail).toContain("Don't save your game until mods are back on")
    }
  })

  it('call an old script mod a hint, not proof', () => {
    expect(ALL_WORDS['script-older-than-update: 1']!.detail).toContain('only a hint, not proof')
    expect(ALL_WORDS['script-older-than-update: 4']!.detail).toContain('only a hint, not proof')
  })

  it('say a bare crash names no mod, and point to the 50/50 test when she has mods', () => {
    for (const key of ['crash-without-cause: 1', 'crash-without-cause: 2']) {
      expect(ALL_WORDS[key]!.detail).toContain('did not say which mod')
      expect(ALL_WORDS[key]!.detail).toContain('The 50/50 test can find it')
    }
  })

  it('say a crash with no mods points to Repair in the EA app, not 50/50', () => {
    for (const key of ['crash-without-cause: 1, no mods', 'crash-without-cause: 2, no mods']) {
      expect(ALL_WORDS[key]!.title).toContain('no mods')
      expect(ALL_WORDS[key]!.detail).toContain('no mods')
      expect(ALL_WORDS[key]!.detail).toContain('Repair in the EA app')
      expect(`${ALL_WORDS[key]!.title} ${ALL_WORDS[key]!.detail}`).not.toContain('50/50')
    }
  })

  it('never call a mod named in a log guilty: "may", and why', () => {
    for (const [key, words] of Object.entries(ALL_WORDS)) {
      if (!key.startsWith('log-names-mod')) continue
      expect(words.title).toContain('may be')
      expect(words.detail).toContain('not proof')
      expect(words.detail).toMatch(/mentions? a file from/)
    }
  })

  it('use the right pronoun for a folder of mods', () => {
    expect(ALL_WORDS['log-names-mod: folder, Better Exceptions']!.detail).toContain('so they may be part of the problem')
    expect(ALL_WORDS['log-names-mod: folder, Better Exceptions']!.detail).toContain('Setting them aside')
  })

  it('use no error codes, file extensions of scripts, or developer words', () => {
    for (const [key, words] of Object.entries(ALL_WORDS)) {
      const text = `${words.title} ${words.detail}`
      expect(text, key).not.toMatch(/\.ts4script|\.pyc?\b|\.package\b|categoryid|traceback|dbpf|sha-?256|0x[0-9a-f]/i)
      expect(text, key).not.toMatch(/\b(error code|exception:|null|undefined|NaN)\b/)
    }
  })
})
