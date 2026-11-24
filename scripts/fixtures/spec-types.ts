import type { DbpfVariant } from './dbpf.ts'

export interface ResourceKeySpec {
  type: string
  group: string
  instance: string
}

export interface PackageFileSpec {
  /** Relative path inside Mods/, using forward slashes. */
  relPath: string
  keys: ResourceKeySpec[]
  variant?: DbpfVariant
  constantFlags?: number
  mtime?: string
  /** Optional explicit payload seed so two packages can be made byte-identical or distinct. */
  payloadSeed?: number
}

export interface ScriptFileSpec {
  /** Relative path inside Mods/, using forward slashes. */
  relPath: string
  /** Entry paths inside the .ts4script zip (typically .pyc files). */
  entries: string[]
  mtime?: string
  /** Optional explicit seed for deterministic dummy .pyc contents. */
  payloadSeed?: number
}

export interface ArchiveFileSpec {
  /** Relative path inside Mods/, using forward slashes (e.g. Unpacked.zip). */
  relPath: string
  entries: Array<{ name: string; content: string }>
  mtime?: string
}

export interface ExtraModFileSpec {
  /** Relative path inside Mods/, using forward slashes. */
  relPath: string
  content: string
  mtime?: string
}

export interface BulkModsSpec {
  packageCount: number
  scriptCount: number
  maxPackageDepth: number
  maxScriptDepth: number
}

export interface OptionsIniSpec {
  modsdisabled: 0 | 1
  scriptmodsenabled: 0 | 1
  showmodliststartup?: 0 | 1
}

export interface LastExceptionReportSpec {
  sessionId: string
  createTime: string
  buildSignature: string
  categoryId: string
  sku?: string
  message: string
  tracebackLines: string[]
  footerLines?: string[]
}

export interface LastExceptionFileSpec {
  fileName: string
  reports: LastExceptionReportSpec[]
  /** If true, cuts off the XML mid-report to test fallback parsing. */
  truncated?: boolean
  mtime?: string
}

export interface LastUiExceptionFileSpec {
  fileName: string
  sessionId: string
  createTime: string
  buildSignature: string
  categoryId: string
  errorText: string
  mtime?: string
}

export interface LastCrashFileSpec {
  fileName: string
  sessionId: string
  createTime: string
  buildSignature: string
  categoryId: string
  stack?: string
  mtime?: string
}

export interface BetterExceptionsFileSpec {
  fileName: string
  createTime: string
  buildSignature: string
  categoryId: string
  possibleCause: string
  confidence: number
  recommendedAction: string
  rawReport: LastExceptionReportSpec
  modList: string[]
  mtime?: string
}

export interface McccExceptionFileSpec {
  /** Relative path inside Mods/, e.g. MCCC/mc_lastexception.html */
  relPath: string
  createTime: string
  gameVersion: string
  tracebackLines: string[]
  mtime?: string
}

export interface UserFolderLogsSpec {
  lastExceptions?: LastExceptionFileSpec[]
  lastUiExceptions?: LastUiExceptionFileSpec[]
  lastCrashes?: LastCrashFileSpec[]
  betterExceptions?: BetterExceptionsFileSpec[]
  mcccExceptions?: McccExceptionFileSpec[]
}

export interface UserFolderSpec {
  /** Relative path under the fixture root, e.g. Users/Player/Documents/Electronic Arts/The Sims 4 */
  relPath: string
  gameVersion: string
  gameVersionMtime?: string
  options: OptionsIniSpec
  optionsMtime?: string
  /** Number of subfolder levels allowed in Resource.cfg (default 5). */
  resourceCfgDepth?: number
  /** mtime for localthumbcache.package (defaults to baseTime). */
  thumbCacheMtime?: string
  /** Optional override for save/tray/config mtimes (useful for stale secondary folders). */
  folderMtime?: string
  packages?: PackageFileSpec[]
  scripts?: ScriptFileSpec[]
  archives?: ArchiveFileSpec[]
  extraModFiles?: ExtraModFileSpec[]
  bulkMods?: BulkModsSpec
  logs?: UserFolderLogsSpec
}

export interface GameInstallSpec {
  /** Relative path under the fixture root, e.g. Program Files/EA Games/The Sims 4 */
  relPath: string
  version: string
  /** Installed pack folders created directly in the install dir (EP##, GP##, SP##, FP##). */
  packs: string[]
  /** Optional pack folders created ONLY inside Delta/ (patch data, not installed packs). */
  deltaOnlyPacks?: string[]
}

export interface CurseForgeAddonSpec {
  addonID: number
  fileId: number
  displayName: string
  fileNameOnDisk: string
  fileDate: string
  releaseType: 1 | 2 | 3
  downloadUrl: string
  modules: Array<{ name: string; fingerprint: number }>
}

export interface CurseForgeSpec {
  /** Relative path under fixture root, e.g. Users/Player/AppData/Roaming/CurseForge/agent/GameInstances/AddonGameInstance.json */
  relPath: string
  gameInstanceGuid: string
  installPath: string
  installedAddons: CurseForgeAddonSpec[]
}

export interface FixtureSpec {
  name: string
  description: string
  seed: number
  baseTime: string
  gameInstall: GameInstallSpec
  userFolders: UserFolderSpec[]
  curseForge?: CurseForgeSpec
}
