// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { createFixtureHost, parsePeFileVersion } from './fixture-host.ts'
import {
  checkGameRunning,
  findGameInstall,
  findUserFolders,
  isSimsProcessName,
  listInstalledPacks,
  locate,
  parseRegQueryOutput,
  parseTasklistCsv,
  readGameVersionFromTxt,
  SIMS_REGISTRY_KEY,
  SIMS_REGISTRY_VALUE
} from './index.ts'
import type { Host } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(THIS_DIR, '../../..')
const SPECS_DIR = join(REPO_ROOT, 'scripts/fixtures/specs')

describe('locate', () => {
  let workDir = ''
  const fixtureDirs = new Map<string, string>()

  beforeAll(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-locate-test-')))
    // Generate all 7 small fixtures into workDir (using spec name as dir name, so `onedrive` also
    // tests that a parent folder named "onedrive" does not falsely flag local Documents).
    for (const name of [
      'clean',
      'patch-day',
      'nested-scripts',
      'duplicates',
      'broken-packages',
      'onedrive',
      'exceptions'
    ]) {
      const spec = await loadSpec(join(SPECS_DIR, `${name}.json`))
      const outDir = join(workDir, name)
      await generateFixture(spec, outDir)
      fixtureDirs.set(name, outDir)
    }
  })

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('locates expected user folders and game install for every fixture spec', async () => {
    const cleanRoot = fixtureDirs.get('clean')!
    const clean = await locate(createFixtureHost(cleanRoot))
    expect(clean.gameRunning).toBe('not-running')
    expect(clean.userFolders).toEqual([
      {
        path: await realpath(join(cleanRoot, 'Users/Player/Documents/Electronic Arts/The Sims 4')),
        inOneDrive: false,
        newestFileAt: new Date('2026-11-20T18:00:00.000Z')
      }
    ])
    expect(clean.gameInstall).toEqual({
      path: join(cleanRoot, 'Program Files/EA Games/The Sims 4'),
      version: '1.129.39.1030',
      packs: ['EP01', 'EP02', 'FP01', 'GP02', 'SP18']
    })

    // patch-day uses the legacy Origin default install path
    const patchRoot = fixtureDirs.get('patch-day')!
    const patch = await locate(createFixtureHost(patchRoot))
    expect(patch.userFolders).toEqual([
      {
        path: await realpath(join(patchRoot, 'Users/Player/Documents/Electronic Arts/The Sims 4')),
        inOneDrive: false,
        newestFileAt: new Date('2026-11-20T18:05:00.000Z')
      }
    ])
    expect(patch.gameInstall).toEqual({
      path: join(patchRoot, 'Program Files (x86)/Origin Games/The Sims 4'),
      version: '1.129.39.1030',
      packs: ['EP01', 'EP02', 'GP02', 'SP18']
    })

    // nested-scripts uses the French folder name with U+00A0 no-break spaces
    const nestedRoot = fixtureDirs.get('nested-scripts')!
    const nested = await locate(createFixtureHost(nestedRoot))
    expect(nested.userFolders).toEqual([
      {
        path: await realpath(join(nestedRoot, 'Users/Player/Documents/Electronic Arts/Les\u00A0Sims\u00A04')),
        inOneDrive: false,
        newestFileAt: new Date('2026-11-20T18:00:00.000Z')
      }
    ])
    expect(nested.gameInstall?.packs).toEqual(['EP01', 'GP02', 'SP18'])

    // duplicates uses the Steam default install path
    const dupRoot = fixtureDirs.get('duplicates')!
    const dup = await locate(createFixtureHost(dupRoot))
    expect(dup.userFolders).toHaveLength(1)
    expect(dup.gameInstall).toEqual({
      path: join(dupRoot, 'Program Files (x86)/Steam/steamapps/common/The Sims 4'),
      version: '1.129.39.1030',
      packs: ['EP01', 'EP02', 'GP02', 'SP18']
    })

    // broken-packages and exceptions
    const brokenRoot = fixtureDirs.get('broken-packages')!
    const broken = await locate(createFixtureHost(brokenRoot))
    expect(broken.userFolders).toHaveLength(1)
    expect(broken.gameInstall?.version).toBe('1.129.39.1030')

    const exRoot = fixtureDirs.get('exceptions')!
    const ex = await locate(createFixtureHost(exRoot))
    expect(ex.userFolders).toHaveLength(1)
    expect(ex.userFolders[0]?.newestFileAt).toEqual(new Date('2026-11-20T20:00:00.000Z'))
    expect(ex.gameInstall?.packs).toEqual(['EP01', 'EP02', 'FP01', 'GP02', 'SP18'])
  })

  it('locates the big fixture and ignores Delta-only pack folders', async () => {
    const bigSpec = await loadSpec(join(SPECS_DIR, 'big.json'))
    const bigRoot = join(workDir, 'big')
    await generateFixture(bigSpec, bigRoot)

    const result = await locate(createFixtureHost(bigRoot))
    expect(result.userFolders).toHaveLength(1)
    expect(result.userFolders[0]?.inOneDrive).toBe(false)
    expect(result.userFolders[0]?.newestFileAt).toEqual(new Date('2026-11-20T18:00:00.000Z'))
    expect(result.gameInstall).toEqual({
      path: join(bigRoot, 'Program Files/EA Games/The Sims 4'),
      version: '1.129.39.1030',
      packs: ['EP01', 'EP02', 'EP03', 'EP05', 'EP08', 'EP11', 'FP01', 'GP02', 'GP07', 'SP18', 'SP31']
    })
  }, 30_000)

  it('returns both real candidates in onedrive with dates and inOneDrive flags, and drops the German look-alike without Options.ini', async () => {
    const odRoot = fixtureDirs.get('onedrive')!
    const result = await locate(createFixtureHost(odRoot))

    expect(result.userFolders).toEqual([
      {
        path: await realpath(join(odRoot, 'Users/Player/OneDrive/Documents/Electronic Arts/The Sims 4')),
        inOneDrive: true,
        newestFileAt: new Date('2026-11-22T15:00:00.000Z')
      },
      {
        path: await realpath(join(odRoot, 'Users/Player/Documents/Electronic Arts/The Sims 4')),
        inOneDrive: false,
        newestFileAt: new Date('2026-09-10T10:00:00.000Z')
      }
    ])
    expect(result.userFolders.some((f) => f.path.includes('Die Sims 4'))).toBe(false)
  })

  it('checks OneDriveConsumer and OneDriveCommercial and deduplicates by real path', async () => {
    const root = join(workDir, 'onedrive-dedupe')
    const consumerFolder = join(root, 'ConsumerOD/Documents/Electronic Arts/Die Sims 4')
    const commercialFolder = join(root, 'WorkOD/Documents/Electronic Arts/ザ・シムズ 4')
    await mkdir(consumerFolder, { recursive: true })
    await mkdir(commercialFolder, { recursive: true })
    await writeFile(join(consumerFolder, 'Options.ini'), '[options]\nmodsdisabled=0\n')
    await writeFile(join(commercialFolder, 'Options.ini'), '[options]\nmodsdisabled=0\n')

    // Symlink/junction local Documents to ConsumerOD/Documents to test real-path deduplication.
    const symlinkDocs = join(root, 'LinkedDocuments')
    await symlink(
      join(root, 'ConsumerOD/Documents'),
      symlinkDocs,
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const folders = await findUserFolders({
      documentsDir: symlinkDocs,
      env: {
        OneDrive: join(root, 'ConsumerOD'),
        OneDriveConsumer: join(root, 'ConsumerOD'),
        OneDriveCommercial: join(root, 'WorkOD')
      }
    })

    expect(folders).toHaveLength(2)
    expect(folders.every((f) => f.inOneDrive)).toBe(true)
    const paths = new Set(folders.map((f) => f.path))
    expect(paths).toEqual(new Set([await realpath(consumerFolder), await realpath(commercialFolder)]))
  })

  it('dates a folder by its newest file, not by folder mtimes that are newer than every file', async () => {
    const docs = join(workDir, 'dir-mtime/Documents')
    const simsFolder = join(docs, 'Electronic Arts/The Sims 4')
    await mkdir(join(simsFolder, 'saves'), { recursive: true })
    await writeFile(join(simsFolder, 'Options.ini'), '[options]\n')
    await writeFile(join(simsFolder, 'saves/Slot_00000002.save'), 'save')
    const fileTime = new Date('2026-10-01T12:00:00.000Z')
    const dirTime = new Date('2026-11-23T09:00:00.000Z')
    await utimes(join(simsFolder, 'Options.ini'), fileTime, fileTime)
    await utimes(join(simsFolder, 'saves/Slot_00000002.save'), fileTime, fileTime)
    await utimes(join(simsFolder, 'saves'), dirTime, dirTime)
    await utimes(simsFolder, dirTime, dirTime)

    const folders = await findUserFolders({ documentsDir: docs, env: {} })
    expect(folders.map((f) => f.newestFileAt)).toEqual([fileTime])
  })

  it('counts files reached through linked folders, and stops on a link back to the folder', async () => {
    const root = join(workDir, 'linked-saves')
    const docs = join(root, 'Documents')
    const simsFolder = join(docs, 'Electronic Arts/The Sims 4')
    const realSaves = join(root, 'elsewhere/saves')
    await mkdir(simsFolder, { recursive: true })
    await mkdir(realSaves, { recursive: true })
    await writeFile(join(simsFolder, 'Options.ini'), '[options]\n')
    await writeFile(join(realSaves, 'Slot_00000002.save'), 'save')
    const oldTime = new Date('2026-09-01T12:00:00.000Z')
    const saveTime = new Date('2026-11-22T20:00:00.000Z')
    await utimes(join(simsFolder, 'Options.ini'), oldTime, oldTime)
    await utimes(join(realSaves, 'Slot_00000002.save'), saveTime, saveTime)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(realSaves, join(simsFolder, 'saves'), linkType)
    await symlink(simsFolder, join(simsFolder, 'loop'), linkType)

    const folders = await findUserFolders({ documentsDir: docs, env: {} })
    expect(folders.map((f) => f.newestFileAt)).toEqual([saveTime])
  })

  it('reads version from PE first, then falls back to a messy binary-prefixed GameVersion.txt', async () => {
    const odRoot = fixtureDirs.get('onedrive')!
    const localStaleFolder = await realpath(join(odRoot, 'Users/Player/Documents/Electronic Arts/The Sims 4'))

    // Direct GameVersion.txt reader extracts 1.125.12.1030 past the binary prefix
    expect(await readGameVersionFromTxt(localStaleFolder)).toBe('1.125.12.1030')

    // PE file version wins over stale GameVersion.txt
    const hostWithPe = createFixtureHost(odRoot)
    const fromPe = await findGameInstall(hostWithPe, [
      { path: localStaleFolder, inOneDrive: false, newestFileAt: new Date('2026-09-10T10:00:00.000Z') }
    ])
    expect(fromPe?.version).toBe('1.129.39.1030')

    // When PE fileVersion returns undefined, falls back to the binary-prefixed GameVersion.txt
    const hostNoPe = createFixtureHost(odRoot, {
      fileVersion: async () => undefined
    })
    const fromTxt = await findGameInstall(hostNoPe, [
      { path: localStaleFolder, inOneDrive: false, newestFileAt: new Date('2026-09-10T10:00:00.000Z') }
    ])
    expect(fromTxt?.version).toBe('1.125.12.1030')

    // When neither source has a version, returns empty string
    const noVersion = await findGameInstall(hostNoPe, [])
    expect(noVersion?.version).toBe('')
  })

  it('prefers the registry Install Dir over default paths and falls back if registry path is missing', async () => {
    const cleanRoot = fixtureDirs.get('clean')!
    const dupRoot = fixtureDirs.get('duplicates')!
    const steamInstall = join(dupRoot, 'Program Files (x86)/Steam/steamapps/common/The Sims 4')

    const seenQueries: Array<[string, string]> = []
    const regHost = createFixtureHost(cleanRoot, {
      readRegistry: async (key, value) => {
        seenQueries.push([key, value])
        // Trailing slash like real reg.exe Install Dir output
        return `${steamInstall}/`
      }
    })

    const install = await findGameInstall(regHost)
    expect(seenQueries).toEqual([[SIMS_REGISTRY_KEY, SIMS_REGISTRY_VALUE]])
    expect(install?.path).toBe(steamInstall)

    // Stale registry path falls back to EA default inside cleanRoot
    const staleRegHost = createFixtureHost(cleanRoot, {
      readRegistry: async () => join(workDir, 'does-not-exist/The Sims 4')
    })
    const fallbackInstall = await findGameInstall(staleRegHost)
    expect(fallbackInstall?.path).toBe(join(cleanRoot, 'Program Files/EA Games/The Sims 4'))

    // No registry and no default installs returns null
    const emptyHost: Host = {
      documentsDir: join(workDir, 'empty/Documents'),
      env: {},
      readRegistry: async () => undefined,
      listProcesses: async () => [],
      fileVersion: async () => undefined
    }
    expect(await findGameInstall(emptyHost)).toBeNull()
  })

  it('filters pack directories strictly by ^[EGSF]P\\d{2,}$ and ignores Delta and non-directories', async () => {
    const installDir = join(workDir, 'pack-filter-test')
    for (const dir of [
      'EP01',
      'GP02',
      'SP18',
      'SP100',
      'FP01',
      'Data',
      'Delta',
      'Delta/EP15',
      'Delta/GP12',
      'Game',
      'XP01',
      'EP1',
      'EP01_backup',
      'ep02'
    ]) {
      await mkdir(join(installDir, dir), { recursive: true })
    }
    // A regular file named EP99 must not be treated as a pack folder
    await writeFile(join(installDir, 'EP99'), 'not a folder')

    expect(await listInstalledPacks(installDir)).toEqual(['EP01', 'FP01', 'GP02', 'SP100', 'SP18'])
  })

  it('detects all three Sims 4 game process names case-insensitively', async () => {
    expect(isSimsProcessName('TS4_x64')).toBe(true)
    expect(isSimsProcessName('TS4_x64.exe')).toBe(true)
    expect(isSimsProcessName('ts4_x64_fpb.EXE')).toBe(true)
    expect(isSimsProcessName('TS4_DX9_x64.exe')).toBe(true)
    expect(isSimsProcessName('TS4_x64_helper.exe')).toBe(false)
    expect(isSimsProcessName('explorer.exe')).toBe(false)

    expect(await checkGameRunning({ listProcesses: async () => ['explorer.exe', 'TS4_DX9_x64.exe'] })).toBe('running')
    expect(await checkGameRunning({ listProcesses: async () => ['explorer.exe', 'CurseForge.exe'] })).toBe('not-running')
  })

  it('parses Windows reg query output, tasklist CSV output, and invalid PE buffers safely', () => {
    const regStdout = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Maxis\\The Sims 4',
      '    Install Dir    REG_SZ    C:\\Program Files\\EA Games\\The Sims 4\\',
      ''
    ].join('\r\n')
    expect(parseRegQueryOutput(regStdout, 'Install Dir')).toBe('C:\\Program Files\\EA Games\\The Sims 4\\')
    expect(parseRegQueryOutput(regStdout, 'Missing')).toBeUndefined()

    const tasklistStdout = [
      '"System Idle Process","0","Services","0","8 K"',
      '"TS4_x64.exe","4820","Console","1","1,842,100 K"',
      'INFO: No tasks are running which match the specified criteria.'
    ].join('\r\n')
    expect(parseTasklistCsv(tasklistStdout)).toEqual(['System Idle Process', 'TS4_x64.exe'])

    expect(parsePeFileVersion(Buffer.from('not a PE file'))).toBeUndefined()
  })
})
