import { randomBytes } from 'node:crypto'
import type { Progress } from '../shared/model.ts'
import { clearKey, keyStatus, sendWithKey, setKey } from './assist/key-store.ts'
import { applyFix, clearCaches, disabledGroups, putBack, setAside } from './fixes/index.ts'
import { buildInventory } from './inventory/index.ts'
import type { Host } from './locate/host.ts'
import { checkGameRunning } from './locate/process.ts'
import { readLogs } from './logs/index.ts'
import type {
  AppContext,
  AppPaths,
  Clock,
  FixDeps,
  Fixes,
  Gate,
  GateDeps,
  KeyStore,
  KeyStoreDeps,
  SafeStorageLike,
  Safety,
  SafetyDeps,
  ScanDeps
} from './ports.ts'
import { makeRedactor } from './redact.ts'
import { readFolderFacts, runRules } from './rules/index.ts'
import { runGate } from './safety/gate.ts'
import {
  backupStatus,
  createBackup,
  listJournal,
  recover,
  runAction,
  undo
} from './safety/index.ts'

export interface CreateContextInput {
  host: Host
  paths: AppPaths
  safeStorage: SafeStorageLike
  emit(progress: Progress): void
  reveal(file: string): void
  clock?: Clock
  newId?: () => string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatTimeId(date: Date): string {
  const y = date.getUTCFullYear()
  const mo = pad2(date.getUTCMonth() + 1)
  const d = pad2(date.getUTCDate())
  const h = pad2(date.getUTCHours())
  const mi = pad2(date.getUTCMinutes())
  const s = pad2(date.getUTCSeconds())
  const suffix = randomBytes(2).toString('hex')
  return `${y}${mo}${d}-${h}${mi}${s}-${suffix}`
}

export function createContext(input: CreateContextInput): AppContext {
  const clock: Clock = input.clock ?? { now: () => new Date() }
  const newId = input.newId ?? (() => formatTimeId(clock.now()))
  const { host, paths, safeStorage, emit, reveal } = input

  const redact = makeRedactor(host.env)
  const gameState = () => checkGameRunning(host)

  const gateDeps: GateDeps = {
    paths,
    gameState,
    backupStatus: (folderPath) => safety.backupStatus(folderPath)
  }

  const gate: Gate = {
    run: (request) => runGate(gateDeps, request)
  }

  const safetyDeps: SafetyDeps = {
    gate,
    paths,
    clock,
    newId,
    gameState
  }

  const safety: Safety = {
    backupStatus: (folderPath) => backupStatus(safetyDeps, folderPath),
    createBackup: (folderPath, onProgress) => createBackup(safetyDeps, folderPath, onProgress),
    runAction: (plan, onProgress) => runAction(safetyDeps, plan, onProgress),
    undo: (entryId, onProgress) => undo(safetyDeps, entryId, onProgress),
    listJournal: () => listJournal(safetyDeps),
    recover: () => recover(safetyDeps)
  }

  const fixDeps: FixDeps = {
    safety,
    paths,
    newId
  }

  const fixes: Fixes = {
    apply: (scan, request, onProgress) => applyFix(fixDeps, scan, request, onProgress),
    setAside: (folderPath, groups, origin, onProgress) =>
      setAside(fixDeps, folderPath, groups, origin, onProgress),
    putBack: (folderPath, groupIds, onProgress) => putBack(fixDeps, folderPath, groupIds, onProgress),
    clearCaches: (folderPath) => clearCaches(fixDeps, folderPath),
    disabledGroups: (folderPath) => disabledGroups(fixDeps, folderPath)
  }

  const keyStoreDeps: KeyStoreDeps = {
    gate,
    paths,
    safeStorage
  }

  const keyStore: KeyStore = {
    status: () => keyStatus(keyStoreDeps),
    set: (key) => setKey(keyStoreDeps, key),
    clear: () => clearKey(keyStoreDeps),
    send: (message) => sendWithKey(keyStoreDeps, message)
  }

  const scan: ScanDeps = {
    buildInventory,
    readLogs,
    readFolderFacts,
    runRules,
    clock,
    newId,
    paths
  }

  return {
    host,
    clock,
    paths,
    newId,
    redact,
    gameState,
    scan,
    gate,
    safety,
    fixes,
    keyStore,
    session: { scan: null },
    emit,
    reveal
  }
}
