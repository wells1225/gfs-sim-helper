// The words she reads on each finding card. One function per rule, built from counts and mod names only:
// paths, module names and category ids belong in Finding.evidence, never here.
import type { LogKind, ModGroup } from '../model.ts'

export interface FindingWords {
  title: string
  detail: string
}

/** A mod as she knows it: its CurseForge name, its folder in Mods, or its file name. */
export type ModName = Pick<ModGroup, 'label' | 'source'>

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function modPhrase(mod: ModName): { name: string; it: 'it' | 'they'; itObject: 'it' | 'them' } {
  if (mod.source === 'folder') return { name: `the mods in your “${mod.label}” folder`, it: 'they', itObject: 'them' }
  if (mod.source === 'loose') return { name: `“${mod.label}”`, it: 'it', itObject: 'it' }
  return { name: mod.label, it: 'it', itObject: 'it' }
}

function itThem(count: number): 'it' | 'them' {
  return count === 1 ? 'it' : 'them'
}

export function modsOffWords(input: { modsOff: boolean; scriptModsOff: boolean }): FindingWords {
  const saveWarning = "Don't save your game until mods are back on. Saving now may remove CC and mod items from your save."
  if (input.modsOff && input.scriptModsOff) {
    return {
      title: 'Your mods and script mods are turned off',
      detail: `The game turns mods off after most updates, so this is common on patch day. ${saveWarning}`
    }
  }
  if (input.modsOff) {
    return {
      title: 'Your mods are turned off',
      detail: `The game's “Enable Custom Content and Mods” setting is off, so none of your mods are loading. ${saveWarning}`
    }
  }
  return {
    title: 'Script mods are turned off',
    detail: `The game's “Script Mods Allowed” setting is off, so no script mods can run. ${saveWarning}`
  }
}

export function folderInOneDriveWords(): FindingWords {
  return {
    title: 'Your Sims folder is inside OneDrive',
    detail:
      'OneDrive keeps syncing files while the game is using them, which can make mods go missing or the game crash. It is worth testing with OneDrive paused while you play.'
  }
}

export function twoSimsFoldersWords(input: { folderCount: number }): FindingWords {
  return {
    title: 'There is more than one Sims 4 folder on this PC',
    detail: `We found ${input.folderCount} Sims 4 folders. The game only uses one of them, so it is worth making sure we are checking the one your game really uses.`
  }
}

const LOG_PHRASE: Record<Exclude<LogKind, 'crash'>, string> = {
  exception: 'Your last exception log',
  uiException: 'Your UI exception log',
  betterExceptions: 'Your Better Exceptions report',
  mccc: "MCCC's error log"
}

export function logNamesModWords(input: { mod: ModName; logKinds: Exclude<LogKind, 'crash'>[] }): FindingWords {
  const mod = modPhrase(input.mod)
  const kinds = [...new Set(input.logKinds)]
  const logs = kinds.length === 1 ? `${LOG_PHRASE[kinds[0]!]} mentions` : 'Your error logs mention'
  return {
    title: `${capitalize(mod.name)} may be causing errors`,
    detail: `${logs} a file from ${mod.name}, so ${mod.it} may be part of the problem. That is a strong clue, not proof: one mod's error can show up while a different mod is the real cause. Setting ${mod.itObject} aside for a while is a safe way to test.`
  }
}

export function scriptTooDeepWords(input: { count: number }): FindingWords {
  const one = input.count === 1
  return {
    title: one
      ? 'A script mod is buried too deep in folders'
      : `${input.count} script mods are buried too deep in folders`,
    detail: `The game only runs script mods that sit right in the Mods folder or one folder down. Right now it is skipping ${one ? 'this one' : 'these'}. Moving ${itThem(input.count)} nearer the top of your mods folder fixes that.`
  }
}

export function packageTooDeepWords(input: { count: number; maxDepth: number }): FindingWords {
  const one = input.count === 1
  const reach =
    input.maxDepth === 0
      ? 'only looks in the Mods folder itself, not in folders inside it'
      : input.maxDepth === 1
        ? 'only looks one folder down inside Mods'
        : `only looks ${input.maxDepth} folders down inside Mods`
  return {
    title: one ? 'A CC file is too deep in folders to load' : `${input.count} CC files are too deep in folders to load`,
    detail: `On this PC the game ${reach}. ${one ? 'This package file sits' : 'These package files sit'} deeper, so the game skips ${itThem(input.count)}. Moving ${itThem(input.count)} into a folder nearer the top of your mods folder lets the game find ${itThem(input.count)}.`
  }
}

export function archiveInModsWords(input: { count: number }): FindingWords {
  const one = input.count === 1
  return {
    title: one ? 'A zipped file is in your mods folder' : `${input.count} zipped files are in your mods folder`,
    detail: `The game can't open .zip, .rar or .7z files, so whatever is inside ${one ? 'it' : 'them'} isn't loading. To use ${one ? 'the mod inside, unzip it' : 'the mods inside, unzip them'} into your mods folder. Otherwise ${one ? 'it is' : 'they are'} safe to set aside.`
  }
}

export function brokenPackageWords(input: { count: number }): FindingWords {
  const one = input.count === 1
  return {
    title: one ? 'A mod file is broken' : `${input.count} mod files are broken`,
    detail: `${one ? 'This file is' : 'These files are'} damaged or didn't finish downloading, so the game can't read ${itThem(input.count)}. Broken CC and mods like this can make the game crash. Setting ${itThem(input.count)} aside is safe, and you can download a fresh copy from where you got ${itThem(input.count)}.`
  }
}

const GAME_NAME = { sims2: 'The Sims 2', sims3: 'The Sims 3', simcity: 'SimCity' } as const

export function wrongGamePackageWords(input: { count: number; games: ('sims2' | 'sims3' | 'simcity' | 'unknown')[] }): FindingWords {
  const one = input.count === 1
  const known = [...new Set(input.games)]
  const made =
    known.length === 1 && known[0] !== 'unknown' ? `made for ${GAME_NAME[known[0]!]}` : 'made for a different game, like The Sims 3'
  return {
    title: one ? 'A CC file is from a different Sims game' : `${input.count} CC files are from a different Sims game`,
    detail: `${one ? 'This package file was' : 'These package files were'} ${made}. The Sims 4 can't use ${itThem(input.count)}, and files like this can mess up your game. Setting ${itThem(input.count)} aside is safe.`
  }
}

export function duplicateFilesWords(input: { extraCount: number }): FindingWords {
  const one = input.extraCount === 1
  return {
    title: one ? 'A mod file is in your mods folder twice' : `${input.extraCount} mod files are extra copies`,
    detail: `${one ? 'One file is an exact copy of another file' : `${input.extraCount} files are exact copies of other files`} in your mods folder. Two copies of the same mod can clash and cause errors. Setting the extra ${one ? 'copy' : 'copies'} aside leaves one of each in place.`
  }
}

export function scriptOlderThanUpdateWords(input: { count: number }): FindingWords {
  const one = input.count === 1
  return {
    title: one
      ? 'A script mod is older than your last game update'
      : `${input.count} script mods are older than your last game update`,
    detail: `Script mods made before a game update sometimes stop working until their creator updates them. This is only a hint, not proof: plenty of older script mods still work fine. If the game keeps crashing, check ${one ? 'this one' : 'these'} for an update first.`
  }
}

export function staleThumbnailCacheWords(): FindingWords {
  return {
    title: 'The thumbnail cache is older than your latest mod change',
    detail:
      'Clearing the cache after changing mods helps the game show them properly. The game rebuilds these files on its own, so nothing is lost.'
  }
}

export function crashWithoutCauseWords(input: { crashCount: number }): FindingWords {
  return {
    title: "The game crashed, but it didn't say which mod",
    detail: `The crash ${input.crashCount === 1 ? 'log only says' : 'logs only say'} when the game closed, not why, so the game did not say which mod (if any) caused it. The 50/50 test can find it step by step, starting with script mods.`
  }
}
