import type { FiftyFifty, Finding, JournalEntry, ModFile, ModGroup, Scan } from '../model.ts'

const SAMPLE_FOLDER_PATH = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'
const SAMPLE_MODS_DIR = `${SAMPLE_FOLDER_PATH}\\Mods`
const SAMPLE_SHA_A = 'a'.repeat(64)
const SAMPLE_SHA_B = 'b'.repeat(64)

export function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'mods-off',
    rule: 'mods-off',
    severity: 'stop',
    certainty: 'file-problem',
    title: 'Mods are turned off after an update',
    detail: "The Sims 4 turns mods off after a game update. Don't save your game until mods are back on.",
    evidence: ['Options.ini: modsdisabled = 1', 'Options.ini: scriptmodsenabled = 0'],
    files: [],
    groupIds: [],
    fixes: [{ fix: 'turn-mods-on' }],
    next: 'none',
    ...overrides
  }
}

export function sampleScan(overrides: Partial<Scan> = {}): Scan {
  const scriptFile = 'Gameplay/WickedWardrobe/Scripts/wardrobe.ts4script'
  const ccFile = 'Hair/cozy_braids.package'

  const files: ModFile[] = [
    {
      kind: 'script',
      relPath: scriptFile,
      bytes: 48_120,
      modifiedAt: '2026-10-10T14:20:00.000Z',
      hash: { status: 'not-needed' },
      groupId: 'cf:901234',
      depth: 3,
      script: { status: 'ok', entries: ['wicked_wardrobe/outfit_picker.pyc'] }
    },
    {
      kind: 'package',
      relPath: ccFile,
      bytes: 1_240_000,
      modifiedAt: '2026-11-18T18:05:00.000Z',
      hash: { status: 'not-needed' },
      groupId: 'dir:hair',
      depth: 1,
      dbpf: { status: 'ok', keyCount: 14 }
    }
  ]

  const groups: ModGroup[] = [
    {
      id: 'cf:901234',
      label: 'Wicked Wardrobe',
      source: 'curseforge',
      files: [scriptFile],
      bytes: 48_120,
      hasScript: true,
      curseForge: {
        addonId: 901234,
        fileId: 5501122,
        fileDate: '2026-10-10T14:20:00.000Z'
      }
    },
    {
      id: 'dir:hair',
      label: 'Hair',
      source: 'folder',
      files: [ccFile],
      bytes: 1_240_000,
      hasScript: false,
      curseForge: null
    }
  ]

  const findings: Finding[] = [
    sampleFinding(),
    sampleFinding({
      id: 'script-too-deep',
      rule: 'script-too-deep',
      severity: 'warn',
      certainty: 'file-problem',
      title: 'A script mod is buried too deep in folders',
      detail:
        'The Sims 4 can only load script mods if they are directly inside Mods or one folder down. Right now the game is ignoring this one.',
      evidence: [`${scriptFile} (3 folders deep)`],
      files: [scriptFile],
      groupIds: ['cf:901234'],
      fixes: [{ fix: 'move-script-up', files: [scriptFile] }],
      next: 'none'
    }),
    sampleFinding({
      id: 'stale-thumbnail-cache',
      rule: 'stale-thumbnail-cache',
      severity: 'info',
      certainty: 'file-problem',
      title: 'The thumbnail cache is older than your latest mod change',
      detail: 'Clearing the temporary cache helps the game show your current mods cleanly. The game rebuilds these files on its own.',
      evidence: ['localthumbcache.package: 2026-11-01T10:00:00.000Z', `Newest mod: ${ccFile} (2026-11-18T18:05:00.000Z)`],
      files: [],
      groupIds: [],
      fixes: [{ fix: 'clear-caches' }],
      next: 'none'
    })
  ]

  return {
    id: '20261124-120000-a1b2',
    at: '2026-11-24T12:00:00.000Z',
    tookMs: 420,
    symptom: 'closes',
    folder: {
      path: SAMPLE_FOLDER_PATH,
      inOneDrive: false,
      newestFileAt: new Date('2026-11-23T22:15:00.000Z')
    },
    otherFolders: [],
    game: {
      path: 'C:\\Program Files\\EA Games\\The Sims 4',
      version: '1.129.39.1030',
      packs: ['EP01', 'EP02', 'GP02', 'SP18']
    },
    gameRunning: 'not-running',
    facts: {
      options: { status: 'ok', mods: 'off', scriptMods: 'off' },
      gameUpdatedAt: '2026-11-15T17:00:00.000Z',
      thumbCacheAt: '2026-11-01T10:00:00.000Z'
    },
    inventory: {
      modsDir: SAMPLE_MODS_DIR,
      modsDirState: 'present',
      files,
      groups,
      resourceCfg: { status: 'ok', maxPackageDepth: 5 },
      curseForge: {
        status: 'found',
        file: 'C:\\Users\\Lila\\AppData\\Roaming\\CurseForge\\agent\\GameInstances\\AddonGameInstance.json',
        addons: [
          {
            addonId: 901234,
            fileId: 5501122,
            name: 'Wicked Wardrobe',
            fileNameOnDisk: scriptFile,
            fileDate: '2026-10-10T14:20:00.000Z',
            moduleNames: ['wardrobe.ts4script']
          }
        ]
      },
      skipped: []
    },
    logs: [
      {
        file: 'lastException_63887259912.txt',
        kind: 'exception',
        fileModifiedAt: '2026-11-23T22:14:00.000Z',
        createdLocal: '11/23/26 15:14:00',
        gameVersion: '1.129.39.1030',
        categoryId: 'outfit_picker.py:42',
        message: 'AttributeError: NoneType object has no attribute sim_info',
        count: 1,
        frames: [
          { path: 'T:\\InGame\\Gameplay\\Scripts\\Server\\sims\\sim.py', line: 120, origin: 'game' },
          { path: 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4\\Mods\\wicked_wardrobe\\outfit_picker.py', line: 42, origin: 'mod' }
        ],
        modHints: ['c:/users/lila/documents/electronic arts/the sims 4/mods/wicked_wardrobe/outfit_picker'],
        completeness: 'complete'
      }
    ],
    findings,
    ...overrides
  }
}

export function sampleJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: '20261124-120500-c3d4',
    at: '2026-11-24T12:05:00.000Z',
    action: 'set-aside-files',
    summary: 'Set aside 1 zipped file from Mods',
    origin: { by: 'fix' },
    folderPath: SAMPLE_FOLDER_PATH,
    groupId: null,
    groupLabel: null,
    hasScript: false,
    backupId: '20261124-120400-e5f6',
    steps: [
      {
        kind: 'move',
        from: `${SAMPLE_MODS_DIR}\\download.zip`,
        to: 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper\\holding\\20261124-120500-c3d4\\Mods\\download.zip',
        bytes: 65_536,
        sha256: SAMPLE_SHA_A,
        state: 'applied'
      }
    ],
    status: 'done',
    undo: 'can-undo',
    undoneAt: null,
    ...overrides
  }
}

export function sampleFiftyFifty(overrides: Partial<FiftyFifty> = {}): FiftyFifty {
  const groups: ModGroup[] = [
    {
      id: 'cf:901234',
      label: 'Wicked Wardrobe',
      source: 'curseforge',
      files: ['WickedWardrobe/wardrobe.ts4script'],
      bytes: 48_120,
      hasScript: true,
      curseForge: {
        addonId: 901234,
        fileId: 5501122,
        fileDate: '2026-10-10T14:20:00.000Z'
      }
    },
    {
      id: 'dir:hair',
      label: 'Hair',
      source: 'folder',
      files: ['Hair/cozy_braids.package'],
      bytes: 1_240_000,
      hasScript: false,
      curseForge: null
    },
    {
      id: 'dir:buildbuy',
      label: 'BuildBuy',
      source: 'folder',
      files: ['BuildBuy/plants.package'],
      bytes: 820_000,
      hasScript: false,
      curseForge: null
    },
    {
      id: 'file:shoes.package',
      label: 'shoes',
      source: 'loose',
      files: ['shoes.package'],
      bytes: 410_000,
      hasScript: false,
      curseForge: null
    }
  ]
  const suspects = ['cf:901234', 'dir:buildbuy', 'dir:hair', 'file:shoes.package']

  return {
    id: '20261124-121000-f7a8',
    startedAt: '2026-11-24T12:10:00.000Z',
    folderPath: SAMPLE_FOLDER_PATH,
    phase: 'awaiting-answer',
    round: 1,
    roundsAtMost: 3, // ceil(log2(4)) + 1: the control round, then two halvings
    groups,
    suspects, // script groups first, then by label
    parked: ['cf:901234', 'dir:buildbuy'],
    inMods: ['dir:hair', 'file:shoes.package'],
    cleared: [],
    culprit: null,
    history: [{ round: 0, parked: [...suspects], answer: 'worked' }], // the control round: all aside, no crash
    ...overrides
  }
}

export { SAMPLE_SHA_A, SAMPLE_SHA_B }
