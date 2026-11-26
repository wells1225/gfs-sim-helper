import type {
  ActionKind,
  BackupResult,
  BackupStatus,
  DisabledGroup,
  FixOutcome,
  FixRefusal,
  FixRequest,
  GameRunState,
  GateRefusal,
  JournalEntry,
  JournalOrigin,
  KeySetResult,
  KeyStatus,
  LocalSave,
  ModGroup,
  OldSave,
  PcRole,
  Progress,
  RelPath,
  Scan,
  Sha256,
  ShareReceiveResult,
  ShareSendResult,
  ShareView,
  StartupRecovery,
  UpdateInstall,
  UpdateState
} from '../shared/model.ts'
import type { Host } from './locate/host.ts' // PR 3's Host is used as it is, never widened

export interface Clock {
  now(): Date
}

export interface AppPaths {
  dataDir: string // %LOCALAPPDATA%\SimsHelper, never Electron's userData
  backupsDir: string // <dataDir>\backups\<backupId>\
  holdingDir: string // <dataDir>\holding\<entryId>\Mods\<relPath>
  journalDir: string // <dataDir>\journal\<entryId>.json
  stateDir: string // <dataDir>\state\{settings,fiftyfifty,update}.json
  keyFile: string // <dataDir>\assist\key.bin
  oldSavesDir: string // <dataDir>\old-saves
  shareDir: string // <dataDir>\share\{incoming,outgoing}
  desktopDir: string // where the report zip is saved
  oneDriveRoots: string[] // from the OneDrive environment variables. A path part starting 'OneDrive' also counts
  curseForgeInstanceFile: string | null // %APPDATA%\CurseForge\agent\GameInstances\AddonGameInstance.json
}

/** The seven caches "Clear caches" removes, at the top of the Sims folder. A trailing '/' marks a folder. */
export const CACHE_NAMES = [
  'localthumbcache.package',
  'localsimtexturecache.package',
  'avatarcache.package',
  'houseDescription-client.package',
  'clientDB.package',
  'cachestr/',
  'onlinethumbnailcache/'
] as const

export const BACKUP_ALSO_SKIPS = ['cache/', 'cachewebkit/', 'lotcachedata/'] as const // a backup skips these and CACHE_NAMES

export type WriteOp =
  | { op: 'mkdir'; path: string }
  | { op: 'copy'; from: string; to: string } // never overwrites; keeps the file date; streams
  | { op: 'move'; from: string; to: string } // never overwrites; across drives: copy, check the hash, remove
  | { op: 'write'; path: string; data: string | Uint8Array; mode: 'create' | 'replace' } // temp file, then rename
  | { op: 'remove'; path: string } // a file, or a folder and everything in it

export interface WriteRequest {
  reason: 'backup' | 'journal' | 'state' | 'report' | 'key' | 'fix' | 'undo' | 'share' | 'share-save'
  folderPath: string | null // the Sims folder the ops touch or read; null for app data and the report only
  ops: WriteOp[]
}

export type GateResult =
  | { status: 'done' }
  | { status: 'refused'; refusal: GateRefusal } // refused: no op ran
  // failed: ops[0 .. opsDone-1] ran. Op opsDone may have run in part (a move: its file at the source, at both, or at
  // the target). The ops after it did not run. A caller that undoes must check op opsDone on the disk.
  | { status: 'failed'; opsDone: number; detail: string }

export interface Gate {
  run(request: WriteRequest): Promise<GateResult>
}

export interface GateDeps {
  paths: AppPaths
  gameState(): Promise<GameRunState> // asked fresh on every call, never cached
  backupStatus(folderPath: string): Promise<BackupStatus>
  shareRoot(): Promise<string | null> // PR 14: asked fresh for each request; null or a throw refuses a share op
}

export type PlannedStep =
  | { kind: 'move'; from: string; to: string; expect?: { bytes: number; sha256: Sha256 } } // expect: runAction refuses 'file-changed' if the source differs
  | { kind: 'edit'; path: string; newText: string; beforeSha256: Sha256 } // the file's hash when it was read; runAction refuses 'file-changed' if it differs
  | { kind: 'remove-cache'; path: string }

export interface ActionPlan {
  entryId: string // chosen by the planner; runAction uses it for the journal entry and holding/<entryId>/ paths
  action: ActionKind
  summary: string
  origin: JournalOrigin
  folderPath: string
  groupId: string | null
  groupLabel: string | null // ModGroup.label for a disable or set-aside of one group, else null
  hasScript: boolean // ModGroup.hasScript for that group, else false
  steps: PlannedStep[]
}

/** planFix's third argument: where to plan, plus what applyFix read from the disk first. */
export interface PlanFixAt {
  holdingDir: string
  entryId: string
  optionsText?: string // Options.ini as read, for 'turn-mods-on'
  existingCaches?: readonly string[] // the CACHE_NAMES present now, for 'clear-caches'
  existingModPaths?: readonly RelPath[] // destinations already taken, for 'move-script-up' and 'move-package-up'
}

export type OnProgress = (progress: Progress) => void

export interface Safety {
  // PR 9
  backupStatus(folderPath: string): Promise<BackupStatus>
  createBackup(folderPath: string, onProgress?: OnProgress): Promise<BackupResult>
  // runAction and undo make a backup first when the last one is not 'verified', so every way into Mods is covered
  runAction(plan: ActionPlan, onProgress?: OnProgress): Promise<FixOutcome>
  undo(entryId: string, onProgress?: OnProgress): Promise<FixOutcome>
  listJournal(): Promise<JournalEntry[]> // newest first
  recover(onProgress?: OnProgress): Promise<JournalEntry[]> // finishes or undoes interrupted entries; returns the ones it touched
  closeUndo(entryId: string): Promise<void> // PR 14: a done entry becomes 'cannot-undo'; an unknown id or a second call does nothing
}

export interface SafetyDeps {
  gate: Gate
  paths: AppPaths
  clock: Clock
  newId(): string
  gameState(): Promise<GameRunState>
}

export type GroupsOutcome =
  | { status: 'done'; entries: JournalEntry[] }
  | { status: 'refused'; refusal: FixRefusal }
  | { status: 'stopped-part-way'; entries: JournalEntry[]; detail: string }

export interface Fixes {
  // PR 10
  apply(scan: Scan, request: FixRequest, onProgress?: OnProgress): Promise<FixOutcome>
  setAside(folderPath: string, groups: ModGroup[], origin: JournalOrigin, onProgress?: OnProgress): Promise<GroupsOutcome>
  putBack(folderPath: string, groupIds: string[], onProgress?: OnProgress): Promise<GroupsOutcome>
  clearCaches(folderPath: string): Promise<FixOutcome>
  disabledGroups(folderPath: string): Promise<DisabledGroup[]>
}

export interface FixDeps {
  safety: Safety
  paths: AppPaths
  newId(): string
}

export interface DisableMechanism {
  // section 6
  method: 'move-to-holding' | 'rename-in-mods'
  plan(group: ModGroup, at: { modsDir: string; holdingDir: string; entryId: string }): PlannedStep[]
}

export interface AssistMessage {
  model: string
  system: string
  user: string
  maxTokens: number
}

export type AssistReply =
  | { status: 'text'; text: string }
  | { status: 'failed'; why: 'no-key' | 'key-rejected' | 'declined' | 'offline' | 'limit-reached' | 'error' } // key-rejected: HTTP 401, the stored key no longer works

export interface AssistFind {
  model: string
  system: string
  user: string
  maxTokens: number
  searches: number
}

export type AssistFound = { status: 'text'; text: string; pages: string[] } | Extract<AssistReply, { status: 'failed' }>

export interface KeyStore {
  // PR 12, section 8
  status(): Promise<KeyStatus>
  set(key: string): Promise<KeySetResult>
  clear(): Promise<KeyStatus>
  send(message: AssistMessage): Promise<AssistReply>
  find(message: AssistFind): Promise<AssistFound> // PR 14: one request with the web search tool; pages: the addresses the search returned
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Uint8Array
  decryptString(data: Uint8Array): string
}

export interface KeyStoreDeps {
  gate: Gate
  paths: AppPaths
  safeStorage: SafeStorageLike
  transport?: (apiKey: string, message: AssistMessage) => Promise<AssistReply> // tests only; the default is in key-store.ts
  findTransport?: (apiKey: string, message: AssistFind) => Promise<AssistFound> // tests only, the same way
}

export interface ScanDeps {
  // the real functions of PRs 4, 5 and 6, or fakes
  buildInventory: typeof import('./inventory/index.ts').buildInventory
  readLogs: typeof import('./logs/index.ts').readLogs
  readFolderFacts: typeof import('./rules/index.ts').readFolderFacts
  runRules: typeof import('./rules/index.ts').runRules
  clock: Clock
  newId(): string
  paths: AppPaths
}

export interface UpdaterInput {
  // PR 13, src/main/update/updater.ts (Fable): createUpdater(input, seams?) gives the Updater; seams.busy is ctx.busy
  isPackaged: boolean // app.isPackaged; updates are off when false
  version: string // app.getVersion()
  installDir: string // the folder of the running .exe
  argv: readonly string[] // '--updated' means the installer just restarted the app after an update
  env: Readonly<Record<string, string | undefined>> // SIMS_HELPER_UPDATES=off switches updates off; nothing here can point the feed elsewhere
  // updaterKeepOutOf(): Documents, the OneDrive roots and paths.dataDir. Updates are off when installDir is inside or
  // contains one, when any entry cannot be read, and when installDir is on a share or has an odd part (a trailing dot
  // or space, a ~digit short name, a colon after the drive)
  keepOutOf: readonly string[]
  platform: NodeJS.Platform // updates are off except on 'win32'
}

export interface Updater {
  // PR 13. The feed is only the installed app's app-update.yml
  state(): UpdateState
  check(): Promise<UpdateState> // during checking, downloading or ready: the state unchanged
  download(): Promise<UpdateState> // only from 'available'
  install(): UpdateInstall // only from 'ready': quitAndInstall(true, true), once
}

export interface Share {
  // PR 14: createShare(deps) in src/main/share/index.ts; one method per share:* channel
  view(): Promise<ShareView>
  setRole(role: PcRole): Promise<ShareView>
  findFolder(by: 'look' | 'pick' | 'make'): Promise<ShareView>
  check(): Promise<ShareView>
  send(what: { shareId: string } | { slotId: string; name: string }, onProgress?: OnProgress): Promise<ShareSendResult>
  receive(what: { shareId: string; seq: number; olderGame: 'stop' | 'go' }, onProgress?: OnProgress): Promise<ShareReceiveResult>
  restore(oldId: string): Promise<ShareReceiveResult>
  keep(shareId: string, keep: 'mine' | 'theirs'): Promise<ShareView>
  stop(shareId: string): Promise<ShareView>
  oldSaves(): Promise<OldSave[]>
  localSaves(): Promise<LocalSave[]>
  shareRoot(): Promise<string | null> // what GateDeps.shareRoot is wired to
}

/** Built once in services.ts and handed to every handlers file. */
export interface AppContext {
  host: Host
  clock: Clock
  paths: AppPaths
  newId(): string // newId: 'yyyymmdd-hhmmss-xxxx', sorts by time
  redact(text: string): string // src/main/redact.ts: her Windows user name becomes <user>
  gameState(): Promise<GameRunState>
  scan: ScanDeps
  gate: Gate
  safety: Safety
  fixes: Fixes
  keyStore: KeyStore
  updater: Updater
  share: Share
  pickFolder(): Promise<string | null> // Electron's folder dialog on the app window; null when she cancels
  openWeb(url: string): Promise<'opened' | 'refused'> // only what safeWebLink passes reaches the browser, as its url
  // The start-up recovery: index.ts calls it once before the window opens. Lazy, run once, never rejects; every later
  // call gives the same promise. The journal channels, every changing fix call, and every share:* handler except
  // share:open-link and the two share:find-* wait for it. A 'failed' recovery does not stop a share call: the checks
  // in receive.ts and the gate still decide.
  startupRecovery(): Promise<StartupRecovery>
  busy(): boolean // true while a gate write, a safety or fixes call, or a changing IPC call runs; update:install refuses 'busy' then
  holdBusy?(): () => void // keeps busy() true until the returned function is called; registerIpc holds it for each CHANGING_CHANNELS call
  session: { scan: Scan | null } // the last finished scan
  emit(progress: Progress): void // sends the 'progress' event to the window
  reveal(file: string): void // shows a file in Explorer
}
