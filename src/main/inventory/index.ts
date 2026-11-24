import { readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { FileHash, Inventory, IsoTime, ModFile, Progress, RelPath } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { OnProgress } from '../ports.ts'
import { readCurseForge } from './curseforge.ts'
import { readDbpfIndex, readDbpfSummary } from './dbpf.ts'
import { assignGroups } from './groups.ts'
import type { UngroupedModFile } from './groups.ts'
import { readResourceCfg } from './resource-cfg.ts'
import { listScriptEntries } from './scripts.ts'

export { readCurseForge } from './curseforge.ts'
export { readDbpfIndex } from './dbpf.ts'
export { readResourceCfg } from './resource-cfg.ts'
export { listScriptEntries } from './scripts.ts'

const MAX_CONCURRENCY = 8
const PROGRESS_INTERVAL_MS = 100
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z'])

interface DiscoveredFile {
  fullPath: string
  relPath: RelPath
  depth: number
  bytes: number
  modifiedAt: IsoTime
  kind: ModFile['kind']
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizePathKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePathKey(targetPath)
  const normRoot = normalizePathKey(rootPath).replace(/[\\/]+$/, '')
  return normTarget === normRoot || normTarget.startsWith(normRoot + sep)
}

function classifyKind(fileName: string): ModFile['kind'] {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.package') return 'package'
  if (ext === '.ts4script') return 'script'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
  return 'other'
}

function compareRelPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export async function buildInventory(input: {
  modsDir: string
  curseForgeInstanceFile: string | null
  onProgress?: OnProgress
}): Promise<Inventory> {
  const { modsDir, curseForgeInstanceFile, onProgress } = input

  let modsStat
  try {
    modsStat = await stat(modsDir)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        modsDir,
        modsDirState: 'missing',
        files: [],
        groups: [],
        resourceCfg: { status: 'missing' },
        curseForge: await readCurseForge(curseForgeInstanceFile),
        skipped: []
      }
    }
    return {
      modsDir,
      modsDirState: 'present',
      files: [],
      groups: [],
      resourceCfg: { status: 'unreadable', detail: formatError(err) },
      curseForge: await readCurseForge(curseForgeInstanceFile),
      skipped: [{ relPath: '', detail: formatError(err) }]
    }
  }

  if (!modsStat.isDirectory()) {
    return {
      modsDir,
      modsDirState: 'missing',
      files: [],
      groups: [],
      resourceCfg: { status: 'missing' },
      curseForge: await readCurseForge(curseForgeInstanceFile),
      skipped: []
    }
  }

  const [resourceCfg, curseForge, modsRealRoot] = await Promise.all([
    readResourceCfg(modsDir),
    readCurseForge(curseForgeInstanceFile),
    realpath(modsDir).catch(() => resolve(modsDir))
  ])

  let lastProgressAt = -Infinity
  const emitProgress = (progress: Progress, force = false): void => {
    if (!onProgress) return
    const now = performance.now()
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
    lastProgressAt = now
    onProgress(progress)
  }

  const discovered: DiscoveredFile[] = []
  const skipped: { relPath: RelPath; detail: string }[] = []
  const visitedDirs = new Set<string>([normalizePathKey(modsRealRoot)])

  emitProgress({ task: 'scan', stage: 'counting', done: 0, total: null }, true)

  async function walk(dirPath: string, relDir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch (err) {
      skipped.push({ relPath: relDir, detail: formatError(err) })
      return
    }

    // Walk real entries before symlinks so an alias never shadows a canonical directory path.
    entries.sort((a, b) => {
      const aLink = a.isSymbolicLink() ? 1 : 0
      const bLink = b.isSymbolicLink() ? 1 : 0
      if (aLink !== bLink) return aLink - bLink
      return compareRelPath(a.name, b.name)
    })

    for (const entry of entries) {
      if (depth === 0 && entry.name.toLowerCase() === 'resource.cfg') {
        continue
      }

      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const fullPath = join(dirPath, entry.name)

      if (entry.isSymbolicLink()) {
        let targetReal: string
        try {
          targetReal = await realpath(fullPath)
        } catch (err) {
          skipped.push({ relPath, detail: formatError(err) })
          continue
        }

        if (!isInsideRoot(targetReal, modsRealRoot)) {
          skipped.push({ relPath, detail: 'Link points outside Mods folder' })
          continue
        }

        let info
        try {
          info = await stat(fullPath)
        } catch (err) {
          skipped.push({ relPath, detail: formatError(err) })
          continue
        }

        if (info.isDirectory()) {
          const dirKey = normalizePathKey(targetReal)
          if (visitedDirs.has(dirKey)) continue
          visitedDirs.add(dirKey)
          await walk(fullPath, relPath, depth + 1)
        } else if (info.isFile()) {
          discovered.push({
            fullPath,
            relPath,
            depth,
            bytes: info.size,
            modifiedAt: info.mtime.toISOString(),
            kind: classifyKind(entry.name)
          })
          emitProgress({ task: 'scan', stage: 'counting', done: discovered.length, total: null })
        }
        continue
      }

      if (entry.isDirectory()) {
        let targetReal: string
        try {
          targetReal = await realpath(fullPath)
        } catch (err) {
          skipped.push({ relPath, detail: formatError(err) })
          continue
        }

        if (!isInsideRoot(targetReal, modsRealRoot)) {
          skipped.push({ relPath, detail: 'Folder resolves outside Mods folder' })
          continue
        }

        const dirKey = normalizePathKey(targetReal)
        if (visitedDirs.has(dirKey)) continue
        visitedDirs.add(dirKey)
        await walk(fullPath, relPath, depth + 1)
        continue
      }

      if (entry.isFile()) {
        let info
        try {
          info = await stat(fullPath)
        } catch (err) {
          skipped.push({ relPath, detail: formatError(err) })
          continue
        }

        discovered.push({
          fullPath,
          relPath,
          depth,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          kind: classifyKind(entry.name)
        })
        emitProgress({ task: 'scan', stage: 'counting', done: discovered.length, total: null })
      }
    }
  }

  await walk(modsDir, '', 0)

  discovered.sort((a, b) => compareRelPath(a.relPath, b.relPath))
  skipped.sort((a, b) => compareRelPath(a.relPath, b.relPath))

  const sizeCounts = new Map<number, number>()
  for (const item of discovered) {
    sizeCounts.set(item.bytes, (sizeCounts.get(item.bytes) ?? 0) + 1)
  }

  const total = discovered.length
  const ungrouped: UngroupedModFile[] = new Array(total)
  let nextIndex = 0
  let doneCount = 0
  let emittedModsStage = false

  const emitModsProgress = (force = false): void => {
    if (!onProgress) return
    const now = performance.now()
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
    lastProgressAt = now
    emittedModsStage = true
    onProgress({ task: 'scan', stage: 'mods', done: doneCount, total })
  }

  const workerCount = Math.min(MAX_CONCURRENCY, total)
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex
      if (idx >= total) return
      nextIndex = idx + 1

      const item = discovered[idx]!
      const needsHash = (sizeCounts.get(item.bytes) ?? 0) > 1

      let base: UngroupedModFile
      if (item.kind === 'package') {
        const dbpf = await readDbpfSummary(item.fullPath)
        const hash = await maybeHash(item.fullPath, needsHash)
        base = {
          relPath: item.relPath,
          bytes: item.bytes,
          modifiedAt: item.modifiedAt,
          hash,
          depth: item.depth,
          kind: 'package',
          dbpf
        }
      } else if (item.kind === 'script') {
        const script = await listScriptEntries(item.fullPath)
        const hash = await maybeHash(item.fullPath, needsHash)
        base = {
          relPath: item.relPath,
          bytes: item.bytes,
          modifiedAt: item.modifiedAt,
          hash,
          depth: item.depth,
          kind: 'script',
          script
        }
      } else if (item.kind === 'archive') {
        const hash = await maybeHash(item.fullPath, needsHash)
        base = {
          relPath: item.relPath,
          bytes: item.bytes,
          modifiedAt: item.modifiedAt,
          hash,
          depth: item.depth,
          kind: 'archive'
        }
      } else {
        const hash = await maybeHash(item.fullPath, needsHash)
        base = {
          relPath: item.relPath,
          bytes: item.bytes,
          modifiedAt: item.modifiedAt,
          hash,
          depth: item.depth,
          kind: 'other'
        }
      }

      ungrouped[idx] = base
      doneCount += 1
      emitModsProgress(false)
    }
  }

  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  if (!emittedModsStage || doneCount === total) {
    emitModsProgress(true)
  }

  const { files, groups } = assignGroups(ungrouped, curseForge)

  return {
    modsDir,
    modsDirState: 'present',
    files,
    groups,
    resourceCfg,
    curseForge,
    skipped
  }
}

async function maybeHash(filePath: string, needed: boolean): Promise<FileHash> {
  if (!needed) {
    return { status: 'not-needed' }
  }
  try {
    const sha256 = await sha256File(filePath)
    return { status: 'hashed', sha256 }
  } catch (err) {
    return { status: 'unreadable', detail: formatError(err) }
  }
}
