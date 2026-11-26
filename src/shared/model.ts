// ── PR 3, unchanged
export type PackCode = `${'EP' | 'GP' | 'SP' | 'FP'}${string}`

export interface SimsFolder {
  path: string
  inOneDrive: boolean
  /**
   * Newest date among files the game itself writes (settings, logs, saves). Mods, Tray and caches
   * are left out: other programs write those. The epoch when the folder has none of these files.
   */
  newestFileAt: Date
}

export interface GameInstall {
  path: string
  version: string
  packs: PackCode[]
}

// ── Basics
/** The same union as in src/main/locate/process.ts. Every writer treats 'unknown' like 'running'. */
export type GameRunState = 'running' | 'not-running' | 'unknown'
export type IsoTime = string // Date.toISOString(), UTC
export type RelPath = string // relative to Mods/, forward slashes, no leading slash, no '..'
export type Sha256 = string // 64 lowercase hex digits

// ── Mods inventory (PR 4)
export interface ResourceKey {
  type: string
  group: string
  instance: string
} // '0x' + 8, 8, 16 uppercase hex digits

export type DbpfIndex =
  | { status: 'ok'; keys: ResourceKey[] } // version 2.1
  | { status: 'wrong-game'; major: number; minor: number; game: 'sims2' | 'sims3' | 'simcity' | 'unknown' }
  | { status: 'broken'; problem: 'too-short' | 'bad-magic' | 'bad-index'; detail: string }
  | { status: 'unreadable'; detail: string } // the file could not be opened or read

/** What a scan keeps: the count, not the keys. No v1 rule uses the keys. */
export type DbpfSummary = { status: 'ok'; keyCount: number } | Exclude<DbpfIndex, { status: 'ok' }>

export type ScriptRead = // entries: paths inside the .ts4script, forward slashes
  | { status: 'ok'; entries: string[] }
  | { status: 'broken'; detail: string }
  | { status: 'unreadable'; detail: string }

/** A file is hashed only when another file in Mods has the same byte count. */
export type FileHash =
  | { status: 'hashed'; sha256: Sha256 }
  | { status: 'not-needed' }
  | { status: 'unreadable'; detail: string }

/** kind goes by extension, any letter case: .package, .ts4script, then .zip .rar .7z, then everything else. */
export type ModFile = {
  relPath: RelPath
  bytes: number
  modifiedAt: IsoTime
  hash: FileHash
  groupId: string
  depth: number // folders between Mods and the file: Mods/a.package is 0
} & (
  | { kind: 'package'; dbpf: DbpfSummary }
  | { kind: 'script'; script: ScriptRead }
  | { kind: 'archive' }
  | { kind: 'other' }
)

export interface ModGroup {
  id: string // 'cf:<addonId>' | 'dir:<top folder, lowercased>' | 'file:<relPath, lowercased>'
  label: string // CurseForge name, folder name, or file name without its extension
  source: 'curseforge' | 'folder' | 'loose'
  files: RelPath[]
  bytes: number
  hasScript: boolean
  curseForge: { addonId: number; fileId: number; fileDate: IsoTime } | null
}

export type ResourceCfgRead =
  | { status: 'ok'; maxPackageDepth: number }
  | { status: 'missing' }
  | { status: 'unreadable'; detail: string }

export interface CurseForgeAddon {
  addonId: number
  fileId: number
  name: string
  fileNameOnDisk: string
  fileDate: IsoTime
  moduleNames: string[]
}

export type CurseForgeRead =
  | { status: 'found'; file: string; addons: CurseForgeAddon[] }
  | { status: 'not-found' }
  | { status: 'unreadable'; detail: string }

export interface Inventory {
  modsDir: string
  modsDirState: 'present' | 'missing'
  files: ModFile[] // sorted by relPath; Mods/Resource.cfg is left out
  groups: ModGroup[] // every file is in exactly one group
  resourceCfg: ResourceCfgRead
  curseForge: CurseForgeRead
  skipped: { relPath: RelPath; detail: string }[] // what the walk could not read
}

// ── Logs (PR 5)
export type LogKind = 'exception' | 'uiException' | 'crash' | 'betterExceptions' | 'mccc'

export interface LogFrame {
  path: string
  line: number | null
  origin: 'game' | 'mod'
}

export interface LogReport {
  file: string
  kind: LogKind // file: relative to the Sims folder, forward slashes
  fileModifiedAt: IsoTime // the log file's own date; logs are ordered by this
  createdLocal: string | null // <createtime> as the game wrote it
  gameVersion: string | null
  categoryId: string | null // version: d.d.d.d from <buildsignature>
  message: string | null // first line of the error text, 300 characters at most
  count: number // reports in this file with this categoryId
  frames: LogFrame[] // innermost last, 60 at most; always empty for 'crash'
  modHints: string[] // one per distinct mod frame: path lowercased, '\' to '/', extension dropped
  completeness: 'complete' | 'cut-off'
}

// ── Folder facts and findings (PR 6)
export type ModSwitch = 'on' | 'off' | 'missing'

export type OptionsRead =
  | { status: 'ok'; mods: ModSwitch; scriptMods: ModSwitch }
  | { status: 'missing' }
  | { status: 'unreadable'; detail: string }

export interface FolderFacts {
  options: OptionsRead
  gameUpdatedAt: IsoTime | null // date of <install>/Game/Bin/TS4_x64.exe (G1 confirms it tracks patches)
  thumbCacheAt: IsoTime | null // date of localthumbcache.package
}

export type RuleId =
  | 'mods-off'
  | 'folder-in-onedrive'
  | 'two-sims-folders'
  | 'log-names-mod'
  | 'script-too-deep'
  | 'package-too-deep'
  | 'archive-in-mods'
  | 'broken-package'
  | 'wrong-game-package'
  | 'duplicate-files'
  | 'script-older-than-update'
  | 'stale-thumbnail-cache'
  | 'crash-without-cause'

export type Severity = 'stop' | 'warn' | 'info'
export type Certainty = 'file-problem' | 'likely' | 'worth-testing' // badge: "File problem found", "Likely cause", "Worth testing"

export type FixRequest =
  | { fix: 'turn-mods-on' }
  | { fix: 'clear-caches' }
  | { fix: 'move-script-up'; files: RelPath[] }
  | { fix: 'move-package-up'; files: RelPath[] }
  | { fix: 'set-aside-files'; files: RelPath[] }
  | { fix: 'disable-group'; groupId: string }
  | { fix: 'enable-group'; groupId: string }

export type FixId = FixRequest['fix']

export interface Finding {
  id: string // the RuleId, or '<RuleId>:<groupId>' for 'log-names-mod'
  rule: RuleId
  severity: Severity
  certainty: Certainty
  title: string
  detail: string // the words she reads
  evidence: string[] // lines for the closed "Technical details" box
  files: RelPath[]
  groupIds: string[] // what the finding is about
  fixes: FixRequest[] // ready to run; empty when there is no one-click fix
  next: 'none' | 'fifty-fifty' | 'pick-folder'
}

// ── Scan (PR 7)
export type Symptom = 'closes' | 'freezes' | 'wont-load' | 'one-save-or-lot' | 'not-sure'

export interface Scan {
  id: string
  at: IsoTime
  tookMs: number
  symptom: Symptom
  folder: SimsFolder
  otherFolders: SimsFolder[]
  game: GameInstall | null
  gameRunning: GameRunState
  facts: FolderFacts
  inventory: Inventory
  logs: LogReport[]
  findings: Finding[]
}

export type ScanResult =
  | { status: 'done'; scan: Scan }
  | { status: 'failed'; why: 'folder-not-found' | 'folder-unreadable' | 'unexpected'; detail: string }

export interface Progress {
  task: 'scan' | 'backup' | 'fix' | 'share'
  stage: 'counting' | 'mods' | 'logs' | 'rules' | 'copying' | 'checking' | 'moving' | 'sending' | 'getting'
  done: number
  total: number | null // null while still counting
}

export interface Settings {
  welcome: 'not-seen' | 'seen'
  folderPath: string | null
}

export interface LocateView {
  folders: SimsFolder[]
  game: GameInstall | null
  gameRunning: GameRunState
}

export type ReportResult =
  | { status: 'saved'; fileName: string; entries: string[] }
  | { status: 'failed'; why: 'no-scan' | 'write-refused' | 'unexpected'; detail: string }

// ── Safety (PRs 8 and 9)
export type GateRefusal =
  | { reason: 'saves-or-tray'; path: string }
  | { reason: 'outside-allowed-area'; path: string }
  | { reason: 'link-escape'; path: string }
  | { reason: 'not-a-sims-folder'; path: string }
  | { reason: 'game-running' }
  | { reason: 'game-state-unknown' }
  | { reason: 'no-verified-backup'; backup: 'none' | 'stale' | 'unknown' }
  | { reason: 'check-failed'; path: string } // a check itself errored; fail closed

export type BackupStatus =
  | { state: 'verified'; backupId: string; at: IsoTime }
  | { state: 'stale'; backupId: string; at: IsoTime }
  | { state: 'none' }
  | { state: 'unknown'; detail: string }

export interface BackupRecord {
  id: string
  at: IsoTime
  folderPath: string
  files: number
  bytes: number
  state: 'copying' | 'verified' | 'failed'
}

export type BackupRefusal =
  | 'game-running'
  | 'game-state-unknown'
  | 'backup-folder-in-onedrive'
  | 'not-enough-space'
  | 'sims-folder-missing'
  | 'backup-already-running'
  | 'backup-folder-in-sims-folder'

export type BackupResult =
  | { status: 'verified'; record: BackupRecord }
  | { status: 'refused'; reason: BackupRefusal }
  | { status: 'failed'; detail: string }

export type StepState = 'pending' | 'applied' | 'reverted'

export type JournalStep =
  | { kind: 'move'; from: string; to: string; bytes: number; sha256: Sha256; state: StepState }
  | { kind: 'edit'; path: string; savedCopy: string; beforeSha256: Sha256; afterSha256: Sha256; state: StepState }
  | { kind: 'remove-cache'; path: string; state: StepState } // never undone: the game rebuilds caches

/** Enabling a group is the undo of its disable entry. The two share kinds are a save swap (PR 14). */
export type ActionKind = Exclude<FixId, 'enable-group'> | 'share-receive' | 'share-restore'

export type JournalOrigin =
  | { by: 'fix' }
  | { by: 'fifty-fifty'; sessionId: string; round: number }
  | { by: 'share'; shareId: string; seq: number | null } // seq null: an old copy put back

export interface JournalEntry {
  id: string
  at: IsoTime
  action: ActionKind
  summary: string
  origin: JournalOrigin
  folderPath: string
  groupId: string | null
  groupLabel: string | null // the group's label when the entry is about one group, copied from ActionPlan
  hasScript: boolean // the group has a .ts4script; false when groupId is null
  backupId: string | null // null: the entry made no backup, which is every save swap (share-receive, share-restore)
  steps: JournalStep[]
  status: 'in-progress' | 'done' | 'undone' | 'needs-attention'
  undo: 'can-undo' | 'cannot-undo'
  undoneAt: IsoTime | null
}

/** What the start-up recovery did (journal:recovery): the entries it settled, or that it could not run at all. */
export type StartupRecovery = { status: 'finished'; touched: JournalEntry[] } | { status: 'failed' }

// ── Fixes (PR 10)
/** What the renderer sends. Main looks the request up in its own last scan. */
export type FixCall =
  | { via: 'finding'; findingId: string; fix: FixId }
  | { via: 'group'; fix: 'disable-group' | 'enable-group'; groupId: string }

export type FixRefusal =
  | { why: 'gate'; refusal: GateRefusal }
  | { why: 'backup'; reason: BackupRefusal | 'backup-failed' }
  | { why: 'out-of-date'; detail: 'no-scan' | 'unknown-finding' | 'unknown-group' | 'file-changed' | 'nothing-to-do' }
  | { why: 'fifty-fifty-running' }
  | { why: 'not-started' } // the action failed before anything changed (for example the journal could not be written)

export type FixOutcome =
  | { status: 'done'; entry: JournalEntry }
  | { status: 'refused'; refusal: FixRefusal } // refused: nothing changed
  | { status: 'stopped-part-way'; entry: JournalEntry; detail: string } // History shows it and can undo it

export interface DisabledGroup {
  groupId: string
  label: string
  entryId: string
  at: IsoTime
  origin: JournalOrigin['by'] // 'fix' or 'fifty-fifty': who set the group aside
}

// ── 50/50 (PR 11)
export type FiftyPhase = 'close-curseforge' | 'ready-to-test' | 'awaiting-answer' | 'found' | 'stopped'
export type FiftyAnswer = 'crashed' | 'worked' | 'not-sure'

export interface FiftyFifty {
  id: string
  startedAt: IsoTime
  folderPath: string
  phase: FiftyPhase
  round: number // 0 is the control round: every group set aside. The halving rounds follow from 1
  roundsAtMost: number // ceil(log2(groups at the start)) + 1, the control round included
  groups: ModGroup[] // as scanned when the test started
  suspects: string[] // group ids that may still be the cause; script groups first, then by label
  parked: string[]
  inMods: string[] // the half of the suspects set aside this round, and the half still in Mods
  cleared: string[]
  culprit: string | null // cleared: ruled out and back in Mods
  history: { round: number; parked: string[]; answer: FiftyAnswer }[]
}

/** fiftyfifty.json is there but cannot be read as a session. Her way out is `fifty:stop`, which puts every group back. */
export interface FiftyDamaged {
  status: 'damaged'
}

/** What `fifty:get` answers: the session, null when there is none, or FiftyDamaged. FiftyFifty has no `status`. */
export type FiftyGet = FiftyFifty | null | FiftyDamaged

export type FiftyResult =
  | { status: 'ok'; state: FiftyFifty | null }
  | { status: 'refused'; refusal: FixRefusal }
  | { status: 'stopped-part-way'; state: FiftyFifty; detail: string }

/**
 * A stop on a damaged progress file that ended part way: there is no session to hand back, so `state` is null.
 * notBack: the labels of the groups the 50/50 test set aside that are still out of Mods, in every folder it ran
 * on. Groups she set aside herself (origin 'fix') are never listed. Stop can be tried again.
 */
export interface FiftyStopPartWay {
  status: 'stopped-part-way'
  state: null
  notBack: string[]
  detail: string
}

/** What `fifty:stop` answers: a FiftyResult, or FiftyStopPartWay when the damaged-file put-back ends part way. */
export type FiftyStopResult = FiftyResult | FiftyStopPartWay

// ── AI help (PR 12)
export type KeyStatus = 'set' | 'not-set' | 'encryption-unavailable'
/** What setKey answers: a KeyStatus, or 'not-saved' when the new key was refused and the old one is still stored. */
export type KeySetResult = KeyStatus | 'not-saved'

export interface AssistStatus {
  key: KeyStatus
  offer: 'offer' | 'hide'
}

export interface AssistPreview {
  id: string
  text: string
} // text: exactly what will be sent

export type AssistAnswer =
  | { status: 'answered'; text: string }
  | { status: 'no-answer'; why: 'no-key' | 'key-rejected' | 'declined' | 'offline' | 'limit-reached' | 'preview-expired' | 'error' } // key-rejected: HTTP 401

// ── Updates (PR 13)
export type UpdateState =
  | { state: 'off'; current: string; why: 'not-installed-app' | 'switched-off' | 'unsafe-install-folder' } // current: About shows it
  | { state: 'idle'; current: string; checkedAt: IsoTime | null; justUpdated: boolean }
  | { state: 'checking'; current: string }
  | { state: 'available'; current: string; next: string }
  | { state: 'downloading'; current: string; next: string; percent: number }
  | { state: 'ready'; current: string; next: string } // downloaded, checksum passed, waits for her click
  | { state: 'failed'; current: string; step: 'check' | 'download'; why: 'offline' | 'bad-file' | 'error' }

export type UpdateInstall = { status: 'restarting' } | { status: 'refused'; why: 'busy' | 'not-ready' }

// ── Share saves (PR 14)
export type PcRole = 'lila' | 'tyler'

export type ShareLinkState =
  | { state: 'no-role' }
  | { state: 'no-folder' }
  | { state: 'folder-missing' } // chosen before, not there now
  | { state: 'waiting'; since: IsoTime }
  | { state: 'same-role' } // the other PC says it is this PC
  | { state: 'connected'; otherSeenAt: IsoTime; otherHeardUs: boolean }
  | { state: 'damaged' } // share.json cannot be read

export interface ShareSettings {
  role: PcRole | null
  folderLabel: string | null
  keepOld: number
  keepInDrive: number
}

export interface LocalSave {
  slotId: string // 'Slot_0000000a', never a path
  savedAt: IsoTime
  bytes: number
  shareId: string | null
}

export type ModNeed = { key: string; name: string; hasScript: boolean; state: 'missing' | 'other-version' } & (
  | { source: 'curseforge'; linkId: string }
  | { source: 'other'; files: string[]; linkId: string | null; shownLink: string | null } // shownLink: the full address
)

export interface ShareNeeds {
  game: 'same' | 'theirs-newer' | 'theirs-older' | 'unknown'
  theirVersion: string | null
  packs: { code: PackCode; name: string | null }[]
  mods: ModNeed[]
  modsOff: boolean // mods are off on this PC
}

export interface IncomingSave {
  seq: number
  from: PcRole
  sentAt: IsoTime
  state: 'arriving' | 'ready' | 'damaged' | 'needs-newer-app'
  will: 'replace' | 'add' | 'ask' | null
  needs: ShareNeeds | null // null until the manifest can be read
}

export interface SharedSave {
  shareId: string
  name: string
  here: { slotId: string; savedAt: IsoTime; changed: boolean } | null // changed: played here since the last handoff
  lastSent: { seq: number; at: IsoTime; gotAt: IsoTime | null } | null
  incoming: IncomingSave | null
  ask: 'which-to-keep' | null
  canSend: 'yes' | 'nothing-new' | 'get-first' | 'answer-first' | 'save-missing'
}

export interface ShareView {
  link: ShareLinkState
  settings: ShareSettings
  saves: SharedSave[]
  aiFind: 'offer' | 'hide'
}

export type ShareRefusal =
  | { why: 'gate'; refusal: GateRefusal }
  | { why: 'backup'; reason: BackupRefusal | 'backup-failed' }
  | { why: 'game-running' }
  | { why: 'game-state-unknown' }
  | { why: 'fifty-fifty-running' }
  | { why: 'not-connected' }
  | { why: 'state-damaged' }
  | { why: 'not-ready'; state: 'arriving' | 'damaged' | 'needs-newer-app' }
  | { why: 'game-older'; theirs: string; ours: string }
  | { why: 'nothing-new' }
  | { why: 'get-first' }
  | { why: 'answer-first' }
  | { why: 'out-of-date'; detail: 'unknown-save' | 'unknown-share' | 'file-changed' | 'no-free-slot' }

export type ShareSendResult =
  | { status: 'sent'; view: ShareView }
  | { status: 'refused'; refusal: ShareRefusal }
  | { status: 'failed'; detail: string }

export type ShareReceiveResult =
  | { status: 'replaced' | 'added' | 'kept-both' | 'restored'; entry: JournalEntry; view: ShareView }
  | { status: 'already-here'; view: ShareView }
  | { status: 'refused'; refusal: ShareRefusal }
  | { status: 'stopped-part-way'; entry: JournalEntry; detail: string }

export interface OldSave {
  oldId: string
  shareId: string
  name: string
  savedAt: IsoTime
  replacedAt: IsoTime
  bytes: number
}

export interface FindPreview {
  id: string
  text: string // exactly what will be sent
}

export type FindAnswer =
  | { status: 'found'; linkId: string; shownLink: string; host: string; place: 'usual' | 'creator-site' | 'not-usual'; why: string }
  | { status: 'not-found' }
  | { status: 'no-answer'; why: Extract<AssistAnswer, { status: 'no-answer' }>['why'] }
