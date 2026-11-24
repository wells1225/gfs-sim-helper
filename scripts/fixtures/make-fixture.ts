import { mkdir, open, readdir, readFile, rm, utimes } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseHexUint32, parseHexUint64, writeDbpf } from './dbpf.ts'
import type { ResourceKey } from './dbpf.ts'
import { createRng } from './prng.ts'
import type { FixtureSpec, GameInstallSpec, UserFolderSpec } from './spec-types.ts'
import {
  renderBetterExceptionsHtml,
  renderConfigLog,
  renderCurseForgeAddonGameInstance,
  renderGameVersion,
  renderLastCrash,
  renderLastException,
  renderLastUiException,
  renderMcccLastExceptionHtml,
  renderOptionsIni,
  renderResourceCfg
} from './templates.ts'
import { makeDummyPyc, writeZip } from './zip.ts'

export interface GenerateResult {
  specName: string
  outDir: string
  fileCount: number
  elapsedMs: number
}

interface PlannedFile {
  relPath: string
  data: Buffer
  mtime: Date
}

const WRITE_CONCURRENCY = 64

const BULK_PACKAGE_CATEGORIES = [
  'CAS/Hair',
  'CAS/Tops',
  'CAS/Bottoms',
  'CAS/Shoes',
  'CAS/Accessories/Glasses',
  'CAS/SkinDetails/Presets/Eyebrows',
  'BuildBuy/Kitchen/Counters/Modern',
  'BuildBuy/LivingRoom/Sofas',
  'BuildBuy/Lighting/Lamps/Vintage/Wall',
  'BuildBuy/Clutter/Books/Desk/Tiny/Misc',
  'Gameplay/Traits',
  'Gameplay/Careers/Overrides'
] as const

const BULK_SCRIPT_CREATORS = [
  'Deaderpool',
  'TwistedMexi',
  'LittleMsSam',
  'Lumpinou',
  'Kuttoe',
  'Lot51',
  'Adeepindigo',
  'Pandasama',
  'Ravash',
  'Basemental'
] as const

const BULK_RESOURCE_TYPES = [
  0x03b33ddf, // Tuning XML
  0x545ac67a, // SimData
  0x034aeecb, // CASP
  0x220557da, // STBL
  0x319e4f1d // Object Catalog
] as const

function parseUtcDate(iso: string): Date {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO timestamp: ${iso}`)
  }
  return new Date(ms)
}

function joinPosix(...parts: string[]): string {
  return parts.map((p) => p.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
}

function parseKeys(keys: ReadonlyArray<{ type: string; group: string; instance: string }>): ResourceKey[] {
  return keys.map((k) => ({
    type: parseHexUint32(k.type),
    group: parseHexUint32(k.group),
    instance: parseHexUint64(k.instance)
  }))
}

function planGameInstall(install: GameInstallSpec, baseDate: Date, files: PlannedFile[]): void {
  const root = install.relPath

  // Stub Windows executable & base Data folder
  files.push({
    relPath: joinPosix(root, 'Game/Bin/TS4_x64.exe'),
    data: Buffer.from(`MZ-FIXTURE-TS4-EXE:${install.version}\n`, 'ascii'),
    mtime: baseDate
  })
  files.push({
    relPath: joinPosix(root, 'Data/Client/ClientFullBuild0.package'),
    data: writeDbpf({
      keys: [{ type: 0x220557da, group: 0x00000000, instance: 0x0000000000000001n }],
      seed: 101
    }),
    mtime: baseDate
  })

  for (let i = 0; i < install.packs.length; i += 1) {
    const pack = install.packs[i] as string
    files.push({
      relPath: joinPosix(root, pack, 'SimulationFullBuild0.package'),
      data: writeDbpf({
        keys: [{ type: 0x03b33ddf, group: i + 1, instance: BigInt(0x100000 + i) }],
        seed: 200 + i
      }),
      mtime: baseDate
    })
  }

  for (let i = 0; i < (install.deltaOnlyPacks ?? []).length; i += 1) {
    const pack = (install.deltaOnlyPacks as string[])[i] as string
    files.push({
      relPath: joinPosix(root, 'Delta', pack, 'SimulationDeltaBuild0.package'),
      data: writeDbpf({
        keys: [{ type: 0x03b33ddf, group: 0x80000000 + i, instance: BigInt(0x200000 + i) }],
        seed: 400 + i
      }),
      mtime: baseDate
    })
  }
}

function planUserFolder(
  folder: UserFolderSpec,
  baseDate: Date,
  specSeed: number,
  folderIndex: number,
  files: PlannedFile[],
  emptyDirs: Set<string>
): void {
  const root = folder.relPath
  const folderDate = folder.folderMtime ? parseUtcDate(folder.folderMtime) : baseDate
  const optionsDate = folder.optionsMtime ? parseUtcDate(folder.optionsMtime) : folderDate
  const versionDate = folder.gameVersionMtime ? parseUtcDate(folder.gameVersionMtime) : folderDate
  const thumbDate = folder.thumbCacheMtime ? parseUtcDate(folder.thumbCacheMtime) : folderDate
  const rng = createRng((specSeed ^ ((folderIndex + 1) * 0x9e3779b1)) >>> 0)

  // Core user files
  files.push({
    relPath: joinPosix(root, 'Options.ini'),
    data: Buffer.from(renderOptionsIni(folder.options), 'utf8'),
    mtime: optionsDate
  })
  files.push({
    relPath: joinPosix(root, 'GameVersion.txt'),
    data: Buffer.from(renderGameVersion(folder.gameVersion), 'utf8'),
    mtime: versionDate
  })
  files.push({
    relPath: joinPosix(root, 'Config.log'),
    data: Buffer.from(renderConfigLog(folder.gameVersion), 'utf8'),
    mtime: folderDate
  })

  // Mods/Resource.cfg
  files.push({
    relPath: joinPosix(root, 'Mods/Resource.cfg'),
    data: Buffer.from(renderResourceCfg(folder.resourceCfgDepth ?? 5), 'utf8'),
    mtime: folderDate
  })

  // saves/ (8-digit Slot_XXXXXXXX.save + rolling .ver0/.ver1)
  files.push({
    relPath: joinPosix(root, 'saves/Slot_00000002.save'),
    data: Buffer.concat([Buffer.from('SIMS4-FIXTURE-SAVE-00000002:', 'ascii'), rng.bytes(32)]),
    mtime: folderDate
  })
  files.push({
    relPath: joinPosix(root, 'saves/Slot_00000002.save.ver0'),
    data: Buffer.concat([Buffer.from('SIMS4-FIXTURE-SAVE-VER0:', 'ascii'), rng.bytes(32)]),
    mtime: new Date(folderDate.getTime() - 3600_000)
  })
  files.push({
    relPath: joinPosix(root, 'saves/Slot_00000002.save.ver1'),
    data: Buffer.concat([Buffer.from('SIMS4-FIXTURE-SAVE-VER1:', 'ascii'), rng.bytes(32)]),
    mtime: new Date(folderDate.getTime() - 7200_000)
  })

  // Tray/ (household set sharing one ID, no subfolders)
  const trayPrefix = '0x00000000!0x0001020304050607'
  for (const ext of ['trayitem', 'householdbinary', 'hhi', 'sgi']) {
    files.push({
      relPath: joinPosix(root, `Tray/${trayPrefix}.${ext}`),
      data: Buffer.concat([Buffer.from(`SIMS4-FIXTURE-TRAY-${ext}:`, 'ascii'), rng.bytes(16)]),
      mtime: folderDate
    })
  }

  // Caches
  files.push({
    relPath: joinPosix(root, 'localthumbcache.package'),
    data: writeDbpf({
      keys: [{ type: 0x3c1af1f2, group: 0x00000000, instance: 0x000000000000cafen }],
      seed: specSeed + 11
    }),
    mtime: thumbDate
  })
  files.push({
    relPath: joinPosix(root, 'avatarcache.package'),
    data: writeDbpf({
      keys: [{ type: 0x3c1af1f2, group: 0x00000000, instance: 0x000000000000beefn }],
      seed: specSeed + 12
    }),
    mtime: thumbDate
  })
  files.push({
    relPath: joinPosix(root, 'cachestr/spotlight_en-us.package'),
    data: writeDbpf({
      keys: [{ type: 0x220557da, group: 0x00000000, instance: 0x0000000000001001n }],
      seed: specSeed + 13
    }),
    mtime: thumbDate
  })
  emptyDirs.add(joinPosix(root, 'cache'))
  emptyDirs.add(joinPosix(root, 'onlinethumbnailcache'))

  // Explicit .package files
  for (let i = 0; i < (folder.packages ?? []).length; i += 1) {
    const pkg = (folder.packages as NonNullable<UserFolderSpec['packages']>)[i] as NonNullable<
      UserFolderSpec['packages']
    >[number]
    const keys = parseKeys(pkg.keys)
    const data = writeDbpf({
      keys,
      variant: pkg.variant ?? 'valid',
      constantFlags: pkg.constantFlags ?? 0,
      seed: pkg.payloadSeed ?? specSeed + 1000 + i
    })
    files.push({
      relPath: joinPosix(root, 'Mods', pkg.relPath),
      data,
      mtime: pkg.mtime ? parseUtcDate(pkg.mtime) : folderDate
    })
  }

  // Explicit .ts4script files
  for (let i = 0; i < (folder.scripts ?? []).length; i += 1) {
    const script = (folder.scripts as NonNullable<UserFolderSpec['scripts']>)[i] as NonNullable<
      UserFolderSpec['scripts']
    >[number]
    const scriptSeed = script.payloadSeed ?? specSeed + 2000 + i
    const entries = script.entries.map((entryName, entryIdx) => ({
      name: entryName,
      data: makeDummyPyc(entryName, scriptSeed + entryIdx * 31)
    }))
    files.push({
      relPath: joinPosix(root, 'Mods', script.relPath),
      data: writeZip(entries),
      mtime: script.mtime ? parseUtcDate(script.mtime) : folderDate
    })
  }

  // Explicit .zip archives dropped in Mods/
  for (const archive of folder.archives ?? []) {
    const entries = archive.entries.map((e) => ({
      name: e.name,
      data: Buffer.from(e.content, 'utf8')
    }))
    files.push({
      relPath: joinPosix(root, 'Mods', archive.relPath),
      data: writeZip(entries),
      mtime: archive.mtime ? parseUtcDate(archive.mtime) : folderDate
    })
  }

  // Extra loose files in Mods/
  for (const extra of folder.extraModFiles ?? []) {
    files.push({
      relPath: joinPosix(root, 'Mods', extra.relPath),
      data: Buffer.from(extra.content, 'utf8'),
      mtime: extra.mtime ? parseUtcDate(extra.mtime) : folderDate
    })
  }

  // Bulk generated mods (e.g. `big` fixture)
  if (folder.bulkMods) {
    const bulkRng = createRng((specSeed ^ 0x517cc1b7) >>> 0)
    const { packageCount, scriptCount, maxPackageDepth, maxScriptDepth } = folder.bulkMods

    const allowedCategories = BULK_PACKAGE_CATEGORIES.filter((cat) => {
      const depth = cat.split('/').length
      return depth <= maxPackageDepth
    })

    for (let i = 0; i < packageCount; i += 1) {
      const padded = String(i + 1).padStart(5, '0')
      const useRoot = i % 10 === 0 || allowedCategories.length === 0
      const relDir = useRoot ? '' : bulkRng.pick(allowedCategories)
      const fileName = `cc_item_${padded}.package`
      const relPath = relDir ? `${relDir}/${fileName}` : fileName

      const keyCount = 1 + (i % 3)
      const keys: ResourceKey[] = []
      for (let k = 0; k < keyCount; k += 1) {
        const type = BULK_RESOURCE_TYPES[(i + k) % BULK_RESOURCE_TYPES.length] as number
        const high = BigInt(0x00010000 + (i % 1024))
        const low = BigInt((i + 1) * 16 + k)
        keys.push({
          type,
          group: 0x00000000,
          instance: (high << 32n) | low
        })
      }

      const offsetSec = (i % 720) * 60
      const mtime = new Date(folderDate.getTime() - offsetSec * 1000)

      files.push({
        relPath: joinPosix(root, 'Mods', relPath),
        data: writeDbpf({
          keys,
          seed: specSeed + 10000 + i
        }),
        mtime
      })
    }

    for (let i = 0; i < scriptCount; i += 1) {
      const padded = String(i + 1).padStart(4, '0')
      const creator = BULK_SCRIPT_CREATORS[i % BULK_SCRIPT_CREATORS.length] as string
      const atRoot = maxScriptDepth === 0 || i % 5 === 0
      const relPath = atRoot ? `script_mod_${padded}.ts4script` : `${creator}/script_mod_${padded}.ts4script`
      const modPkg = `mod_${padded}`

      const entries = [
        { name: `${modPkg}/__init__.pyc`, data: makeDummyPyc(`${modPkg}/__init__.pyc`, specSeed + 50000 + i * 2) },
        { name: `${modPkg}/main.pyc`, data: makeDummyPyc(`${modPkg}/main.pyc`, specSeed + 50001 + i * 2) }
      ]

      const offsetSec = (i % 300) * 60
      const mtime = new Date(folderDate.getTime() - offsetSec * 1000)

      files.push({
        relPath: joinPosix(root, 'Mods', relPath),
        data: writeZip(entries),
        mtime
      })
    }
  }

  // Logs
  const logs = folder.logs
  if (logs) {
    for (const le of logs.lastExceptions ?? []) {
      files.push({
        relPath: joinPosix(root, le.fileName),
        data: Buffer.from(renderLastException(le), 'utf8'),
        mtime: le.mtime ? parseUtcDate(le.mtime) : folderDate
      })
    }
    for (const ui of logs.lastUiExceptions ?? []) {
      files.push({
        relPath: joinPosix(root, ui.fileName),
        data: Buffer.from(renderLastUiException(ui), 'utf8'),
        mtime: ui.mtime ? parseUtcDate(ui.mtime) : folderDate
      })
    }
    for (const crash of logs.lastCrashes ?? []) {
      files.push({
        relPath: joinPosix(root, crash.fileName),
        data: Buffer.from(renderLastCrash(crash), 'utf8'),
        mtime: crash.mtime ? parseUtcDate(crash.mtime) : folderDate
      })
    }
    for (const be of logs.betterExceptions ?? []) {
      files.push({
        relPath: joinPosix(root, be.fileName),
        data: Buffer.from(renderBetterExceptionsHtml(be), 'utf8'),
        mtime: be.mtime ? parseUtcDate(be.mtime) : folderDate
      })
    }
    for (const mccc of logs.mcccExceptions ?? []) {
      files.push({
        relPath: joinPosix(root, 'Mods', mccc.relPath),
        data: Buffer.from(renderMcccLastExceptionHtml(mccc), 'utf8'),
        mtime: mccc.mtime ? parseUtcDate(mccc.mtime) : folderDate
      })
    }
  }
}

/** A folder whose directories, and every directory below it, get `date` as their mtime. */
interface DirDate {
  relPath: string
  date: Date
}

async function writePlannedFiles(
  outDir: string,
  files: readonly PlannedFile[],
  emptyDirs: ReadonlySet<string>,
  baseDate: Date,
  dirDates: readonly DirDate[]
): Promise<void> {
  const leafDirs = new Set<string>([outDir])
  for (const dir of emptyDirs) {
    leafDirs.add(join(outDir, dir))
  }
  for (const file of files) {
    leafDirs.add(dirname(join(outDir, file.relPath)))
  }

  // Create unique leaf directories once before parallel file writes.
  for (const dir of leafDirs) {
    await mkdir(dir, { recursive: true })
  }

  // Collect every directory (including intermediate parents up to outDir) for deterministic mtimes.
  const allDirs = new Set<string>([outDir])
  for (const dir of leafDirs) {
    let current = dir
    while (current.length > outDir.length && !allDirs.has(current)) {
      allDirs.add(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  let nextIndex = 0
  const workerCount = Math.min(WRITE_CONCURRENCY, Math.max(1, files.length))

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex
      if (idx >= files.length) {
        return
      }
      nextIndex = idx + 1
      const item = files[idx] as PlannedFile
      const fullPath = join(outDir, item.relPath)
      const handle = await open(fullPath, 'w')
      try {
        await handle.writeFile(item.data)
        await handle.utimes(item.mtime, item.mtime)
      } finally {
        await handle.close()
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  // Set deterministic mtimes on all directories bottom-up. A directory inside a user folder
  // takes that folder's date, so a stale folder never looks newer than its files.
  const roots = dirDates
    .map((d) => ({ dir: join(outDir, d.relPath), date: d.date }))
    .sort((a, b) => b.dir.length - a.dir.length)
  const sortedDirs = [...allDirs].sort((a, b) => b.length - a.length)
  for (const dir of sortedDirs) {
    const root = roots.find((r) => dir === r.dir || dir.startsWith(r.dir + sep))
    const date = root ? root.date : baseDate
    await utimes(dir, date, date)
  }
}

export async function loadSpec(specPath: string): Promise<FixtureSpec> {
  const raw = await readFile(specPath, 'utf8')
  return JSON.parse(raw) as FixtureSpec
}

export async function generateFixture(spec: FixtureSpec, outDir: string): Promise<GenerateResult> {
  const start = performance.now()
  const resolvedOut = resolve(outDir)
  const baseDate = parseUtcDate(spec.baseTime)

  await rm(resolvedOut, { recursive: true, force: true })

  const files: PlannedFile[] = []
  const emptyDirs = new Set<string>()

  planGameInstall(spec.gameInstall, baseDate, files)

  for (let i = 0; i < spec.userFolders.length; i += 1) {
    const folder = spec.userFolders[i] as UserFolderSpec
    planUserFolder(folder, baseDate, spec.seed, i, files, emptyDirs)
  }

  if (spec.curseForge) {
    files.push({
      relPath: joinPosix(spec.curseForge.relPath),
      data: Buffer.from(renderCurseForgeAddonGameInstance(spec.curseForge), 'utf8'),
      mtime: baseDate
    })
  }

  const dirDates = spec.userFolders.map((folder) => ({
    relPath: folder.relPath,
    date: folder.folderMtime ? parseUtcDate(folder.folderMtime) : baseDate
  }))
  await writePlannedFiles(resolvedOut, files, emptyDirs, baseDate, dirDates)

  const elapsedMs = Math.round(performance.now() - start)
  return {
    specName: spec.name,
    outDir: resolvedOut,
    fileCount: files.length,
    elapsedMs
  }
}

export async function generateAllFixtures(options?: {
  specsDir?: string
  outRoot?: string
  names?: readonly string[]
}): Promise<GenerateResult[]> {
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(thisDir, '../..')
  const specsDir = options?.specsDir ?? join(thisDir, 'specs')
  const outRoot = options?.outRoot ?? join(repoRoot, 'test/fixtures')

  const entries = (await readdir(specsDir))
    .filter((name) => name.endsWith('.json'))
    .sort()

  const requested = options?.names && options.names.length > 0 ? new Set(options.names) : null
  const results: GenerateResult[] = []

  for (const fileName of entries) {
    const spec = await loadSpec(join(specsDir, fileName))
    if (requested && !requested.has(spec.name)) {
      continue
    }
    const result = await generateFixture(spec, join(outRoot, spec.name))
    results.push(result)
  }

  if (requested) {
    const built = new Set(results.map((r) => r.specName))
    for (const name of requested) {
      if (!built.has(name)) {
        throw new Error(`Unknown fixture spec: ${name}`)
      }
    }
  }

  return results
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (process.platform === 'win32') {
    return resolve(entry).toLowerCase() === resolve(fileURLToPath(metaUrl)).toLowerCase()
  }
  return pathToFileURL(resolve(entry)).href === metaUrl
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let outRoot: string | undefined
  const names: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--out' && i + 1 < args.length) {
      outRoot = args[i + 1]
      i += 1
    } else if (!arg.startsWith('-')) {
      names.push(arg)
    }
  }

  const totalStart = performance.now()
  const results = await generateAllFixtures({ outRoot, names })
  for (const r of results) {
    console.log(`fixture ${r.specName.padEnd(16)} ${String(r.fileCount).padStart(5)} files  ${r.elapsedMs} ms`)
  }
  const totalMs = Math.round(performance.now() - totalStart)
  console.log(`Generated ${results.length} fixture(s) in ${totalMs} ms`)
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
