import { randomBytes } from 'node:crypto'
import type {
  FixRequest,
  JournalEntry,
  JournalOrigin,
  ModGroup,
  Progress,
  Scan,
  StartupRecovery,
  UpdateState
} from '../shared/model.ts'
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
  Share,
  Updater,
  WriteRequest
} from './ports.ts'
import { makeRedactor } from './redact.ts'
import { readFolderFacts, runRules } from './rules/index.ts'
import { runGate } from './safety/gate.ts'
import { createShare } from './share/index.ts'
import { safeWebLink } from './share/links.ts'
import {
  backupStatus,
  backupSummary,
  createBackup,
  listJournal,
  pruneBackups,
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
  // index.ts passes Electron's folder dialog on the app window. Without one, nothing is ever picked.
  pickFolder?: () => Promise<string | null>
  // index.ts passes shell.openExternal. It only ever gets a url safeWebLink gave back. Without one, nothing opens.
  openExternal?: (url: string) => Promise<void>
}

/**
 * Runs recover the first time it is asked and hands every caller that same run. Never rejects: a recover that
 * throws or rejects is { status: 'failed' }, and the entries it could not settle stay in the journal for History.
 */
export function onceRecovery(recover: () => Promise<JournalEntry[]>): () => Promise<StartupRecovery> {
  let run: Promise<StartupRecovery> | null = null
  return () => {
    if (run) return run
    let started: Promise<JournalEntry[]>
    try {
      started = recover()
    } catch (err) {
      started = Promise.reject(err)
    }
    run = started.then(
      (touched): StartupRecovery => ({ status: 'finished', touched }),
      (): StartupRecovery => ({ status: 'failed' })
    )
    return run
  }
}

export interface RecoveryQuitGuardDeps {
  platform: NodeJS.Platform
  quit(): void
  openWindowCount(): number
}

export interface RecoveryQuitGuard {
  onWindowAllClosed(): void
  onBeforeQuit(event: { preventDefault(): void }): void
}

export function createRecoveryQuitGuard(
  recoveryDone: Promise<unknown>,
  deps: RecoveryQuitGuardDeps
): RecoveryQuitGuard {
  let recoverySettled = false
  let quitAfterRecovery = false
  let checkWindowsAfterRecovery = false

  const onSettled = (): void => {
    recoverySettled = true
    if (quitAfterRecovery || (checkWindowsAfterRecovery && deps.openWindowCount() === 0)) {
      deps.quit()
    }
  }
  void recoveryDone.then(onSettled, onSettled)

  return {
    onWindowAllClosed(): void {
      if (deps.platform === 'darwin') return
      if (!recoverySettled) {
        checkWindowsAfterRecovery = true
        return
      }
      deps.quit()
    },
    onBeforeQuit(event: { preventDefault(): void }): void {
      if (!recoverySettled) {
        event.preventDefault()
        quitAfterRecovery = true
      }
    }
  }
}

/**
 * openWeb for the context: only the url that safeWebLink gives back reaches the opener. A refused address, a check
 * that throws, no opener, or an opener that fails all answer 'refused'.
 */
export function makeOpenWeb(
  check: (text: string) => { url: string; host: string } | null,
  open: ((url: string) => Promise<void>) | undefined
): (url: string) => Promise<'opened' | 'refused'> {
  return async (text) => {
    if (!open) return 'refused'
    let url: string
    try {
      const safe = check(text)
      if (!safe) return 'refused'
      url = safe.url
    } catch {
      return 'refused'
    }
    try {
      await open(url)
      return 'opened'
    } catch {
      return 'refused'
    }
  }
}

// Only tests reach this: index.ts always passes an updater, which knows the real version.
const UPDATES_OFF: UpdateState = { state: 'off', why: 'switched-off', current: '0.0.0' }

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

  // busy() is true while a gate write, a safety or fixes call, or a held IPC call runs, so a restart for an update
  // never cuts a change in half.
  let inFlight = 0
  const busy = (): boolean => inFlight > 0
  const holdBusy = (): (() => void) => {
    inFlight += 1
    let held = true
    return () => {
      if (!held) return
      held = false
      inFlight -= 1
    }
  }
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
    backupStatus: (folderPath) => safety.backupStatus(folderPath),
    shareRoot: () => share.shareRoot()
  }

  const gate: Gate = {
    run: counted((request: WriteRequest) => runGate(gateDeps, request))
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
    backupSummary: counted((folderPath: string | null) => backupSummary(safetyDeps, folderPath)),
    pruneBackups: counted((folderPath: string | null) => pruneBackups(safetyDeps, folderPath)),
    createBackup: counted((folderPath: string, onProgress?: OnProgress) => createBackup(safetyDeps, folderPath, onProgress)),
    runAction: counted((plan: ActionPlan, onProgress?: OnProgress) => runAction(safetyDeps, plan, onProgress)),
    undo: counted((entryId: string, onProgress?: OnProgress) => undo(safetyDeps, entryId, onProgress)),
    listJournal: counted(() => listJournal(safetyDeps)),
    recover: counted((onProgress?: OnProgress) => recover(safetyDeps, onProgress)),
    // PR 14, unit E: becomes closeUndo(safetyDeps, entryId) from ./safety/index.ts
    closeUndo: counted(async (_entryId: string): Promise<void> => {
      throw new Error('not implemented: closeUndo')
    })
  }

  const startupRecovery = onceRecovery(() => safety.recover(emit))

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
    send: (message) => sendWithKey(keyStoreDeps, message),
    // PR 14, unit D: becomes findWithKey(keyStoreDeps, message) from ./assist/key-store.ts
    find: async () => ({ status: 'failed', why: 'no-key' })
  }

  const pickFolder = input.pickFolder ?? (async () => null)
  const share: Share = createShare({ gate, safety, paths, clock, newId, host, gameState, redact, pickFolder })

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
    share,
    pickFolder,
    openWeb: makeOpenWeb(safeWebLink, input.openExternal),
    startupRecovery,
    updater: typeof input.updater === 'function' ? input.updater({ busy }) : (input.updater ?? NO_UPDATER),
    busy,
    holdBusy,
    session: { scan: null },
    emit,
    reveal
  }
}
