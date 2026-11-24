# Shared contract for PRs 4 to 13

PRs 4 to 13 are built at the same time, each on its own branch from `wells/contracts`. This file is everything they
share. A builder codes against it and never needs another builder's code. Who owns which file is in
[`ownership.md`](ownership.md). Where this file and `plan.md` differ, this file wins.

## 1. Ground rules

- **Shared files are frozen.** Only the contract commit writes them. If a signature here is wrong or missing, do not
  edit the shared file: write it under "Contract requests" in your PR body and tell the lead. Inside your own folder
  you may add any file or export.
- **Stubs.** The contract commit creates every function below as a stub that throws
  `new Error('not implemented: <name>')` when called. Renderer screen and slot stubs render nothing instead. Loading a
  stub never throws, so the app starts on every branch.
- **Pass neighbors in, never import them.** A module gets another PR's work as an argument (`deps`, or a port from
  section 3). Only `src/main/services.ts` (contract) and a module's own `cli.ts` import across modules. Your unit
  tests pass fakes.
- **Reads and writes.** No file under `src/` except `src/main/safety/gate.ts` imports anything that changes the disk.
  **One named exception:** `src/main/update/updater.ts` (PR 13, Fable) is the only file that may load
  `electron-updater`, which writes its own download cache under `%LOCALAPPDATA%\sims-helper-updater\` and starts the
  installer. It never touches the Sims folder or `dataDir`, and it is off unless the app is installed outside
  Documents and OneDrive (`docs/research/fable-auto-update.md`, section 5).
  From `node:fs` and `node:fs/promises` only `readdir`, `readFile`, `realpath`, `stat`, `lstat`, `readlink` and
  `statfs` are allowed, as named imports. For part of a file, a stream or a hash use `src/main/fs-read.ts` (contract):
  `openForRead(file)` (gives `{ size, read(buffer, position), close() }`), `readStream(file)`, `sha256File(file)`.
  `node:child_process` stays in `src/main/locate/host.ts`; `electron` stays in the contract's main files. Test files
  may use any `fs` function, in a temp folder. Never read a whole `.package` into memory.
- **Imports.** Under `src/main` and `src/shared`, relative imports end in `.ts` and use only syntax plain Node can
  strip (no `enum`, parameter properties or `namespace`): the debug commands run on `node` directly.
- **Time.** `SimsFolder.newestFileAt` stays a `Date` (PR 3). Every type added here uses `IsoTime`. Times the game
  wrote into a log are kept as text and never converted.
- **Paths.** `RelPath` is relative to `Mods/`, forward slashes. Every other path is absolute and native. On Windows,
  compare paths without regard to letter case.
- **The renderer sends ids, not paths.** Main resolves each id against its own last scan.
- **Add nothing under `src/main/locate/`.** PR 3's guard test forbids it.
- **Packages.** Every npm package is a `devDependency`, so Vite bundles it into `out/`; the installer ships only `out/**`.
- **Tests.** Main-side test files start with `// @vitest-environment node`. Run only your own files:
  `npx vitest run <path>`. At most 2 workers; the configs cap this.

## 2. `src/shared/model.ts` (complete)

```ts
// ── PR 3, unchanged
export type PackCode = `${'EP' | 'GP' | 'SP' | 'FP'}${string}`
export interface SimsFolder { path: string; inOneDrive: boolean; newestFileAt: Date }
export interface GameInstall { path: string; version: string; packs: PackCode[] }
// ── Basics
/** The same union as in src/main/locate/process.ts. Every writer treats 'unknown' like 'running'. */
export type GameRunState = 'running' | 'not-running' | 'unknown'
export type IsoTime = string // Date.toISOString(), UTC
export type RelPath = string // relative to Mods/, forward slashes, no leading slash, no '..'
export type Sha256 = string // 64 lowercase hex digits
// ── Mods inventory (PR 4)
export interface ResourceKey { type: string; group: string; instance: string } // '0x' + 8, 8, 16 uppercase hex digits
export type DbpfIndex =
  | { status: 'ok'; keys: ResourceKey[] } // version 2.1
  | { status: 'wrong-game'; major: number; minor: number; game: 'sims2' | 'sims3' | 'simcity' | 'unknown' }
  | { status: 'broken'; problem: 'too-short' | 'bad-magic' | 'bad-index'; detail: string }
  | { status: 'unreadable'; detail: string } // the file could not be opened or read
/** What a scan keeps: the count, not the keys. No v1 rule uses the keys. */
export type DbpfSummary = { status: 'ok'; keyCount: number } | Exclude<DbpfIndex, { status: 'ok' }>
export type ScriptRead = // entries: paths inside the .ts4script, forward slashes
  | { status: 'ok'; entries: string[] } | { status: 'broken'; detail: string } | { status: 'unreadable'; detail: string }
/** A file is hashed only when another file in Mods has the same byte count. */
export type FileHash = { status: 'hashed'; sha256: Sha256 } | { status: 'not-needed' } | { status: 'unreadable'; detail: string }
/** kind goes by extension, any letter case: .package, .ts4script, then .zip .rar .7z, then everything else. */
export type ModFile = {
  relPath: RelPath; bytes: number; modifiedAt: IsoTime; hash: FileHash; groupId: string
  depth: number // folders between Mods and the file: Mods/a.package is 0
} & ({ kind: 'package'; dbpf: DbpfSummary } | { kind: 'script'; script: ScriptRead } | { kind: 'archive' } | { kind: 'other' })
export interface ModGroup {
  id: string // 'cf:<addonId>' | 'dir:<top folder, lowercased>' | 'file:<relPath, lowercased>'
  label: string // CurseForge name, folder name, or file name without its extension
  source: 'curseforge' | 'folder' | 'loose'; files: RelPath[]; bytes: number; hasScript: boolean
  curseForge: { addonId: number; fileId: number; fileDate: IsoTime } | null
}
export type ResourceCfgRead = { status: 'ok'; maxPackageDepth: number } | { status: 'missing' } | { status: 'unreadable'; detail: string }
export interface CurseForgeAddon { addonId: number; fileId: number; name: string; fileNameOnDisk: string; fileDate: IsoTime; moduleNames: string[] }
export type CurseForgeRead =
  | { status: 'found'; file: string; addons: CurseForgeAddon[] } | { status: 'not-found' } | { status: 'unreadable'; detail: string }
export interface Inventory {
  modsDir: string; modsDirState: 'present' | 'missing'
  files: ModFile[] // sorted by relPath; Mods/Resource.cfg is left out
  groups: ModGroup[] // every file is in exactly one group
  resourceCfg: ResourceCfgRead; curseForge: CurseForgeRead
  skipped: { relPath: RelPath; detail: string }[] // what the walk could not read
}
// ── Logs (PR 5)
export type LogKind = 'exception' | 'uiException' | 'crash' | 'betterExceptions' | 'mccc'
export interface LogFrame { path: string; line: number | null; origin: 'game' | 'mod' }
export interface LogReport {
  file: string; kind: LogKind // file: relative to the Sims folder, forward slashes
  fileModifiedAt: IsoTime // the log file's own date; logs are ordered by this
  createdLocal: string | null // <createtime> as the game wrote it
  gameVersion: string | null; categoryId: string | null // version: d.d.d.d from <buildsignature>
  message: string | null // first line of the error text, 300 characters at most
  count: number // reports in this file with this categoryId
  frames: LogFrame[] // innermost last, 60 at most; always empty for 'crash'
  modHints: string[] // distinct mod frames, at most 20, nearest the error first: path lowercased, '\' to '/', extension dropped
  completeness: 'complete' | 'cut-off'
}
// ── Folder facts and findings (PR 6)
export type ModSwitch = 'on' | 'off' | 'missing'
export type OptionsRead = { status: 'ok'; mods: ModSwitch; scriptMods: ModSwitch } | { status: 'missing' } | { status: 'unreadable'; detail: string }
export interface FolderFacts {
  options: OptionsRead
  gameUpdatedAt: IsoTime | null // date of <install>/Game/Bin/TS4_x64.exe (G1 confirms it tracks patches)
  thumbCacheAt: IsoTime | null // date of localthumbcache.package
}
export type RuleId =
  | 'mods-off' | 'folder-in-onedrive' | 'two-sims-folders' | 'log-names-mod' | 'script-too-deep' | 'package-too-deep'
  | 'archive-in-mods' | 'broken-package' | 'wrong-game-package' | 'duplicate-files' | 'script-older-than-update'
  | 'stale-thumbnail-cache' | 'crash-without-cause'
export type Severity = 'stop' | 'warn' | 'info'
export type Certainty = 'file-problem' | 'likely' | 'worth-testing' // badge: "File problem found", "Likely cause", "Worth testing"
export type FixRequest =
  | { fix: 'turn-mods-on' } | { fix: 'clear-caches' }
  | { fix: 'move-script-up'; files: RelPath[] } | { fix: 'set-aside-files'; files: RelPath[] }
  | { fix: 'disable-group'; groupId: string } | { fix: 'enable-group'; groupId: string }
export type FixId = FixRequest['fix']
export interface Finding {
  id: string // the RuleId, or '<RuleId>:<groupId>' for 'log-names-mod'
  rule: RuleId; severity: Severity; certainty: Certainty
  title: string; detail: string // the words she reads
  evidence: string[] // lines for the closed "Technical details" box
  files: RelPath[]; groupIds: string[] // what the finding is about
  fixes: FixRequest[] // ready to run; empty when there is no one-click fix
  next: 'none' | 'fifty-fifty' | 'pick-folder'
}
// ── Scan (PR 7)
export type Symptom = 'closes' | 'freezes' | 'wont-load' | 'one-save-or-lot' | 'not-sure'
export interface Scan {
  id: string; at: IsoTime; tookMs: number; symptom: Symptom
  folder: SimsFolder; otherFolders: SimsFolder[]; game: GameInstall | null; gameRunning: GameRunState
  facts: FolderFacts; inventory: Inventory; logs: LogReport[]; findings: Finding[]
}
export type ScanResult =
  | { status: 'done'; scan: Scan } | { status: 'failed'; why: 'folder-not-found' | 'folder-unreadable' | 'unexpected'; detail: string }
export interface Progress {
  task: 'scan' | 'backup' | 'fix'; stage: 'counting' | 'mods' | 'logs' | 'rules' | 'copying' | 'checking' | 'moving'
  done: number; total: number | null // null while still counting
}
export interface Settings { welcome: 'not-seen' | 'seen'; folderPath: string | null }
export interface LocateView { folders: SimsFolder[]; game: GameInstall | null; gameRunning: GameRunState }
export type ReportResult =
  | { status: 'saved'; fileName: string; entries: string[] } | { status: 'failed'; why: 'no-scan' | 'write-refused' | 'unexpected'; detail: string }
// ── Safety (PRs 8 and 9)
export type GateRefusal =
  | { reason: 'saves-or-tray'; path: string } | { reason: 'outside-allowed-area'; path: string }
  | { reason: 'link-escape'; path: string } | { reason: 'not-a-sims-folder'; path: string }
  | { reason: 'game-running' } | { reason: 'game-state-unknown' } | { reason: 'no-verified-backup'; backup: 'none' | 'stale' | 'unknown' }
  | { reason: 'check-failed'; path: string } // a check itself errored; fail closed (added after PR 8)
export type BackupStatus =
  | { state: 'verified'; backupId: string; at: IsoTime } | { state: 'stale'; backupId: string; at: IsoTime }
  | { state: 'none' } | { state: 'unknown'; detail: string }
export interface BackupRecord { id: string; at: IsoTime; folderPath: string; files: number; bytes: number; state: 'copying' | 'verified' | 'failed' }
export type BackupRefusal =
  | 'game-running' | 'game-state-unknown' | 'backup-folder-in-onedrive' | 'not-enough-space' | 'sims-folder-missing' | 'backup-already-running'
  | 'backup-folder-in-sims-folder'
export type BackupResult = { status: 'verified'; record: BackupRecord } | { status: 'refused'; reason: BackupRefusal } | { status: 'failed'; detail: string }
export type StepState = 'pending' | 'applied' | 'reverted'
export type JournalStep =
  | { kind: 'move'; from: string; to: string; bytes: number; sha256: Sha256; state: StepState }
  | { kind: 'edit'; path: string; savedCopy: string; beforeSha256: Sha256; afterSha256: Sha256; state: StepState }
  | { kind: 'remove-cache'; path: string; state: StepState } // never undone: the game rebuilds caches
export type ActionKind = Exclude<FixId, 'enable-group'> // enabling a group is the undo of its disable entry
export type JournalOrigin = { by: 'fix' } | { by: 'fifty-fifty'; sessionId: string; round: number }
export interface JournalEntry {
  id: string; at: IsoTime; action: ActionKind; summary: string; origin: JournalOrigin
  folderPath: string; groupId: string | null
  groupLabel: string | null; hasScript: boolean // copied from ActionPlan; null and false when groupId is null
  backupId: string; steps: JournalStep[]
  status: 'in-progress' | 'done' | 'undone' | 'needs-attention'; undo: 'can-undo' | 'cannot-undo'; undoneAt: IsoTime | null
}
// ── Fixes (PR 10)
/** What the renderer sends. Main looks the request up in its own last scan. */
export type FixCall =
  | { via: 'finding'; findingId: string; fix: FixId } | { via: 'group'; fix: 'disable-group' | 'enable-group'; groupId: string }
export type FixRefusal =
  | { why: 'gate'; refusal: GateRefusal } | { why: 'backup'; reason: BackupRefusal | 'backup-failed' }
  | { why: 'out-of-date'; detail: 'no-scan' | 'unknown-finding' | 'unknown-group' | 'file-changed' | 'nothing-to-do' }
  | { why: 'fifty-fifty-running' }
  | { why: 'not-started' } // the action failed before anything changed (for example the journal could not be written)
export type FixOutcome =
  | { status: 'done'; entry: JournalEntry } | { status: 'refused'; refusal: FixRefusal } // refused: nothing changed
  | { status: 'stopped-part-way'; entry: JournalEntry; detail: string } // History shows it and can undo it
export interface DisabledGroup {
  groupId: string; label: string; entryId: string; at: IsoTime
  origin: JournalOrigin['by'] // 'fix' or 'fifty-fifty': who set the group aside
}
// ── 50/50 (PR 11)
export type FiftyPhase = 'close-curseforge' | 'ready-to-test' | 'awaiting-answer' | 'found' | 'stopped'
export type FiftyAnswer = 'crashed' | 'worked' | 'not-sure'
export interface FiftyFifty {
  id: string; startedAt: IsoTime; folderPath: string; phase: FiftyPhase
  round: number // 0 is the control round: every group set aside. The halving rounds follow from 1
  roundsAtMost: number // ceil(log2(groups at the start)) + 1, the control round included
  groups: ModGroup[] // as scanned when the test started
  suspects: string[] // group ids that may still be the cause; script groups first, then by label
  parked: string[]; inMods: string[] // the half of the suspects set aside this round, and the half still in Mods
  cleared: string[]; culprit: string | null // cleared: ruled out and back in Mods
  history: { round: number; parked: string[]; answer: FiftyAnswer }[]
}
export type FiftyResult =
  | { status: 'ok'; state: FiftyFifty | null } | { status: 'refused'; refusal: FixRefusal }
  | { status: 'stopped-part-way'; state: FiftyFifty; detail: string }
// ── AI help (PR 12)
export type KeyStatus = 'set' | 'not-set' | 'encryption-unavailable'
/** What setKey answers: a KeyStatus, or 'not-saved' when the new key was refused and the old one is still stored. */
export type KeySetResult = KeyStatus | 'not-saved'
export interface AssistStatus { key: KeyStatus; offer: 'offer' | 'hide' }
export interface AssistPreview { id: string; text: string } // text: exactly what will be sent
export type AssistAnswer =
  | { status: 'answered'; text: string }
  | { status: 'no-answer'; why: 'no-key' | 'key-rejected' | 'declined' | 'offline' | 'limit-reached' | 'preview-expired' | 'error' } // key-rejected: HTTP 401
// ── Updates (PR 13)
export type UpdateState =
  | { state: 'off'; why: 'not-installed-app' | 'switched-off' | 'unsafe-install-folder' }
  | { state: 'idle'; current: string; checkedAt: IsoTime | null; justUpdated: boolean } | { state: 'checking'; current: string }
  | { state: 'available'; current: string; next: string } | { state: 'downloading'; current: string; next: string; percent: number }
  | { state: 'ready'; current: string; next: string } // downloaded, checksum passed, waits for her click
  | { state: 'failed'; current: string; step: 'check' | 'download'; why: 'offline' | 'bad-file' | 'error' }
export type UpdateInstall = { status: 'restarting' } | { status: 'refused'; why: 'busy' | 'not-ready' }
```

Differences from `plan.md`, on purpose: times are `IsoTime`; `ModFile` keeps a key count, not the keys; files are
hashed only when sizes collide (a real Mods folder can be tens of gigabytes); `Finding` carries its targets and ready
`FixRequest`s; `JournalEntry` has `steps`, because a settings edit and a cache clear are not moves.

## 3. `src/main/ports.ts` (main process only)

```ts
import type { Host } from './locate/host.ts' // PR 3's Host is used as it is, never widened
export interface Clock { now(): Date }
export interface AppPaths {
  dataDir: string // %LOCALAPPDATA%\SimsHelper, never Electron's userData
  backupsDir: string; holdingDir: string // <dataDir>\backups\<backupId>\ and <dataDir>\holding\<entryId>\Mods\<relPath>
  journalDir: string; stateDir: string // <dataDir>\journal\<entryId>.json and <dataDir>\state\{settings,fiftyfifty}.json
  keyFile: string; desktopDir: string // <dataDir>\assist\key.bin
  oneDriveRoots: string[] // from the OneDrive environment variables. A path part starting 'OneDrive' also counts
  curseForgeInstanceFile: string | null // %APPDATA%\CurseForge\agent\GameInstances\AddonGameInstance.json
}
/** The seven caches "Clear caches" removes, at the top of the Sims folder. A trailing '/' marks a folder. */
export const CACHE_NAMES = ['localthumbcache.package', 'localsimtexturecache.package', 'avatarcache.package',
  'houseDescription-client.package', 'clientDB.package', 'cachestr/', 'onlinethumbnailcache/'] as const
export const BACKUP_ALSO_SKIPS = ['cache/', 'cachewebkit/', 'lotcachedata/'] as const // a backup skips these and CACHE_NAMES
export type WriteOp =
  | { op: 'mkdir'; path: string }
  | { op: 'copy'; from: string; to: string } // never overwrites; keeps the file date; streams
  | { op: 'move'; from: string; to: string } // never overwrites; across drives: copy, check the hash, remove
  | { op: 'write'; path: string; data: string | Uint8Array; mode: 'create' | 'replace' } // temp file, then rename
  | { op: 'remove'; path: string } // a file, or a folder and everything in it
export interface WriteRequest {
  reason: 'backup' | 'journal' | 'state' | 'report' | 'key' | 'fix' | 'undo'
  folderPath: string | null // the Sims folder the ops touch or read; null for app data and the report only
  ops: WriteOp[]
}
export type GateResult =
  | { status: 'done' } | { status: 'refused'; refusal: GateRefusal } // refused: no op ran
  | { status: 'failed'; opsDone: number; detail: string } // ops[0 .. opsDone-1] ran, the rest did not
export interface Gate { run(request: WriteRequest): Promise<GateResult> }
export interface GateDeps {
  paths: AppPaths
  gameState(): Promise<GameRunState> // asked fresh on every call, never cached
  backupStatus(folderPath: string): Promise<BackupStatus>
}
export type PlannedStep =
  | { kind: 'move'; from: string; to: string } | { kind: 'remove-cache'; path: string }
  | { kind: 'edit'; path: string; newText: string; beforeSha256: Sha256 } // the hash when read; runAction refuses 'file-changed' if it differs
export interface ActionPlan {
  entryId: string // chosen by the planner; runAction uses it for the journal entry and holding/<entryId>/ paths
  action: ActionKind; summary: string; origin: JournalOrigin; folderPath: string; groupId: string | null
  groupLabel: string | null; hasScript: boolean // ModGroup.label and .hasScript for a one-group action, else null and false
  steps: PlannedStep[]
}
/** planFix's third argument: where to plan, plus what applyFix read from the disk first. */
export interface PlanFixAt {
  holdingDir: string; entryId: string
  optionsText?: string // Options.ini as read, for 'turn-mods-on'
  existingCaches?: readonly string[] // the CACHE_NAMES present now, for 'clear-caches'
  existingModPaths?: readonly RelPath[] // destinations already taken, for 'move-script-up'
}
export type OnProgress = (progress: Progress) => void
export interface Safety { // PR 9
  backupStatus(folderPath: string): Promise<BackupStatus>
  createBackup(folderPath: string, onProgress?: OnProgress): Promise<BackupResult>
  // runAction and undo make a backup first when the last one is not 'verified', so every way into Mods is covered
  runAction(plan: ActionPlan, onProgress?: OnProgress): Promise<FixOutcome>
  undo(entryId: string, onProgress?: OnProgress): Promise<FixOutcome>
  listJournal(): Promise<JournalEntry[]> // newest first
  recover(): Promise<JournalEntry[]> // finishes or undoes interrupted entries; returns the ones it touched
}
export interface SafetyDeps { gate: Gate; paths: AppPaths; clock: Clock; newId(): string; gameState(): Promise<GameRunState> }
export type GroupsOutcome =
  | { status: 'done'; entries: JournalEntry[] } | { status: 'refused'; refusal: FixRefusal }
  | { status: 'stopped-part-way'; entries: JournalEntry[]; detail: string }
export interface Fixes { // PR 10
  apply(scan: Scan, request: FixRequest, onProgress?: OnProgress): Promise<FixOutcome>
  setAside(folderPath: string, groups: ModGroup[], origin: JournalOrigin, onProgress?: OnProgress): Promise<GroupsOutcome>
  putBack(folderPath: string, groupIds: string[], onProgress?: OnProgress): Promise<GroupsOutcome>
  clearCaches(folderPath: string): Promise<FixOutcome>
  disabledGroups(folderPath: string): Promise<DisabledGroup[]>
}
export interface FixDeps { safety: Safety; paths: AppPaths; newId(): string }
export interface DisableMechanism { // section 6
  method: 'move-to-holding' | 'rename-in-mods'
  plan(group: ModGroup, at: { modsDir: string; holdingDir: string; entryId: string }): PlannedStep[]
}
export interface AssistMessage { model: string; system: string; user: string; maxTokens: number }
export type AssistReply = // key-rejected: HTTP 401, the stored key no longer works
  | { status: 'text'; text: string } | { status: 'failed'; why: 'no-key' | 'key-rejected' | 'declined' | 'offline' | 'limit-reached' | 'error' }
export interface KeyStore { // PR 12, section 8
  status(): Promise<KeyStatus>; set(key: string): Promise<KeySetResult>; clear(): Promise<KeyStatus>
  send(message: AssistMessage): Promise<AssistReply>
}
export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(text: string): Uint8Array; decryptString(data: Uint8Array): string }
export interface KeyStoreDeps {
  gate: Gate; paths: AppPaths; safeStorage: SafeStorageLike
  transport?: (apiKey: string, message: AssistMessage) => Promise<AssistReply> // tests only; the default is in key-store.ts
}
export interface ScanDeps { // the real functions of PRs 4, 5 and 6, or fakes
  buildInventory: typeof import('./inventory/index.ts').buildInventory
  readLogs: typeof import('./logs/index.ts').readLogs
  readFolderFacts: typeof import('./rules/index.ts').readFolderFacts
  runRules: typeof import('./rules/index.ts').runRules
  clock: Clock; newId(): string; paths: AppPaths
}
export interface UpdaterInput { // PR 13: createUpdater(input, seams?) in src/main/update/updater.ts gives the Updater
  isPackaged: boolean; version: string // app.isPackaged, app.getVersion()
  installDir: string // the folder of the running .exe
  argv: readonly string[] // '--updated': the installer just restarted the app after an update
  env: Readonly<Record<string, string | undefined>> // SIMS_HELPER_UPDATES=off switches updates off; nothing can point the feed elsewhere
  keepOutOf: readonly string[] // updaterKeepOutOf(): Documents, the OneDrive roots and paths.dataDir; off when installDir is inside or contains one
  platform: NodeJS.Platform // off except on 'win32'
}
export interface Updater { // PR 13. The feed is only the installed app's app-update.yml
  state(): UpdateState
  check(): Promise<UpdateState> // during checking, downloading or ready: the state unchanged
  download(): Promise<UpdateState> // only from 'available'
  install(): UpdateInstall // only from 'ready': quitAndInstall(true, true), once
}
/** Built once in services.ts and handed to every handlers file. */
export interface AppContext {
  host: Host; clock: Clock; paths: AppPaths; newId(): string // newId: 'yyyymmdd-hhmmss-xxxx', sorts by time
  redact(text: string): string // src/main/redact.ts: her Windows user name becomes <user>
  gameState(): Promise<GameRunState>
  scan: ScanDeps; gate: Gate; safety: Safety; fixes: Fixes; keyStore: KeyStore
  updater: Updater // createContext's optional `updater`: an Updater, or (seams) => Updater called once with this busy(); without one, always 'off'
  busy(): boolean // true while a safety or fixes call runs (services.ts counts them); update:install refuses 'busy'
  session: { scan: Scan | null } // the last finished scan
  emit(progress: Progress): void // sends the 'progress' event to the window
  reveal(file: string): void // shows a file in Explorer
}
```

## 4. Each PR's public functions

The contract commit creates each file below as a stub. The first argument `deps` is always passed in.

```ts
// PR 4  src/main/inventory/index.ts
readDbpfIndex(file: string): Promise<DbpfIndex>
listScriptEntries(file: string): Promise<ScriptRead>
readResourceCfg(modsDir: string): Promise<ResourceCfgRead>
readCurseForge(instanceFile: string | null): Promise<CurseForgeRead>
buildInventory(input: { modsDir: string; curseForgeInstanceFile: string | null; onProgress?: OnProgress }): Promise<Inventory>
// PR 5  src/main/logs/index.ts
parseGameLog(text: string, file: string, fileModifiedAt: IsoTime): LogReport[] // lastException, lastUIException, lastCrash
parseBetterExceptions(html: string, file: string, fileModifiedAt: IsoTime): LogReport[]
parseMccc(html: string, file: string, fileModifiedAt: IsoTime): LogReport[]
readLogs(input: { folderPath: string }): Promise<LogReport[]> // newest first
// PR 6  src/main/rules/index.ts (the words live in src/shared/copy/findings.ts)
readFolderFacts(input: { folderPath: string; game: GameInstall | null }): Promise<FolderFacts>
runRules(scan: Omit<Scan, 'findings'>): Finding[] // pure; sorted stop, warn, info, then rule order
// PR 7  src/main/scan/index.ts, src/main/report/index.ts, src/main/scan/handlers.ts
runScan(deps: ScanDeps, input: LocateView & { folder: SimsFolder; symptom: Symptom }, onProgress?: OnProgress): Promise<ScanResult>
planReport(scan: Scan, redact: (text: string) => string): { name: string; source: { file: string } | { json: unknown } }[]
buildReport(deps: Pick<AppContext, 'gate' | 'paths' | 'clock' | 'redact'>, scan: Scan): Promise<{ result: ReportResult; file: string | null }>
// PR 8  src/main/safety/gate.ts
runGate(deps: GateDeps, request: WriteRequest): Promise<GateResult>
// PR 9  src/main/safety/index.ts: the six Safety methods as functions of the same names, `deps: SafetyDeps` first
// PR 10  src/main/fixes/index.ts, disable.ts, handlers.ts: the Fixes methods the same way, `deps: FixDeps` first
//        (apply is exported as applyFix), plus:
planFix(scan: Scan, request: FixRequest, at: PlanFixAt):
  { status: 'planned'; plan: ActionPlan } | { status: 'refused'; refusal: FixRefusal } // pure
DISABLE: DisableMechanism
// PR 11  src/main/fiftyfifty/index.ts, handlers.ts
type FiftyDeps = Pick<AppContext, 'fixes' | 'gate' | 'paths' | 'clock' | 'newId' | 'host'>
begin(groups: ModGroup[], init: { id: string; startedAt: IsoTime; folderPath: string }): FiftyFifty // pure
answer(state: FiftyFifty, given: FiftyAnswer): FiftyFifty // pure
loadState(deps: FiftyDeps): Promise<FiftyFifty | null>
start(deps, scan: Scan) · beginRound(deps) · giveAnswer(deps, given: FiftyAnswer) · stop(deps)
finish(deps, keep: 'keep-set-aside' | 'put-back') // these five return Promise<FiftyResult>
// PR 12  src/main/assist/key-store.ts (Fable), src/main/assist/index.ts, handlers.ts
keyStatus · setKey · clearKey · sendWithKey // the four KeyStore methods, `deps: KeyStoreDeps` first
assistOffer(scan: Scan | null, key: KeyStatus): 'offer' | 'hide' // pure
buildPreview(scan: Scan, redact: (text: string) => string, id: string): AssistPreview // pure
ask(keyStore: KeyStore, preview: AssistPreview): Promise<AssistAnswer>
ASSIST_MODEL = 'claude-haiku-5-5'
// PR 13  src/main/update/updater.ts (Fable), src/main/update/handlers.ts
createUpdater(input: UpdaterInput, seams?: UpdaterSeams): Updater // seams: { engine?, busy?, now? }; index.ts passes busy = ctx.busy
// the stub takes (input, seams?: { busy?: () => boolean }) and is always { state: 'off', why: 'switched-off' }
// services.ts: updaterKeepOutOf(documentsDirs, paths) = Documents dirs + paths.oneDriveRoots + paths.dataDir, deduped
```

## 5. The write gate (PR 8, written by Fable)

`runGate` is the only code that changes the disk. It **does** the operations; it is not a check before someone
else's write. It sorts every path an op writes into a zone, after resolving links and without regard to letter case.
The source of a `copy` is only read, so it may be anywhere inside the Sims folder or `dataDir`.

| Zone | Paths | Before any op runs |
|---|---|---|
| forbidden | `<folderPath>/saves/**`, `<folderPath>/Tray/**` | always refused: `saves-or-tray` |
| mods | `<folderPath>/Mods/**` | game `not-running` and backup `verified` |
| caches | `<folderPath>/<one of CACHE_NAMES>` | same |
| options | `<folderPath>/Options.ini` | same |
| app data | `<dataDir>/**` | nothing (the backup, journal, holding folder, state and key live here) |
| report | `<desktopDir>/Sims Helper report <yyyymmdd-hhmmss>.zip`, `write` with `create` only | nothing |
| anything else | | refused: `outside-allowed-area` |

- A request is all or nothing at the checks: one refused path refuses the whole request and no op runs. Which op is
  allowed in which zone is the table in [`briefs/pr-08.md`](briefs/pr-08.md).
- **Game running** comes from `deps.gameState()`, which `services.ts` wires to PR 3's `checkGameRunning(host)`.
  `running` refuses with `game-running`, `unknown` with `game-state-unknown`.
- **Verified backup** comes from `deps.backupStatus(folderPath)`, wired to PR 9. Only `state: 'verified'` passes;
  `none`, `stale` and `unknown` refuse with `no-verified-backup`. A probe that throws counts as `unknown`.
- `folderPath` must be a real Sims folder: any name, `Options.ini` inside, not a drive or filesystem root (given or
  real path), and not inside a `saves` or `Tray` folder. Otherwise the request is refused with `not-a-sims-folder`. A path that sits in an allowed zone by name but resolves somewhere
  else is refused with `link-escape`. A `dataDir` inside a Sims folder or OneDrive refuses every request.
- **Op semantics (as built in PR 8):** `mkdir` creates parents and succeeds if the folder exists. `copy`, `move` and
  `write` create missing parent folders, in the mods and app-data zones only. `remove` of a missing path counts as
  done. `replace` creates a missing file. `copy` and `move` take plain files only: a folder or a link as the source
  fails, so a caller walks folders itself and skips links. Ops on the Mods folder or `dataDir` itself are refused,
  except `mkdir`. An error inside a check refuses with `check-failed`. The game check runs after the path checks; every path is then
  re-checked right before its own op. `runGate` handles one request at a time, so never call it from inside a gate
  call. `refused` means no op ran (a re-check that fails before the first op is also `refused`). The Sims folder may
  have any name once resolved, as long as it holds `Options.ini` and is not inside a `saves` or `Tray` folder.
- The lint test for the read and write rule in section 1 is `src/main/safety/gate-lint.test.ts`. The contract commit
  ships a first version, so every branch is checked from its first commit; PR 8 owns it from then on and hardens it.

## 6. Disabling a mod group

One interface, `DisableMechanism` (section 3), in `src/main/fixes/disable.ts`. v1 ships one mechanism:

- **`move-to-holding`:** every file of the group moves from `<Mods>/<relPath>` to
  `<holdingDir>/<entryId>/Mods/<relPath>`: outside the Sims folder, relative path kept. One journal entry per group.
  Empty folders left behind in Mods stay. `set-aside-files` uses the same layout.
- **Enable** is `safety.undo(entryId)` of that entry. There is no separate enable code.
- **G1 decides** whether CurseForge downloads a moved file again. If it does, the answer is a second mechanism,
  `rename-in-mods` (same interface, `move` steps inside Mods), and nothing else changes. Do not build it now.

## 7. IPC: `src/shared/ipc.ts`

```ts
export interface IpcInvoke { // renderer asks, main answers
  'settings:get': { req: void; res: Settings } // PR 7 owns this block
  'settings:update': { req: Partial<Settings>; res: Settings } // folderPath must be a folder locate finds now
  'locate:run': { req: void; res: LocateView }
  'scan:run': { req: { folderPath: string; symptom: Symptom }; res: ScanResult } // same folderPath rule
  'game:check': { req: void; res: GameRunState }
  'report:build': { req: void; res: ReportResult }
  'report:reveal': { req: void; res: void } // shows the last report in Explorer
  'backup:status': { req: void; res: BackupStatus } // PR 10 owns this block
  'fix:apply': { req: FixCall; res: FixOutcome }
  'journal:list': { req: void; res: JournalEntry[] } // the first call also runs safety.recover()
  'journal:undo': { req: { entryId: string }; res: FixOutcome }
  'groups:disabled': { req: void; res: DisabledGroup[] }
  'fifty:get': { req: void; res: FiftyFifty | null } // PR 11 owns this block
  'fifty:start': { req: void; res: FiftyResult }
  'fifty:begin-round': { req: void; res: FiftyResult }
  'fifty:answer': { req: { answer: FiftyAnswer; round: number }; res: FiftyResult } // the round on her screen
  'fifty:stop': { req: void; res: FiftyResult }
  'fifty:finish': { req: { keep: 'keep-set-aside' | 'put-back' }; res: FiftyResult }
  'assist:status': { req: void; res: AssistStatus } // PR 12 owns this block
  'assist:preview': { req: void; res: AssistPreview | null }
  'assist:send': { req: { previewId: string }; res: AssistAnswer }
  'assist:set-key': { req: { key: string }; res: KeySetResult } // the only message that carries the key
  'assist:clear-key': { req: void; res: KeyStatus }
  'update:get': { req: void; res: UpdateState } // PR 13 owns this block
  'update:check': { req: { by: 'start' | 'click' }; res: UpdateState } // 'start' checks at most once in 24 hours
  'update:download': { req: void; res: UpdateState } // only from 'available'
  'update:install': { req: void; res: UpdateInstall } // only from 'ready'; 'busy' while ctx.busy()
}
export interface IpcEvents { progress: Progress } // main tells the renderer
export const INVOKE_CHANNELS: readonly (keyof IpcInvoke)[] // every key above; preload refuses any other channel
export type Handlers<K extends keyof IpcInvoke> = { [C in K]: (req: IpcInvoke[C]['req']) => Promise<IpcInvoke[C]['res']> }
export interface SimsHelperApi { // window.simsHelper
  invoke<K extends keyof IpcInvoke>(channel: K, ...req: IpcInvoke[K]['req'] extends void ? [] : [IpcInvoke[K]['req']]): Promise<IpcInvoke[K]['res']>
  onProgress(listener: (progress: Progress) => void): () => void // returns "stop listening"
}
```

Each UI PR owns one handlers file exporting `<name>Handlers(ctx: AppContext): Handlers<its channels>`: `scanHandlers`
(PR 7, `src/main/scan/handlers.ts`), `fixHandlers` (PR 10), `fiftyHandlers` (PR 11), `assistHandlers` (PR 12),
`updateHandlers` (PR 13, `src/main/update/handlers.ts`). `src/main/ipc.ts` (contract) registers all five and accepts calls only from the app's own window. A handler never
trusts a path or a list of files from the renderer.

## 8. The AI key store (PR 12; Fable writes `key-store.ts`)

- `key-store.ts` is the only file that holds the key in the clear, decrypts it, or hands it to the network. It builds
  its cipher from `deps.safeStorage` (Electron `safeStorage`, Windows DPAPI) and its own default transport on
  `@anthropic-ai/sdk`. The encrypted bytes go to `paths.keyFile` through the gate (`reason: 'key'`).
- The key crosses IPC once, renderer to main, in `assist:set-key`. No type that travels main to renderer can hold it:
  the renderer learns only `KeySetResult` or `KeyStatus`. `encryption-unavailable` means nothing is stored; the key
  is never written in the clear. `not-saved` means the new key was refused and the old one is still stored.
- The key never appears in a log line, an error message, a thrown error, the report zip, the journal or
  `settings.json`. Errors from the SDK are mapped to `AssistReply` reasons and their text is dropped. An HTTP 401 is
  `key-rejected`, not `no-key`.
- Tests and CI use a fake `transport` and a made-up key. No test calls the network.

## 9. Renderer

- **Library:** shadcn/ui (Radix base) on Tailwind CSS v4 with `@tailwindcss/vite`, Lucide icons, Sonner toasts. The
  primitives in `src/renderer/components/ui/` belong to the contract. A PR that needs another one adds it in its own
  folder.
- **Routing:** no router package. `src/renderer/nav.tsx` holds a `Route` union (`{ screen: '<route>' }`) and
  `useNav()` (`route`, `go(route)`). `src/renderer/App.tsx` is the shell: header (emblem, name, nav), the screen for
  the route, and the footer line "Saves and Tray are never touched · A backup is made before any change". The shell
  never calls IPC: a screen or slot that needs data asks for it, so a stub never reaches a stub handler.
- **Shared state:** `src/renderer/session.tsx` gives `useSession()` (`scan`, `setScan`, `symptom`, `setSymptom`).
  The check-up screen scans whenever `scan` is `null`, so "check again" is `setScan(null)` then `go` to `check-up`.
  `src/renderer/api.tsx` gives `useApi()`, the typed `window.simsHelper`; tests wrap a screen in
  `<ApiProvider value={fakeApi(...)}>`.

| Route | File under `src/renderer/` (stub from the contract) | Owner |
|---|---|---|
| `start` (first route; the stub goes straight to `about`) | `screens/Start.tsx` | PR 7 |
| `welcome`, `pick-folder`, `what-happened`, `check-up`, `send-to-tyler` | `screens/Welcome.tsx`, `PickFolder.tsx`, `WhatHappened.tsx`, `CheckUp.tsx`, `SendToTyler.tsx` | PR 7 |
| `about` | `About.tsx` (exists) | PR 7 |
| `mods`, `history` | `fixes/ModsScreen.tsx`, `fixes/HistoryScreen.tsx` | PR 10 |
| `fifty-fifty` | `fiftyfifty/FiftyFiftyScreen.tsx` | PR 11 |
| `ask-for-help`, `key-setup` (opened with Ctrl+Shift+K) | `assist/AskScreen.tsx`, `assist/KeySetupScreen.tsx` | PR 12 |

Slots, so no PR edits another PR's screen. Each is a stub that renders nothing until its owner fills it:

| Slot | Rendered by | Owner |
|---|---|---|
| `fixes/FindingActions.tsx` `<FindingActions finding />` | PR 7's finding card | PR 10 |
| `fixes/RecoveryNotice.tsx` | shell, under the header | PR 10 |
| `fixes/feature.ts` `FIXES_READY` (stub: `false`) | shell shows "Your mods" and "History" when `true` | PR 10 |
| `fiftyfifty/FiftyEntry.tsx` `<FiftyEntry scan />` | PR 7's check-up screen, under the cards | PR 11 |
| `fiftyfifty/ResumeBanner.tsx` | shell, under the header | PR 11 |
| `assist/AskEntry.tsx` `<AskEntry scan />` | PR 7's check-up screen, under the cards | PR 12 |
| `update/UpdateBanner.tsx` | shell, first under the header | PR 13 |
| `update/UpdateRow.tsx` | the `about` route, after `<About />` | PR 13 |

**Content-Security-Policy.** The built page gets `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none';
frame-src 'none'; form-action 'none'` from a build-only Vite plugin in `electron.vite.config.ts` (`cspAtBuild`). The
source `index.html` has none, so `npm run dev` can run the React plugin's inline script.

**Look (Tyler approves it at the end).** A house-with-a-sparkle emblem (`components/Emblem.tsx`, also the app icon),
never a diamond or gem. Plus Jakarta Sans, bundled with `@fontsource-variable`, body text 15 px or larger. The native
Windows title bar, no menu bar. Light and dark follow Windows through `prefers-color-scheme`. Colors come only from
the tokens in `src/renderer/styles.css` (palette: `docs/research/neon-ui.md`, section 2): no hex values in a PR's
files. Severity always shows an icon and a word, never color alone: `stop` "Do this first", `warn` "Worth fixing",
`info` "Good to know". Window 960 × 700, minimum 500 × 520. Use the players' own words: mods folder, script mods,
broken CC, 50/50, last exception, patch day (`docs/research/grok-ui-x.md`).

## 10. Test and CI seams

- **Fixtures.** `npm run fixtures` builds `test/fixtures/<spec>/`. A test that changes files first builds its tree in
  a temp folder (`generateFixture(await loadSpec(...), tmpDir)`), never in `test/fixtures/`. The generator and the
  existing specs are frozen; a PR may add `scripts/fixtures/specs/<its slug>-*.json`.
- **Sample data.** `src/shared/testing/sample.ts` (contract): `sampleScan(overrides?)`, `sampleFinding`,
  `sampleJournalEntry`, `sampleFiftyFifty` (round 1, with the round 0 control in its history). Component tests and
  screenshots use these. `fakeApi()` answers `update:get` and `update:check` with `off` unless a test passes its own.
- **Screens while main is stubs.** `test/e2e/support/app.ts` (contract): `launchApp(options?)`;
  `stubIpc(app, { '<channel>': value | inOrder([...]) })`, which replaces handlers inside the running main process
  and reloads the window, so no fake code ships in the app; and `shoot(page, '<pr-slug>', '<name>')`, which saves
  `test-results/screens/<pr-slug>/<name>-light.png` and `-dark.png` at 960 × 700.
- **Playwright projects** (contract): `smoke` (`test/e2e/app.spec.ts`), `screens` (`test/e2e/screens/*.spec.ts`,
  stubbed IPC, passes on any branch), `live` (`test/e2e/live/*.spec.ts`, the real code on a fixture, Windows only).
- **Live runs.** `launchApp({ fixture: 'patch-day' })` copies the fixture to a temp folder and starts the app with
  `SIMS_HELPER_DOCUMENTS_DIR`, `SIMS_HELPER_DESKTOP_DIR`, `LOCALAPPDATA`, `APPDATA`, `USERNAME`, `ProgramFiles` and
  `ProgramFiles(x86)` pointing into it. `src/main/app-host.ts` (contract) reads the two `SIMS_HELPER_*` variables.
  Every `launchApp` sets `SIMS_HELPER_UPDATES=off` unless the caller's `env` overrides it, so no test reaches GitHub.
- **CI.** `ci.yml` runs `smoke` and `screens` for every PR and uploads the artifact `screens`. After the silent
  install it checks `dist/latest.yml` and the installed `resources\app-update.yml` (provider `github`, this repo). It runs `live` only
  on pushes to `main` and on PRs whose base is `main` (details in `ownership.md`).
- **Two bars per PR.** *Branch bar:* your unit tests and `screens` spec pass on your branch, neighbors as fakes.
  *Main bar:* once the PRs you depend on are in `main` and you have merged `main` into your branch, your `live` spec
  and your "after main" tests pass. A slot that PR 7's check-up screen hosts can only be photographed then, so each
  UI brief splits its screenshots into branch shots and after-main shots.

What only G1 on her PC can settle is listed in [`merge-order.md`](merge-order.md).
