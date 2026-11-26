import { lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { BackupPruneResult, BackupStatus, BackupSummary, JournalEntry } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import type { GateResult, SafetyDeps, WriteOp } from '../ports.ts'
import { backupInFlight, backupStatus as checkBackup, storedCopiesInPlace } from './backup.ts'
import { findEntry } from './journal.ts'
import { isNewer, manifestFile, readManifest, storedFile } from './manifest.ts'
import type { Manifest } from './manifest.ts'
import { isSafeId, pathKey, resolveDeepest } from './where.ts'

const KEEP_VERIFIED_PER_FOLDER = 2
const OPS_PER_REQUEST = 200
const COPYING_GRACE_MS = 60 * 60 * 1000
const TMP_MARKER = '.sims-helper-tmp'
const PRUNE_FAILED_DETAIL = 'Could not finish clearing old safety copies.'

function trimTrailingSep(target: string): string {
  return target.length > 1 ? target.replace(/[\\/]+$/, '') : target
}

function caseKey(target: string): string {
  return pathKey(trimTrailingSep(target)).toLowerCase()
}

function idKey(id: string): string {
  return id.toLowerCase()
}

function isInsideCase(child: string, parent: string): boolean {
  const rel = relative(caseKey(parent), caseKey(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isMissingErr(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

interface ScannedFile {
  abs: string
  bytes: number
}

interface ScannedSubDir {
  abs: string
  depth: number
}

interface ScannedBackupDir {
  name: string
  abs: string
  filesDir: string
  manifestPath: string | null
  manifestBytes: number
  manifest: Manifest | null
  files: ScannedFile[]
  subDirs: ScannedSubDir[]
}

interface ScannedHoldingDir {
  name: string
  abs: string
  totalFileBytes: number
  modsFileCount: number
}

type PrunePlan =
  | {
      safe: false
      verifiedCount: number
      totalBytes: number
    }
  | {
      safe: true
      verifiedCount: number
      totalBytes: number
      reclaimableBytes: number
      reclaimableBackups: number
      phase1ManifestPaths: string[]
      phase2DonorFilePaths: string[]
      phase2DonorEmptyDirsByDepth: string[][]
      phase2DeadBackupDirs: string[]
      phase3HoldingDirs: string[]
    }

function isValidManifest(manifest: Manifest | null): manifest is Manifest {
  if (!manifest) return false
  const rec = manifest.record
  return (
    typeof rec.folderPath === 'string' &&
    rec.folderPath.length > 0 &&
    typeof rec.at === 'string' &&
    (rec.state === 'verified' || rec.state === 'copying' || rec.state === 'failed')
  )
}

async function scanJournalStrict(journalDir: string): Promise<JournalEntry[] | null> {
  try {
    const dirInfo = await lstat(journalDir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return []
    return null
  }

  let names: string[]
  try {
    names = await readdir(journalDir)
  } catch {
    return null
  }

  const entries: JournalEntry[] = []
  for (const name of names) {
    if (name.includes(TMP_MARKER) || !name.endsWith('.json')) return null
    let info
    try {
      info = await lstat(join(journalDir, name))
    } catch {
      return null
    }
    if (info.isSymbolicLink() || !info.isFile()) return null

    const id = name.slice(0, -'.json'.length)
    if (!isSafeId(id)) return null
    const found = await findEntry(journalDir, id)
    if (found === 'unreadable' || found === 'missing') return null
    if (found.backupId !== null && (typeof found.backupId !== 'string' || (found.backupId !== '' && !isSafeId(found.backupId)))) {
      return null
    }
    entries.push(found)
  }
  return entries
}

async function walkFilesDirStrict(
  rootFilesDir: string
): Promise<{ files: ScannedFile[]; subDirs: ScannedSubDir[] } | null> {
  const files: ScannedFile[] = []
  const subDirs: ScannedSubDir[] = []

  async function walk(dir: string, depth: number): Promise<boolean> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if (depth === 0 && (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true
      return false
    }
    names.sort()
    for (const name of names) {
      if (name.includes(TMP_MARKER)) return false
      const full = join(dir, name)
      let info
      try {
        info = await lstat(full)
      } catch {
        return false
      }
      if (info.isSymbolicLink()) return false
      if (info.isDirectory()) {
        subDirs.push({ abs: full, depth: depth + 1 })
        if (!(await walk(full, depth + 1))) return false
      } else if (info.isFile()) {
        files.push({ abs: full, bytes: info.size })
      } else {
        return false
      }
    }
    return true
  }

  const ok = await walk(rootFilesDir, 0)
  return ok ? { files, subDirs } : null
}

async function scanBackupsStrict(backupsDir: string): Promise<ScannedBackupDir[] | null> {
  try {
    const dirInfo = await lstat(backupsDir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return []
    return null
  }

  let dirNames: string[]
  try {
    dirNames = await readdir(backupsDir)
  } catch {
    return null
  }
  dirNames.sort()

  const result: ScannedBackupDir[] = []
  for (const name of dirNames) {
    if (name.includes(TMP_MARKER) || !isSafeId(name)) return null
    const abs = join(backupsDir, name)
    let info
    try {
      info = await lstat(abs)
    } catch {
      return null
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return null

    let children: string[]
    try {
      children = await readdir(abs)
    } catch {
      return null
    }
    for (const child of children) {
      if (child.includes(TMP_MARKER)) return null
      if (child !== 'manifest.json' && child !== 'files') return null
      let childInfo
      try {
        childInfo = await lstat(join(abs, child))
      } catch {
        return null
      }
      if (childInfo.isSymbolicLink()) return null
      if (child === 'manifest.json' && !childInfo.isFile()) return null
      if (child === 'files' && !childInfo.isDirectory()) return null
    }

    const mPath = manifestFile(backupsDir, name)
    let manifestPath: string | null = null
    let manifestBytes = 0
    let manifest: Manifest | null = null

    let mStat = null
    try {
      mStat = await lstat(mPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return null
    }
    if (mStat !== null) {
      if (mStat.isSymbolicLink() || !mStat.isFile()) return null
      manifestPath = mPath
      manifestBytes = mStat.size
      const loaded = await readManifest(backupsDir, name)
      if (!isValidManifest(loaded)) return null
      manifest = loaded
    }

    const filesDir = join(abs, 'files')
    const walked = await walkFilesDirStrict(filesDir)
    if (walked === null) return null

    result.push({
      name,
      abs,
      filesDir,
      manifestPath,
      manifestBytes,
      manifest,
      files: walked.files,
      subDirs: walked.subDirs
    })
  }
  return result
}

async function scanHoldingStrict(holdingDir: string): Promise<ScannedHoldingDir[] | null> {
  try {
    const dirInfo = await lstat(holdingDir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return []
    return null
  }

  let dirNames: string[]
  try {
    dirNames = await readdir(holdingDir)
  } catch {
    return null
  }
  dirNames.sort()

  const result: ScannedHoldingDir[] = []
  for (const name of dirNames) {
    if (name.includes(TMP_MARKER) || !isSafeId(name)) return null
    const abs = join(holdingDir, name)
    let info
    try {
      info = await lstat(abs)
    } catch {
      return null
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return null

    let totalFileBytes = 0
    let modsFileCount = 0

    async function walkHold(cur: string, inMods: boolean, topLevel: boolean): Promise<boolean> {
      let names: string[]
      try {
        names = await readdir(cur)
      } catch {
        return false
      }
      for (const child of names) {
        if (child.includes(TMP_MARKER)) return false
        const childAbs = join(cur, child)
        let cInfo
        try {
          cInfo = await lstat(childAbs)
        } catch {
          return false
        }
        if (cInfo.isSymbolicLink()) return false
        const childInMods = inMods || (topLevel && child.toLowerCase() === 'mods')
        if (cInfo.isDirectory()) {
          if (!(await walkHold(childAbs, childInMods, false))) return false
        } else if (cInfo.isFile()) {
          totalFileBytes += cInfo.size
          if (childInMods) modsFileCount += 1
        } else {
          return false
        }
      }
      return true
    }

    if (!(await walkHold(abs, false, true))) return null
    result.push({ name, abs, totalFileBytes, modsFileCount })
  }
  return result
}

function isActiveJournalEntry(entry: JournalEntry): boolean {
  return (
    entry.status === 'in-progress' ||
    entry.status === 'needs-attention' ||
    (entry.status === 'done' && entry.undo === 'can-undo')
  )
}

function stepTouchesHoldingDir(entry: JournalEntry, holdingEntryAbs: string): boolean {
  if (entry.status === 'undone') return false
  for (const step of entry.steps) {
    if (step.state === 'reverted') continue
    if (step.kind === 'move') {
      if (isInsideCase(step.from, holdingEntryAbs) || isInsideCase(step.to, holdingEntryAbs)) return true
    } else if (step.kind === 'edit') {
      if (isInsideCase(step.savedCopy, holdingEntryAbs)) return true
    }
  }
  return false
}

async function verifySettledHoldingMovesSafe(
  entries: readonly JournalEntry[],
  holdingEntryAbs: string
): Promise<'safe' | 'keep' | 'unsafe'> {
  for (const entry of entries) {
    for (const step of entry.steps) {
      if (step.kind !== 'move' || !isInsideCase(step.to, holdingEntryAbs)) continue
      let toInfo = null
      try {
        toInfo = await lstat(step.to)
      } catch (err) {
        if (!isMissingErr(err)) return 'unsafe'
      }
      if (toInfo === null) continue
      if (toInfo.isSymbolicLink()) return 'unsafe'
      if (!toInfo.isFile()) return 'keep'

      let fromInfo = null
      try {
        fromInfo = await lstat(step.from)
      } catch (err) {
        if (isMissingErr(err)) return 'keep'
        return 'unsafe'
      }
      if (fromInfo.isSymbolicLink() || !fromInfo.isFile() || fromInfo.size !== step.bytes) return 'keep'

      const [realTo, realFrom] = await Promise.all([resolveDeepest(step.to), resolveDeepest(step.from)])
      if (caseKey(realTo) === caseKey(realFrom)) return 'keep'

      let fromSha: string
      try {
        fromSha = await sha256File(step.from)
      } catch {
        return 'keep'
      }
      if (fromSha !== step.sha256) return 'keep'
    }
  }
  return 'safe'
}

async function planPrune(deps: SafetyDeps): Promise<PrunePlan> {
  const { journalDir, backupsDir, holdingDir } = deps.paths
  const [journalEntries, backupDirs, holdingDirs] = await Promise.all([
    scanJournalStrict(journalDir),
    scanBackupsStrict(backupsDir),
    scanHoldingStrict(holdingDir)
  ])

  if (journalEntries === null || backupDirs === null || holdingDirs === null) {
    return { safe: false, verifiedCount: 0, totalBytes: 0 }
  }

  let backupsTotalBytes = 0
  let verifiedCount = 0
  for (const b of backupDirs) {
    backupsTotalBytes += b.manifestBytes + b.files.reduce((sum, f) => sum + f.bytes, 0)
    if (b.manifest?.record.state === 'verified') verifiedCount += 1
  }

  const protectedManifestIds = new Set<string>()
  const protectedWholeBackupDirs = new Set<string>()

  // 1. Group verified manifests by Sims folder (case-insensitive) and protect newest 2 + newest intact
  const verifiedByFolder = new Map<string, Manifest[]>()
  for (const b of backupDirs) {
    if (b.manifest?.record.state === 'verified') {
      const fKey = caseKey(b.manifest.record.folderPath)
      const list = verifiedByFolder.get(fKey) ?? []
      list.push(b.manifest)
      verifiedByFolder.set(fKey, list)
    }
  }

  for (const group of verifiedByFolder.values()) {
    group.sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0))
    for (const m of group.slice(0, KEEP_VERIFIED_PER_FOLDER)) {
      protectedManifestIds.add(idKey(m.record.id))
    }
    for (const m of group) {
      let intact: boolean
      try {
        intact = await storedCopiesInPlace(backupsDir, m.files)
      } catch {
        return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
      }
      if (intact) {
        protectedManifestIds.add(idKey(m.record.id))
        break
      }
    }
  }

  // 2. Active journal entries protect their backupId (and whole dir if manifest is missing)
  for (const entry of journalEntries) {
    if (isActiveJournalEntry(entry) && entry.backupId !== null && entry.backupId !== '') {
      protectedManifestIds.add(idKey(entry.backupId))
      protectedWholeBackupDirs.add(idKey(entry.backupId))
    }
  }

  // 3. Protect 'copying' manifests whose timestamp is unparseable, future, or within 1 hour of clock.now()
  const nowMs = deps.clock.now().getTime()
  for (const b of backupDirs) {
    if (b.manifest?.record.state === 'copying') {
      const atMs = Date.parse(b.manifest.record.at)
      if (!Number.isFinite(nowMs) || !Number.isFinite(atMs) || atMs > nowMs || nowMs - atMs <= COPYING_GRACE_MS) {
        protectedManifestIds.add(idKey(b.manifest.record.id))
      }
    }
  }

  // Build storedIn closure across all protected manifests
  const protectedStoredKeys = new Set<string>()
  for (const b of backupDirs) {
    if (b.manifest && protectedManifestIds.has(idKey(b.manifest.record.id))) {
      for (const line of b.manifest.files) {
        protectedStoredKeys.add(caseKey(storedFile(backupsDir, line)))
      }
    }
  }

  let reclaimableBytes = 0
  let reclaimableBackups = 0
  const phase1ManifestPaths: string[] = []
  const phase2DonorFilePaths: string[] = []
  const donorDirsByDepthMap = new Map<number, string[]>()
  const phase2DeadBackupDirs: string[] = []

  for (const b of backupDirs) {
    const bKey = idKey(b.name)
    if (protectedManifestIds.has(bKey) || protectedWholeBackupDirs.has(bKey)) {
      continue
    }

    const protectedFiles = b.files.filter((f) => protectedStoredKeys.has(caseKey(f.abs)))
    const unreferencedFiles = b.files.filter((f) => !protectedStoredKeys.has(caseKey(f.abs)))

    if (protectedFiles.length > 0) {
      // Storage donor: remove manifest in Phase 1, unreferenced files & empty leaf dirs in Phase 2
      if (b.manifestPath !== null) {
        phase1ManifestPaths.push(b.manifestPath)
        reclaimableBytes += b.manifestBytes
        reclaimableBackups += 1
      }
      for (const f of unreferencedFiles) {
        phase2DonorFilePaths.push(f.abs)
        reclaimableBytes += f.bytes
      }

      const protectedAncestors = new Set<string>()
      const filesDirKey = caseKey(b.filesDir)
      for (const pf of protectedFiles) {
        let cur = dirname(pf.abs)
        while (isInsideCase(cur, b.filesDir) && caseKey(cur) !== filesDirKey) {
          protectedAncestors.add(caseKey(cur))
          const parent = dirname(cur)
          if (parent === cur) break
          cur = parent
        }
      }

      for (const sub of b.subDirs) {
        if (!protectedAncestors.has(caseKey(sub.abs))) {
          const list = donorDirsByDepthMap.get(sub.depth) ?? []
          list.push(sub.abs)
          donorDirsByDepthMap.set(sub.depth, list)
        }
      }
    } else {
      // Dead backup dir: manifest in Phase 1, whole backup dir in Phase 2
      if (b.manifestPath !== null) {
        phase1ManifestPaths.push(b.manifestPath)
        reclaimableBackups += 1
      }
      phase2DeadBackupDirs.push(b.abs)
      reclaimableBytes += b.manifestBytes + b.files.reduce((sum, f) => sum + f.bytes, 0)
    }
  }

  const depthsDesc = [...donorDirsByDepthMap.keys()].sort((a, b) => b - a)
  const phase2DonorEmptyDirsByDepth = depthsDesc.map((d) => donorDirsByDepthMap.get(d)!)

  // Holding directories
  const entriesById = new Map<string, JournalEntry>(journalEntries.map((e) => [idKey(e.id), e]))
  let eligibleHoldingBytes = 0
  const phase3HoldingDirs: string[] = []

  for (const h of holdingDirs) {
    const matching = entriesById.get(idKey(h.name))
    if (matching && isActiveJournalEntry(matching)) continue
    if (journalEntries.some((entry) => stepTouchesHoldingDir(entry, h.abs))) continue

    if (matching !== undefined) {
      const check = await verifySettledHoldingMovesSafe(journalEntries, h.abs)
      if (check === 'unsafe') {
        return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
      }
      if (check === 'keep') continue
    } else {
      if (h.modsFileCount > 0) continue
    }

    phase3HoldingDirs.push(h.abs)
    eligibleHoldingBytes += h.totalFileBytes
    reclaimableBytes += h.totalFileBytes
  }

  return {
    safe: true,
    verifiedCount,
    totalBytes: backupsTotalBytes + eligibleHoldingBytes,
    reclaimableBytes,
    reclaimableBackups,
    phase1ManifestPaths,
    phase2DonorFilePaths,
    phase2DonorEmptyDirsByDepth,
    phase2DeadBackupDirs,
    phase3HoldingDirs
  }
}

function hasAnyPlannedOps(plan: Extract<PrunePlan, { safe: true }>): boolean {
  return (
    plan.reclaimableBytes > 0 ||
    plan.phase1ManifestPaths.length > 0 ||
    plan.phase2DonorFilePaths.length > 0 ||
    plan.phase2DonorEmptyDirsByDepth.some((level) => level.length > 0) ||
    plan.phase2DeadBackupDirs.length > 0 ||
    plan.phase3HoldingDirs.length > 0
  )
}

async function resolveFolderBackupStatus(deps: SafetyDeps, folderPath: string | null): Promise<BackupStatus> {
  if (!folderPath) return { state: 'none' }
  return await checkBackup(deps, folderPath)
}

export async function readBackupSummary(deps: SafetyDeps, folderPath: string | null): Promise<BackupSummary> {
  const [status, plan] = await Promise.all([resolveFolderBackupStatus(deps, folderPath), planPrune(deps)])
  if (!plan.safe) {
    return {
      status,
      verifiedCount: plan.verifiedCount,
      totalBytes: plan.totalBytes,
      reclaimableBytes: 0,
      reclaimableBackups: 0,
      canPrune: false
    }
  }
  const canPrune = !backupInFlight(deps) && hasAnyPlannedOps(plan)
  return {
    status,
    verifiedCount: plan.verifiedCount,
    totalBytes: plan.totalBytes,
    reclaimableBytes: plan.reclaimableBytes,
    reclaimableBackups: plan.reclaimableBackups,
    canPrune
  }
}

async function runRemoveChunks(
  deps: SafetyDeps,
  paths: readonly string[]
): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (let start = 0; start < paths.length; start += OPS_PER_REQUEST) {
    const ops: WriteOp[] = paths.slice(start, start + OPS_PER_REQUEST).map((path) => ({ op: 'remove', path }))
    let result: GateResult
    try {
      result = await deps.gate.run({ reason: 'backup', folderPath: null, ops })
    } catch {
      return { ok: false, detail: PRUNE_FAILED_DETAIL }
    }
    if (result.status !== 'done') {
      return { ok: false, detail: PRUNE_FAILED_DETAIL }
    }
  }
  return { ok: true }
}

export async function pruneBackupsNow(deps: SafetyDeps, folderPath: string | null): Promise<BackupPruneResult> {
  if (backupInFlight(deps)) return { status: 'refused', why: 'busy' }

  const plan = await planPrune(deps)
  if (!plan.safe) return { status: 'refused', why: 'unsafe-state' }
  if (!hasAnyPlannedOps(plan)) return { status: 'refused', why: 'nothing-to-prune' }

  // Phase 1: remove non-root manifest.json files FIRST before touching any stored file
  const phase1 = await runRemoveChunks(deps, plan.phase1ManifestPaths)
  if (!phase1.ok) return { status: 'failed', detail: phase1.detail }

  // Phase 2a: remove unreferenced files inside Storage Donor backups
  const phase2Files = await runRemoveChunks(deps, plan.phase2DonorFilePaths)
  if (!phase2Files.ok) return { status: 'failed', detail: phase2Files.detail }

  // Phase 2b: remove now-empty leaf subdirectories inside Storage Donors bottom-up after verifying readdir is empty
  for (const dirsAtDepth of plan.phase2DonorEmptyDirsByDepth) {
    const verifiedEmpty: string[] = []
    for (const dir of dirsAtDepth) {
      try {
        const entries = await readdir(dir)
        if (entries.length === 0) verifiedEmpty.push(dir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue
        return { status: 'failed', detail: PRUNE_FAILED_DETAIL }
      }
    }
    const phase2Dirs = await runRemoveChunks(deps, verifiedEmpty)
    if (!phase2Dirs.ok) return { status: 'failed', detail: phase2Dirs.detail }
  }

  // Phase 2c: remove whole Dead backup directories
  const phase2Dead = await runRemoveChunks(deps, plan.phase2DeadBackupDirs)
  if (!phase2Dead.ok) return { status: 'failed', detail: phase2Dead.detail }

  // Phase 3: remove eligible settled holding directories
  const phase3 = await runRemoveChunks(deps, plan.phase3HoldingDirs)
  if (!phase3.ok) return { status: 'failed', detail: phase3.detail }

  const summary = await readBackupSummary(deps, folderPath)
  return {
    status: 'done',
    freedBytes: plan.reclaimableBytes,
    removedBackups: plan.reclaimableBackups,
    summary
  }
}
