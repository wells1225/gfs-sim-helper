import { describe, expect, it } from 'vitest'
import { applyModsView, matchMod, newestModifiedAt, summarizeMods, type FilterableMod } from './mods-filter.ts'

const GAME_UPDATED_AT = '2026-11-15T17:00:00.000Z'

function mod(overrides: Partial<FilterableMod> & { label: string }): FilterableMod {
  return { enabled: true, hasScript: false, bytes: 0, files: [], ...overrides }
}

const wardrobe = mod({
  label: 'Wicked Wardrobe',
  hasScript: true,
  bytes: 48_120,
  files: [
    { relPath: 'Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script', bytes: 48_000, modifiedAt: '2026-10-10T14:20:00.000Z' },
    { relPath: 'Gameplay/WickedWardrobe/wardrobe_tuning.package', bytes: 120, modifiedAt: '2026-10-01T09:00:00.000Z' }
  ]
})
const hair = mod({
  label: 'Hair',
  bytes: 1_240_000,
  files: [{ relPath: 'Hair/cozy_braids.package', bytes: 1_240_000, modifiedAt: '2026-11-18T18:05:00.000Z' }]
})
const buildBuy = mod({
  label: 'BuildBuy',
  bytes: 3_000_000,
  enabled: false,
  files: [{ relPath: 'BuildBuy/Plants/fern_pot.package', bytes: 3_000_000, modifiedAt: '2026-09-01T08:00:00.000Z' }]
})
// Set aside and not in the check-up: known only from the journal, so there are no files and no size.
const journalOnly = mod({ label: 'Alpha Poses', enabled: false, bytes: null, files: [] })

const all = [wardrobe, hair, buildBuy, journalOnly]

function labels(rows: { item: FilterableMod }[]): string[] {
  return rows.map((r) => r.item.label)
}

function view(overrides: Partial<Parameters<typeof applyModsView>[1]> = {}) {
  return applyModsView(all, { query: '', filter: 'all', sort: 'name', gameUpdatedAt: GAME_UPDATED_AT, ...overrides })
}

describe('matchMod', () => {
  it('matches the group label in any letter case, with no file hint', () => {
    expect(matchMod(wardrobe, 'WICKED')).toEqual({ matches: true, matchedFile: null })
  })

  it('matches a pasted file name in mixed case and names the file', () => {
    expect(matchMod(wardrobe, 'Wardrobe.TS4Script')).toEqual({ matches: true, matchedFile: 'wardrobe.ts4script' })
    expect(matchMod(hair, '  COZY_braids.package ')).toEqual({ matches: true, matchedFile: 'cozy_braids.package' })
  })

  it('matches a subfolder name and shows the whole path, since the file name alone does not hold it', () => {
    expect(matchMod(buildBuy, 'plants')).toEqual({ matches: true, matchedFile: 'BuildBuy/Plants/fern_pot.package' })
  })

  it('matches a path pasted with Windows backslashes', () => {
    expect(matchMod(buildBuy, 'Plants\\fern_pot')).toEqual({ matches: true, matchedFile: 'BuildBuy/Plants/fern_pot.package' })
    expect(matchMod(buildBuy, 'BuildBuy\\Plants\\FERN_POT.package').matches).toBe(true)
  })

  it('does not match when neither the label nor any file holds the words', () => {
    expect(matchMod(hair, 'wardrobe')).toEqual({ matches: false, matchedFile: null })
  })

  it('a journal-only row with no files matches on its label only', () => {
    expect(matchMod(journalOnly, 'alpha').matches).toBe(true)
    expect(matchMod(journalOnly, 'poses.package').matches).toBe(false)
  })

  it('an empty search matches everything', () => {
    expect(matchMod(hair, '   ')).toEqual({ matches: true, matchedFile: null })
  })
})

describe('applyModsView filters', () => {
  it('all keeps every row', () => {
    expect(labels(view())).toEqual(['Alpha Poses', 'BuildBuy', 'Hair', 'Wicked Wardrobe'])
  })

  it('scripts keeps only script mods', () => {
    expect(labels(view({ filter: 'scripts' }))).toEqual(['Wicked Wardrobe'])
  })

  it('older-than-update keeps groups whose newest file is older than the game update, never journal-only rows', () => {
    expect(labels(view({ filter: 'older-than-update' }))).toEqual(['BuildBuy', 'Wicked Wardrobe'])
  })

  it('older-than-update keeps nothing when the game update date is unknown', () => {
    expect(view({ filter: 'older-than-update', gameUpdatedAt: null })).toEqual([])
  })

  it('set-aside keeps only rows that are switched off, journal-only rows included', () => {
    expect(labels(view({ filter: 'set-aside' }))).toEqual(['Alpha Poses', 'BuildBuy'])
  })

  it('combines a filter with a file name search and keeps the hint', () => {
    expect(view({ filter: 'scripts', query: 'wardrobe.ts4script' })).toEqual([
      { item: wardrobe, matchedFile: 'wardrobe.ts4script' }
    ])
    expect(view({ filter: 'set-aside', query: 'wardrobe' })).toEqual([])
  })
})

describe('applyModsView sorts', () => {
  it('name sorts A to Z, ignoring letter case', () => {
    const lower = mod({ label: 'aardvark' })
    expect(labels(applyModsView([hair, lower, buildBuy], { query: '', filter: 'all', sort: 'name', gameUpdatedAt: null }))).toEqual([
      'aardvark',
      'BuildBuy',
      'Hair'
    ])
  })

  it('largest sorts by size, biggest first, ties by name, unknown sizes last', () => {
    const tie = mod({ label: 'Aaa Hair Twin', bytes: 1_240_000 })
    const rows = applyModsView([journalOnly, wardrobe, hair, tie, buildBuy], {
      query: '',
      filter: 'all',
      sort: 'largest',
      gameUpdatedAt: null
    })
    expect(labels(rows)).toEqual(['BuildBuy', 'Aaa Hair Twin', 'Hair', 'Wicked Wardrobe', 'Alpha Poses'])
  })

  it('oldest sorts by each group newest file date, oldest first, unknown dates last', () => {
    expect(labels(view({ sort: 'oldest' }))).toEqual(['BuildBuy', 'Wicked Wardrobe', 'Hair', 'Alpha Poses'])
  })
})

describe('newestModifiedAt and summarizeMods', () => {
  it('takes the newest date in a group, and null when it has no files', () => {
    expect(newestModifiedAt(wardrobe.files)).toBe(Date.parse('2026-10-10T14:20:00.000Z'))
    expect(newestModifiedAt([])).toBeNull()
  })

  it('counts groups, script mods, total size and set-aside rows', () => {
    expect(summarizeMods(all)).toEqual({ groups: 4, scripts: 1, bytes: 48_120 + 1_240_000 + 3_000_000, setAside: 2 })
  })
})
