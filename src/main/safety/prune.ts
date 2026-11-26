import { lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import type { BackupPruneResult, BackupStatus, BackupSummary, JournalEntry, JournalStep } from '../../shared/model.ts'
import { openForRead, sha256File } from '../fs-read.ts'
import type { GateResult, SafetyDeps, WriteOp } from '../ports.ts'
import { backupInFlight, backupStatus as checkBackup, storedCopiesInPlace } from './backup.ts'
import { findEntry } from './journal.ts'
import { isNewer, isStrictIsoTime, manifestFile, readManifest, storedFile } from './manifest.ts'
import type { Manifest, ManifestFile } from './manifest.ts'
import { isSafeId, pathKey, resolveDeepest } from './where.ts'

const KEEP_VERIFIED_PER_FOLDER = 2
const OPS_PER_REQUEST = 200
const COPYING_GRACE_MS = 60 * 60 * 1000
const TMP_MARKER = '.sims-helper-tmp'
const PRUNE_FAILED_DETAIL = 'Could not finish clearing old safety copies.'
const PROBE_BYTE = new Uint8Array(1)

function trimTrailingSep(target: string): string {
  const winDrive = /^[A-Za-z]:[\\/]/.exec(target)
  if (winDrive) {
    const root = winDrive[0]
    const rest = target.slice(root.length).replace(/[\\/]+$/, '')
    return root + rest
  }
  const { root } = parse(target)
  return root + target.slice(root.length).replace(/[\\/]+$/, '')
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

function isNonEmptyAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
}

async function canReadFilePayload(file: string): Promise<boolean> {
  let handle
  try {
    handle = await openForRead(file)
  } catch {
    return false
  }
  try {
    if (handle.size > 0) {
      await handle.read(PROBE_BYTE, 0, 1)
    }
    return true
  } catch {
    return false
  } finally {
    await handle.close().catch(() => {})
  }
}

interface ScannedFile {
  abs: string
  realAbs: string
  canonicalKey: string
  bytes: number
}

interface ScannedSubDir {
  abs: string
  canonicalKey: string
  depth: number
}

interface ScannedBackupDir {
  name: string
  abs: string
  filesDir: string
  filesDirReal: string | null
  filesDirCanonicalKey: string | null
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
}

interface EligibleHoldingTarget {
  abs: string
  matching: JournalEntry
  totalFileBytes: number
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
      reclaimableBackupBytes: number
      reclaimableBytes: number
      reclaimableBackups: number
      journalEntries: JournalEntry[]
      phase1ManifestPaths: string[]
      phase2DonorFilePaths: string[]
      phase2DonorEmptyDirsByDepth: string[][]
      phase2DeadBackupDirs: string[]
      phase3HoldingTargets: EligibleHoldingTarget[]
    }

function isValidManifest(manifest: Manifest | null): manifest is Manifest {
  if (!manifest) return false
  const rec = manifest.record
  return (
    typeof rec.folderPath === 'string' &&
    rec.folderPath.length > 0 &&
    isStrictIsoTime(rec.at) &&
    (rec.state === 'verified' || rec.state === 'copying' || rec.state === 'failed')
  )
}

function isValidStepState(state: unknown): state is JournalStep['state'] {
  return state === 'pending' || state === 'applied' || state === 'reverted'
}

function isValidJournalStep(raw: unknown): raw is JournalStep {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const step = raw as Record<string, unknown>
  if (!isValidStepState(step.state)) return false
  if (step.kind === 'move') {
    return (
      isNonEmptyAbsolutePath(step.from) &&
      isNonEmptyAbsolutePath(step.to) &&
      typeof step.bytes === 'number' &&
      Number.isFinite(step.bytes) &&
      step.bytes >= 0 &&
      typeof step.sha256 === 'string' &&
      step.sha256.length > 0
    )
  }
  if (step.kind === 'edit') {
    return (
      isNonEmptyAbsolutePath(step.path) &&
      isNonEmptyAbsolutePath(step.savedCopy) &&
      typeof step.beforeSha256 === 'string' &&
      step.beforeSha256.length > 0 &&
      typeof step.afterSha256 === 'string' &&
      step.afterSha256.length > 0
    )
  }
  if (step.kind === 'remove-cache') {
    return isNonEmptyAbsolutePath(step.path)
  }
  return false
}

function isValidJournalEntry(entry: JournalEntry): boolean {
  if (
    entry.status !== 'in-progress' &&
    entry.status !== 'done' &&
    entry.status !== 'undone' &&
    entry.status !== 'needs-attention'
  ) {
    return false
  }
  if (entry.undo !== 'can-undo' && entry.undo !== 'cannot-undo') {
    return false
  }
  if (typeof entry.folderPath !== 'string' || entry.folderPath.length === 0 || entry.folderPath.includes('\0')) {
    return false
  }
  if (entry.backupId !== null && (typeof entry.backupId !== 'string' || !isSafeId(entry.backupId))) {
    return false
  }
  if (!Array.isArray(entry.steps) || !entry.steps.every(isValidJournalStep)) {
    return false
  }
  return true
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
    if (!isValidJournalEntry(found)) return null
    entries.push(found)
  }
  return entries
}

async function walkFilesDirStrict(
  rootFilesDir: string
): Promise<{ rootReal: string | null; files: ScannedFile[]; subDirs: ScannedSubDir[] } | null> {
  const files: ScannedFile[] = []
  const subDirs: ScannedSubDir[] = []
  let rootReal: string | null = null

  try {
    rootReal = await realpath(rootFilesDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { rootReal: null, files: [], subDirs: [] }
    }
    return null
  }

  async function walk(dir: string, depth: number): Promise<boolean> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
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
      let realFull: string
      try {
        realFull = await realpath(full)
      } catch {
        return false
      }
      if (info.isDirectory()) {
        subDirs.push({ abs: full, canonicalKey: caseKey(realFull), depth: depth + 1 })
        if (!(await walk(full, depth + 1))) return false
      } else if (info.isFile()) {
        if (!(await canReadFilePayload(full))) return false
        files.push({ abs: full, realAbs: realFull, canonicalKey: caseKey(realFull), bytes: info.size })
      } else {
        return false
      }
    }
    return true
  }

  const ok = await walk(rootFilesDir, 0)
  return ok ? { rootReal, files, subDirs } : null
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
      filesDirReal: walked.rootReal,
      filesDirCanonicalKey: walked.rootReal !== null ? caseKey(walked.rootReal) : null,
      manifestPath,
      manifestBytes,
      manifest,
      files: walked.files,
      subDirs: walked.subDirs
    })
  }
  return result
}

async function walkHoldingFilesStrict(holdingEntryAbs: string): Promise<{ files: ScannedFile[]; realRoot: string } | 'missing' | null> {
  let rootInfo
  try {
    rootInfo = await lstat(holdingEntryAbs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'missing'
    return null
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null

  let realRoot: string
  try {
    realRoot = await realpath(holdingEntryAbs)
  } catch {
    return null
  }

  const files: ScannedFile[] = []
  async function walk(cur: string): Promise<boolean> {
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
      if (cInfo.isDirectory()) {
        if (!(await walk(childAbs))) return false
      } else if (cInfo.isFile()) {
        if (!(await canReadFilePayload(childAbs))) return false
        let realChild: string
        try {
          realChild = await realpath(childAbs)
        } catch {
          return false
        }
        files.push({
          abs: childAbs,
          realAbs: realChild,
          canonicalKey: caseKey(realChild),
          bytes: cInfo.size
        })
      } else {
        return false
      }
    }
    return true
  }

  if (!(await walk(holdingEntryAbs))) return null
  return { files, realRoot }
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
    const walked = await walkHoldingFilesStrict(abs)
    if (walked === null || walked === 'missing') return null
    const totalFileBytes = walked.files.reduce((sum, f) => sum + f.bytes, 0)
    result.push({ name, abs, totalFileBytes })
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

async function verifyHoldingDirReadyToRemove(
  holdingEntryAbs: string,
  matching: JournalEntry,
  allEntries: readonly JournalEntry[]
): Promise<{ verdict: 'safe'; totalFileBytes: number } | { verdict: 'keep' } | { verdict: 'unsafe' }> {
  if (isActiveJournalEntry(matching)) return { verdict: 'keep' }
  if (matching.status !== 'undone' && !(matching.status === 'done' && matching.undo === 'cannot-undo')) {
    return { verdict: 'keep' }
  }
  if (allEntries.some((entry) => entry.id !== matching.id && stepTouchesHoldingDir(entry, holdingEntryAbs))) {
    return { verdict: 'keep' }
  }

  const walked = await walkHoldingFilesStrict(holdingEntryAbs)
  if (walked === null) return { verdict: 'unsafe' }
  if (walked === 'missing') return { verdict: 'keep' }

  const accountedKeys = new Set<string>()

  for (const step of matching.steps) {
    if (step.kind === 'move' && isInsideCase(step.to, holdingEntryAbs)) {
      let toInfo = null
      try {
        toInfo = await lstat(step.to)
      } catch (err) {
        if (!isMissingErr(err)) return { verdict: 'unsafe' }
      }
      if (toInfo === null) {
        if (matching.status === 'done' && step.state !== 'reverted' && step.state !== 'pending') {
          // Already absent on disk
        }
        continue
      }
      if (toInfo.isSymbolicLink()) return { verdict: 'unsafe' }
      if (!toInfo.isFile()) return { verdict: 'keep' }

      // A remaining held move copy is only safe to delete when reverted and its restored original matches by SHA-256
      if (matching.status !== 'undone' || step.state !== 'reverted') return { verdict: 'keep' }

      let fromInfo = null
      try {
        fromInfo = await lstat(step.from)
      } catch (err) {
        if (isMissingErr(err)) return { verdict: 'keep' }
        return { verdict: 'unsafe' }
      }
      if (fromInfo.isSymbolicLink() || !fromInfo.isFile() || fromInfo.size !== step.bytes || toInfo.size !== step.bytes) {
        return { verdict: 'keep' }
      }

      let realTo: string
      let realFrom: string
      try {
        ;[realTo, realFrom] = await Promise.all([realpath(step.to), realpath(step.from)])
      } catch (err) {
        if (isMissingErr(err)) return { verdict: 'keep' }
        return { verdict: 'unsafe' }
      }
      if (caseKey(realTo) === caseKey(realFrom) || !isInsideCase(realTo, walked.realRoot)) {
        return { verdict: 'keep' }
      }

      let heldSha: string
      let origSha: string
      try {
        ;[heldSha, origSha] = await Promise.all([sha256File(step.to), sha256File(step.from)])
      } catch {
        return { verdict: 'keep' }
      }
      if (heldSha !== step.sha256 || origSha !== step.sha256 || heldSha !== origSha) {
        return { verdict: 'keep' }
      }
      accountedKeys.add(caseKey(realTo))
    } else if (step.kind === 'edit' && isInsideCase(step.savedCopy, holdingEntryAbs)) {
      let savedInfo = null
      try {
        savedInfo = await lstat(step.savedCopy)
      } catch (err) {
        if (!isMissingErr(err)) return { verdict: 'unsafe' }
      }
      if (savedInfo === null) continue
      if (savedInfo.isSymbolicLink()) return { verdict: 'unsafe' }
      if (!savedInfo.isFile()) return { verdict: 'keep' }

      const settledEdit =
        (matching.status === 'undone' && step.state === 'reverted') ||
        (matching.status === 'done' && matching.undo === 'cannot-undo' && step.state === 'applied')
      if (!settledEdit) return { verdict: 'keep' }

      let liveInfo = null
      try {
        liveInfo = await lstat(step.path)
      } catch (err) {
        if (isMissingErr(err)) return { verdict: 'keep' }
        return { verdict: 'unsafe' }
      }
      if (liveInfo.isSymbolicLink() || !liveInfo.isFile()) return { verdict: 'keep' }

      let realSaved: string
      let realLive: string
      try {
        ;[realSaved, realLive] = await Promise.all([realpath(step.savedCopy), realpath(step.path)])
      } catch (err) {
        if (isMissingErr(err)) return { verdict: 'keep' }
        return { verdict: 'unsafe' }
      }
      if (caseKey(realSaved) === caseKey(realLive) || !isInsideCase(realSaved, walked.realRoot)) {
        return { verdict: 'keep' }
      }

      let savedSha: string
      try {
        savedSha = await sha256File(step.savedCopy)
      } catch {
        return { verdict: 'keep' }
      }
      if (savedSha !== step.beforeSha256) return { verdict: 'keep' }
      accountedKeys.add(caseKey(realSaved))
    }
  }

  // Every file anywhere inside holding/<id>/ must be accounted for by a verified settled step of matching!
  for (const file of walked.files) {
    if (!accountedKeys.has(file.canonicalKey)) {
      return { verdict: 'keep' }
    }
  }

  // Also ensure no other undone entry has an unverified move copy still sitting in this holding dir
  for (const other of allEntries) {
    if (other.id === matching.id) continue
    for (const step of other.steps) {
      if (step.kind !== 'move' || !isInsideCase(step.to, holdingEntryAbs)) continue
      try {
        await lstat(step.to)
        return { verdict: 'keep' }
      } catch (err) {
        if (!isMissingErr(err)) return { verdict: 'unsafe' }
      }
    }
  }

  const totalFileBytes = walked.files.reduce((sum, f) => sum + f.bytes, 0)
  return { verdict: 'safe', totalFileBytes }
}

async function storedCopiesHashIntact(
  backupsDir: string,
  lines: readonly ManifestFile[],
  hashCache: Map<string, string>
): Promise<boolean> {
  if (!(await storedCopiesInPlace(backupsDir, [...lines]))) return false
  for (const line of lines) {
    const candidate = storedFile(backupsDir, line)
    let realTarget: string
    try {
      realTarget = await realpath(candidate)
    } catch (err) {
      if (isMissingErr(err)) return false
      throw err
    }
    const key = caseKey(realTarget)
    let actualSha = hashCache.get(key)
    if (actualSha === undefined) {
      try {
        actualSha = await sha256File(realTarget)
      } catch (err) {
        if (isMissingErr(err)) return false
        throw err
      }
      hashCache.set(key, actualSha)
    }
    if (actualSha !== line.sha256) return false
  }
  return true
}

async function planPrune(deps: SafetyDeps): Promise<PrunePlan> {
  const { journalDir, backupsDir, holdingDir } = deps.paths
  const [journalEntries, backupDirs, holdingDirs] = await Promise.all([
    scanJournalStrict(journalDir),
    scanBackupsStrict(backupsDir),
    scanHoldingStrict(holdingDir)
  ])

  let backupsTotalBytes = 0
  let verifiedCount = 0
  if (backupDirs !== null) {
    for (const b of backupDirs) {
      backupsTotalBytes += b.manifestBytes + b.files.reduce((sum, f) => sum + f.bytes, 0)
      if (b.manifest?.record.state === 'verified') verifiedCount += 1
    }
  }

  if (journalEntries === null || backupDirs === null || holdingDirs === null) {
    return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
  }

  const protectedManifestIds = new Set<string>()
  const protectedWholeBackupDirs = new Set<string>()
  const hashCache = new Map<string, string>()

  // 1. Group verified manifests by Sims folder (case-insensitive) and protect newest 2 + newest hash-intact
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
    if (group.length > KEEP_VERIFIED_PER_FOLDER) {
      let foundIntact = false
      for (const m of group) {
        let intact: boolean
        try {
          intact = await storedCopiesHashIntact(backupsDir, m.files, hashCache)
        } catch {
          return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
        }
        if (intact) {
          protectedManifestIds.add(idKey(m.record.id))
          foundIntact = true
          break
        }
      }
      if (!foundIntact) {
        return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
      }
    }
  }

  // 2. Active journal entries protect their backupId (and whole dir if manifest is missing)
  for (const entry of journalEntries) {
    if (isActiveJournalEntry(entry) && entry.backupId !== null) {
      protectedManifestIds.add(idKey(entry.backupId))
      protectedWholeBackupDirs.add(idKey(entry.backupId))
    }
  }

  // 3. Protect 'copying' manifests whose timestamp is future or within 1 hour of clock.now()
  const nowMs = deps.clock.now().getTime()
  for (const b of backupDirs) {
    if (b.manifest?.record.state === 'copying') {
      const atMs = Date.parse(b.manifest.record.at)
      if (!Number.isFinite(nowMs) || !Number.isFinite(atMs) || atMs > nowMs || nowMs - atMs <= COPYING_GRACE_MS) {
        protectedManifestIds.add(idKey(b.manifest.record.id))
      }
    }
  }

  // Build canonical storedIn closure across all protected manifests
  const protectedStoredKeys = new Set<string>()
  for (const b of backupDirs) {
    if (b.manifest && protectedManifestIds.has(idKey(b.manifest.record.id))) {
      for (const line of b.manifest.files) {
        const rawStored = storedFile(backupsDir, line)
        protectedStoredKeys.add(caseKey(rawStored))
        try {
          const realStored = await realpath(rawStored)
          protectedStoredKeys.add(caseKey(realStored))
        } catch (err) {
          if (!isMissingErr(err)) {
            return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
          }
          protectedStoredKeys.add(caseKey(await resolveDeepest(rawStored)))
        }
      }
    }
  }

  let reclaimableBackupBytes = 0
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

    const isProtectedFile = (f: ScannedFile): boolean =>
      protectedStoredKeys.has(f.canonicalKey) || protectedStoredKeys.has(caseKey(f.abs))

    const protectedFiles = b.files.filter(isProtectedFile)
    const unreferencedFiles = b.files.filter((f) => !isProtectedFile(f))

    if (protectedFiles.length > 0) {
      if (b.manifestPath !== null) {
        phase1ManifestPaths.push(b.manifestPath)
        reclaimableBackupBytes += b.manifestBytes
        reclaimableBackups += 1
      }
      for (const f of unreferencedFiles) {
        phase2DonorFilePaths.push(f.abs)
        reclaimableBackupBytes += f.bytes
      }

      const protectedAncestors = new Set<string>()
      if (b.filesDirReal !== null && b.filesDirCanonicalKey !== null) {
        for (const pf of protectedFiles) {
          let cur = dirname(pf.realAbs)
          while (isInsideCase(cur, b.filesDirReal) && caseKey(cur) !== b.filesDirCanonicalKey) {
            protectedAncestors.add(caseKey(cur))
            const parent = dirname(cur)
            if (parent === cur) break
            cur = parent
          }
        }
      }

      for (const sub of b.subDirs) {
        if (!protectedAncestors.has(sub.canonicalKey)) {
          const list = donorDirsByDepthMap.get(sub.depth) ?? []
          list.push(sub.abs)
          donorDirsByDepthMap.set(sub.depth, list)
        }
      }
    } else {
      if (b.manifestPath !== null) {
        phase1ManifestPaths.push(b.manifestPath)
        reclaimableBackups += 1
      }
      phase2DeadBackupDirs.push(b.abs)
      reclaimableBackupBytes += b.manifestBytes + b.files.reduce((sum, f) => sum + f.bytes, 0)
    }
  }

  const depthsDesc = [...donorDirsByDepthMap.keys()].sort((a, b) => b - a)
  const phase2DonorEmptyDirsByDepth = depthsDesc.map((d) => donorDirsByDepthMap.get(d)!)

  // Holding directories: orphan dirs (matching === undefined) are NEVER removed!
  const entriesById = new Map<string, JournalEntry>(journalEntries.map((e) => [idKey(e.id), e]))
  let eligibleHoldingBytes = 0
  const phase3HoldingTargets: EligibleHoldingTarget[] = []

  for (const h of holdingDirs) {
    const matching = entriesById.get(idKey(h.name))
    if (matching === undefined) continue

    const check = await verifyHoldingDirReadyToRemove(h.abs, matching, journalEntries)
    if (check.verdict === 'unsafe') {
      return { safe: false, verifiedCount, totalBytes: backupsTotalBytes }
    }
    if (check.verdict === 'keep') continue

    phase3HoldingTargets.push({ abs: h.abs, matching, totalFileBytes: check.totalFileBytes })
    eligibleHoldingBytes += check.totalFileBytes
  }

  const reclaimableBytes = reclaimableBackupBytes + eligibleHoldingBytes

  return {
    safe: true,
    verifiedCount,
    totalBytes: backupsTotalBytes + eligibleHoldingBytes,
    reclaimableBackupBytes,
    reclaimableBytes,
    reclaimableBackups,
    journalEntries,
    phase1ManifestPaths,
    phase2DonorFilePaths,
    phase2DonorEmptyDirsByDepth,
    phase2DeadBackupDirs,
    phase3HoldingTargets
  }
}

function hasAnyPlannedOps(plan: Extract<PrunePlan, { safe: true }>): boolean {
  return (
    plan.reclaimableBytes > 0 ||
    plan.phase1ManifestPaths.length > 0 ||
    plan.phase2DonorFilePaths.length > 0 ||
    plan.phase2DonorEmptyDirsByDepth.some((level) => level.length > 0) ||
    plan.phase2DeadBackupDirs.length > 0 ||
    plan.phase3HoldingTargets.length > 0
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

  // Phase 3: immediately re-verify each settled holding dir right before removing it
  let freedHoldingBytes = 0
  for (const target of plan.phase3HoldingTargets) {
    const recheck = await verifyHoldingDirReadyToRemove(target.abs, target.matching, plan.journalEntries)
    if (recheck.verdict === 'unsafe') {
      return { status: 'failed', detail: PRUNE_FAILED_DETAIL }
    }
    if (recheck.verdict === 'keep') {
      continue
    }
    const removed = await runRemoveChunks(deps, [target.abs])
    if (!removed.ok) return { status: 'failed', detail: removed.detail }
    freedHoldingBytes += recheck.totalFileBytes
  }

  const summary = await readBackupSummary(deps, folderPath)
  return {
    status: 'done',
    freedBytes: plan.reclaimableBackupBytes + freedHoldingBytes,
    removedBackups: plan.reclaimableBackups,
    summary
  }
}
