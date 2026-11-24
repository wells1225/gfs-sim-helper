import { randomBytes } from 'node:crypto'
import type { FixRequest, JournalOrigin, ModGroup, Progress, Scan, UpdateState } from '../shared/model.ts'
import { clearKey, keyStatus, sendWithKey, setKey } from './assist/key-store.ts'
import { applyFix, clearCaches, disabledGroups, putBack, setAside } from './fixes/index.ts'
import { buildInventory } from './inventory/index.ts'
import type { Host } from './locate/host.ts'
import { checkGameRunning } from './locate/process.ts'
import { readLogs } from './logs/index.ts'
import type {
  ActionPlan,
  AppContext,
  AppPaths,
  Clock,
  FixDeps,
  Fixes,
  Gate,
  GateDeps,
  KeyStore,
  KeyStoreDeps,
  OnProgress,
  SafeStorageLike,
  Safety,
  SafetyDeps,
  ScanDeps,
  Updater
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
  // index.ts passes (seams) => createUpdater(input, seams), called once with this context's busy(); a ready Updater
  // also works. Without one, updates are off.
  updater?: Updater | ((seams: { busy: () => boolean }) => Updater)
}

const UPDATES_OFF: UpdateState = { state: 'off', why: 'switched-off' }

const NO_UPDATER: Updater = {
  state: () => UPDATES_OFF,
  check: async () => UPDATES_OFF,
  download: async () => UPDATES_OFF,
  install: () => ({ status: 'refused', why: 'not-ready' })
}

/**
 * The folders an install folder must stay clear of, for createUpdater's keepOutOf. An update empties the install
 * folder, so one that is inside or holds her Documents, a OneDrive root or this app's data folder (backups and
 * set-aside mods) turns updates off.
 */
export function updaterKeepOutOf(
  documentsDirs: readonly string[],
  paths: Pick<AppPaths, 'dataDir' | 'oneDriveRoots'>
): string[] {
  return [...new Set([...documentsDirs, ...paths.oneDriveRoots, paths.dataDir])].filter((dir) => dir.trim() !== '')
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

  // busy() is true while any safety or fixes call runs, so a restart for an update never cuts a change in half.
  let inFlight = 0
  const busy = (): boolean => inFlight > 0
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      inFlight += 1
      try {
        return await fn(...args)
      } finally {
        inFlight -= 1
      }
    }

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
    backupStatus: counted((folderPath: string) => backupStatus(safetyDeps, folderPath)),
    createBackup: counted((folderPath: string, onProgress?: OnProgress) => createBackup(safetyDeps, folderPath, onProgress)),
    runAction: counted((plan: ActionPlan, onProgress?: OnProgress) => runAction(safetyDeps, plan, onProgress)),
    undo: counted((entryId: string, onProgress?: OnProgress) => undo(safetyDeps, entryId, onProgress)),
    listJournal: counted(() => listJournal(safetyDeps)),
    recover: counted(() => recover(safetyDeps))
  }

  const fixDeps: FixDeps = {
    safety,
    paths,
    newId
  }

  const fixes: Fixes = {
    apply: counted((scan: Scan, request: FixRequest, onProgress?: OnProgress) => applyFix(fixDeps, scan, request, onProgress)),
    setAside: counted((folderPath: string, groups: ModGroup[], origin: JournalOrigin, onProgress?: OnProgress) =>
      setAside(fixDeps, folderPath, groups, origin, onProgress)
    ),
    putBack: counted((folderPath: string, groupIds: string[], onProgress?: OnProgress) =>
      putBack(fixDeps, folderPath, groupIds, onProgress)
    ),
    clearCaches: counted((folderPath: string) => clearCaches(fixDeps, folderPath)),
    disabledGroups: counted((folderPath: string) => disabledGroups(fixDeps, folderPath))
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
    updater: typeof input.updater === 'function' ? input.updater({ busy }) : (input.updater ?? NO_UPDATER),
    busy,
    session: { scan: null },
    emit,
    reveal
  }
}
