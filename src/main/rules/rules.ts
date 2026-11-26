// The v1 rules. Each is a pure function from a scan to its findings (none, one, or one per group for log-names-mod).
import * as words from '../../shared/copy/findings.ts'
import type { FindingWords } from '../../shared/copy/findings.ts'
import type { Certainty, Finding, LogKind, ModFile, ModGroup, RelPath, RuleId, Scan, Severity } from '../../shared/model.ts'
import { buildEntryIndex, type EntryOwner, matchHint } from './hints.ts'

export type ScanInput = Omit<Scan, 'findings'>
export type Rule = (scan: ScanInput) => Finding[]

const RULE_KIND: Record<RuleId, { severity: Severity; certainty: Certainty }> = {
  'mods-off': { severity: 'stop', certainty: 'file-problem' },
  'folder-in-onedrive': { severity: 'warn', certainty: 'worth-testing' },
  'two-sims-folders': { severity: 'warn', certainty: 'worth-testing' },
  'log-names-mod': { severity: 'warn', certainty: 'likely' },
  'script-too-deep': { severity: 'warn', certainty: 'file-problem' },
  'package-too-deep': { severity: 'warn', certainty: 'file-problem' },
  'archive-in-mods': { severity: 'warn', certainty: 'file-problem' },
  'broken-package': { severity: 'warn', certainty: 'file-problem' },
  'wrong-game-package': { severity: 'warn', certainty: 'file-problem' },
  'duplicate-files': { severity: 'warn', certainty: 'file-problem' },
  'script-older-than-update': { severity: 'info', certainty: 'worth-testing' },
  'stale-thumbnail-cache': { severity: 'info', certainty: 'file-problem' },
  'crash-without-cause': { severity: 'warn', certainty: 'worth-testing' }
}

export const DEFAULT_PACKAGE_DEPTH = 5 // what the game writes into a fresh Resource.cfg

function finding(
  rule: RuleId,
  text: FindingWords,
  parts: Partial<Pick<Finding, 'id' | 'evidence' | 'files' | 'groupIds' | 'fixes' | 'next'>> = {}
): Finding {
  return {
    id: parts.id ?? rule,
    rule,
    ...RULE_KIND[rule],
    title: text.title,
    detail: text.detail,
    evidence: parts.evidence ?? [],
    files: parts.files ?? [],
    groupIds: parts.groupIds ?? [],
    fixes: parts.fixes ?? [],
    next: parts.next ?? 'none'
  }
}

function groupIdsOf(files: readonly ModFile[]): string[] {
  return [...new Set(files.map((f) => f.groupId))]
}

function isMod(file: ModFile): boolean {
  return file.kind === 'package' || file.kind === 'script'
}

function timeOf(iso: string): number {
  return Date.parse(iso) // NaN for a bad date, which every comparison below treats as false
}

function isoOf(date: Date): string {
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString()
}

function depthNote(file: ModFile): string {
  return `${file.relPath} (${file.depth} ${file.depth === 1 ? 'folder' : 'folders'} deep)`
}

export const modsOff: Rule = (scan) => {
  const options = scan.facts.options
  if (options.status !== 'ok') return []
  const modsAreOff = options.mods === 'off' && scan.inventory.files.some(isMod)
  const scriptModsAreOff = options.scriptMods === 'off' && scan.inventory.files.some((f) => f.kind === 'script')
  if (!modsAreOff && !scriptModsAreOff) return []
  return [
    finding('mods-off', words.modsOffWords({ modsOff: modsAreOff, scriptModsOff: scriptModsAreOff }), {
      evidence: [
        ...(modsAreOff ? ['Options.ini: modsdisabled = 1'] : []),
        ...(scriptModsAreOff ? ['Options.ini: scriptmodsenabled = 0'] : [])
      ],
      fixes: [{ fix: 'turn-mods-on' }]
    })
  ]
}

export const folderInOneDrive: Rule = (scan) =>
  scan.folder.inOneDrive
    ? [finding('folder-in-onedrive', words.folderInOneDriveWords(), { evidence: [`Sims folder: ${scan.folder.path}`] })]
    : []

export const twoSimsFolders: Rule = (scan) => {
  if (scan.otherFolders.length === 0) return []
  return [
    finding('two-sims-folders', words.twoSimsFoldersWords({ folderCount: scan.otherFolders.length + 1 }), {
      evidence: [
        `Checking: ${scan.folder.path}`,
        ...scan.otherFolders.map((f) => `Also found: ${f.path} (newest file ${isoOf(f.newestFileAt)})`)
      ],
      next: 'pick-folder'
    })
  ]
}

type ErrorLogKind = Exclude<LogKind, 'crash'>

export const logNamesMod: Rule = (scan) => {
  const index = buildEntryIndex(scan.inventory.files)
  if (index.size === 0) return []
  type Named = { kinds: ErrorLogKind[]; owners: Map<RelPath, EntryOwner>; evidence: string[] }
  const named = new Map<string, Named>()
  for (const log of scan.logs) {
    if (log.kind === 'crash') continue // a crash log has no traceback, so it never names a mod
    const kind = log.kind
    const logTime = timeOf(log.fileModifiedAt)
    for (const hint of log.modHints) {
      // A log older than the named script file does not count for it (the mod was updated after the error).
      const owners = matchHint(hint, index).filter((owner) => !(logTime < timeOf(owner.modifiedAt)))
      if (owners.length === 0) continue
      const groupId = owners[0]!.groupId
      const entry: Named = named.get(groupId) ?? { kinds: [], owners: new Map(), evidence: [] }
      named.set(groupId, entry)
      entry.kinds.push(kind)
      for (const owner of owners) {
        entry.owners.set(owner.file, owner)
        entry.evidence.push(
          `${log.file}${log.categoryId ? ` (${log.categoryId})` : ''}: mod frame ${hint} matches ${owner.entry} in ${owner.file}`
        )
      }
    }
  }
  const groups = new Map<string, ModGroup>(scan.inventory.groups.map((g) => [g.id, g]))
  return [...named]
    .map(([groupId, found]) => {
      const group = groups.get(groupId)
      // Every file has a group (contracts.md). If one is ever missing, name the file, never the group id.
      const mod = group ?? { label: fileNameOf([...found.owners.keys()][0]!), source: 'loose' as const }
      return finding('log-names-mod', words.logNamesModWords({ mod, logKinds: found.kinds }), {
        id: `log-names-mod:${groupId}`,
        evidence: [...new Set(found.evidence)],
        files: [...found.owners.keys()],
        groupIds: [groupId],
        fixes: [{ fix: 'disable-group', groupId }]
      })
    })
    .sort((a, b) => {
      const byLabel = labelOf(groups, a).localeCompare(labelOf(groups, b), 'en', { sensitivity: 'base' })
      return byLabel !== 0 ? byLabel : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

function fileNameOf(relPath: RelPath): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '')
}

function labelOf(groups: ReadonlyMap<string, ModGroup>, f: Finding): string {
  return groups.get(f.groupIds[0]!)?.label ?? f.groupIds[0]!
}

export const scriptTooDeep: Rule = (scan) => {
  const deep = scan.inventory.files.filter((f) => f.kind === 'script' && f.depth > 1)
  if (deep.length === 0) return []
  const files = deep.map((f) => f.relPath)
  return [
    finding('script-too-deep', words.scriptTooDeepWords({ count: deep.length }), {
      evidence: deep.map(depthNote),
      files,
      groupIds: groupIdsOf(deep),
      fixes: [{ fix: 'move-script-up', files }]
    })
  ]
}

export const packageTooDeep: Rule = (scan) => {
  const cfg = scan.inventory.resourceCfg
  if (cfg.status === 'unreadable') return []
  const maxDepth = cfg.status === 'ok' ? cfg.maxPackageDepth : DEFAULT_PACKAGE_DEPTH
  const deep = scan.inventory.files.filter((f) => f.kind === 'package' && f.depth > maxDepth)
  if (deep.length === 0) return []
  const files = deep.map((f) => f.relPath)
  return [
    finding('package-too-deep', words.packageTooDeepWords({ count: deep.length, maxDepth }), {
      evidence: [
        cfg.status === 'ok'
          ? `Resource.cfg loads packages up to ${maxDepth} folders deep`
          : `Resource.cfg is missing; the game's default is ${maxDepth} folders deep`,
        ...deep.map(depthNote)
      ],
      files,
      groupIds: groupIdsOf(deep),
      fixes: [{ fix: 'move-package-up', files }]
    })
  ]
}

function setAsideRule(rule: RuleId, matched: ModFile[], text: FindingWords, evidence: (file: ModFile) => string): Finding[] {
  if (matched.length === 0) return []
  const files = matched.map((f) => f.relPath)
  return [finding(rule, text, { evidence: matched.map(evidence), files, groupIds: groupIdsOf(matched), fixes: [{ fix: 'set-aside-files', files }] })]
}

export const archiveInMods: Rule = (scan) => {
  const archives = scan.inventory.files.filter((f) => f.kind === 'archive')
  return setAsideRule('archive-in-mods', archives, words.archiveInModsWords({ count: archives.length }), (f) => f.relPath)
}

function brokenNote(file: ModFile): string | null {
  if (file.kind === 'package' && file.dbpf.status === 'broken') return `${file.relPath}: ${file.dbpf.problem} (${file.dbpf.detail})`
  if (file.kind === 'script' && file.script.status === 'broken') return `${file.relPath}: ${file.script.detail}`
  return null // 'unreadable' is never "broken": the file may only be locked
}

export const brokenPackage: Rule = (scan) => {
  const broken = scan.inventory.files.filter((f) => brokenNote(f) !== null)
  return setAsideRule('broken-package', broken, words.brokenPackageWords({ count: broken.length }), (f) => brokenNote(f)!)
}

export const wrongGamePackage: Rule = (scan) => {
  const wrong = scan.inventory.files.flatMap((f) => (f.kind === 'package' && f.dbpf.status === 'wrong-game' ? [{ file: f, dbpf: f.dbpf }] : []))
  return setAsideRule(
    'wrong-game-package',
    wrong.map((w) => w.file),
    words.wrongGamePackageWords({ count: wrong.length, games: wrong.map((w) => w.dbpf.game) }),
    (f) => {
      const dbpf = wrong.find((w) => w.file === f)!.dbpf
      return `${f.relPath}: package version ${dbpf.major}.${dbpf.minor} (${dbpf.game})`
    }
  )
}

const BACKUP_WORDS = new Set(['backup', 'backups', 'bak', 'copy', 'copies', 'old', 'older'])

/** 'BackupCopy' and 'my_old mods' are backup folders; 'Household' and 'Gold' are not. */
function isBackupFolderName(folder: string): boolean {
  const tokens = folder.replace(/(\p{Ll})(?=\p{Lu})/gu, '$1 ').split(/\P{L}+/u)
  return tokens.some((word) => BACKUP_WORDS.has(word.toLowerCase()))
}

function inBackupFolder(file: ModFile): boolean {
  return file.relPath.split('/').slice(0, -1).some(isBackupFolderName)
}

function byName(a: ModFile, b: ModFile): number {
  const left = a.relPath.toLowerCase()
  const right = b.relPath.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
}

export const duplicateFiles: Rule = (scan) => {
  const curseForgeGroups = new Set(scan.inventory.groups.filter((g) => g.source === 'curseforge').map((g) => g.id))
  const bySha = new Map<string, ModFile[]>()
  for (const file of scan.inventory.files) {
    if (!isMod(file) || file.hash.status !== 'hashed') continue
    const copies = bySha.get(file.hash.sha256)
    if (copies) copies.push(file)
    else bySha.set(file.hash.sha256, [file])
  }
  // Keep the CurseForge-tracked copy, then a copy not under a folder named as a backup, copy or old, then the shallower depth, then by name.
  const keepOrder = (a: ModFile, b: ModFile) =>
    Number(curseForgeGroups.has(b.groupId)) - Number(curseForgeGroups.has(a.groupId)) ||
    Number(inBackupFolder(a)) - Number(inBackupFolder(b)) ||
    a.depth - b.depth ||
    byName(a, b)
  const sets = [...bySha.values()].filter((copies) => copies.length > 1).map((copies) => [...copies].sort(keepOrder))
  if (sets.length === 0) return []
  sets.sort((a, b) => byName(a[0]!, b[0]!))
  const all = sets.flat()
  const extras = sets.flatMap((copies) => copies.slice(1))
  return [
    finding('duplicate-files', words.duplicateFilesWords({ extraCount: extras.length }), {
      evidence: sets.flatMap((copies) => [`Keeps: ${copies[0]!.relPath}`, ...copies.slice(1).map((f) => `Extra copy: ${f.relPath}`)]),
      files: all.map((f) => f.relPath),
      groupIds: groupIdsOf(all),
      fixes: [{ fix: 'set-aside-files', files: extras.map((f) => f.relPath) }]
    })
  ]
}

export const scriptOlderThanUpdate: Rule = (scan) => {
  const updatedAt = scan.facts.gameUpdatedAt
  if (updatedAt === null) return []
  const old = scan.inventory.files.filter((f) => f.kind === 'script' && timeOf(f.modifiedAt) < timeOf(updatedAt))
  if (old.length === 0) return []
  return [
    finding('script-older-than-update', words.scriptOlderThanUpdateWords({ count: old.length }), {
      evidence: [`Game updated: ${updatedAt}`, ...old.map((f) => `${f.relPath}: ${f.modifiedAt}`)],
      files: old.map((f) => f.relPath),
      groupIds: groupIdsOf(old)
    })
  ]
}

export const staleThumbnailCache: Rule = (scan) => {
  const cacheAt = scan.facts.thumbCacheAt
  if (cacheAt === null) return []
  let newest: ModFile | null = null
  let newestTime = -Infinity
  for (const file of scan.inventory.files) {
    if (!isMod(file)) continue
    const modified = timeOf(file.modifiedAt)
    if (Number.isNaN(modified)) continue
    if (newest === null || modified > newestTime) {
      newest = file
      newestTime = modified
    }
  }
  if (newest === null || !(newestTime > timeOf(cacheAt))) return []
  return [
    finding('stale-thumbnail-cache', words.staleThumbnailCacheWords(), {
      evidence: [`localthumbcache.package: ${cacheAt}`, `Newest mod: ${newest.relPath} (${newest.modifiedAt})`],
      fixes: [{ fix: 'clear-caches' }]
    })
  ]
}

export const crashWithoutCause: Rule = (scan) => {
  const crashes = scan.logs.filter((l) => l.kind === 'crash')
  if (crashes.length === 0 || logNamesMod(scan).length > 0) return []
  const hasMods = scan.inventory.files.some(isMod)
  return [
    finding('crash-without-cause', words.crashWithoutCauseWords({ crashCount: crashes.length, hasMods }), {
      evidence: crashes.map(
        (l) => `${l.file}: crash at ${l.createdLocal ?? l.fileModifiedAt}${l.gameVersion ? `, game ${l.gameVersion}` : ''}`
      ),
      next: hasMods ? 'fifty-fifty' : 'none'
    })
  ]
}

/** In the order findings of the same severity are shown. */
export const RULES: readonly (readonly [RuleId, Rule])[] = [
  ['mods-off', modsOff],
  ['folder-in-onedrive', folderInOneDrive],
  ['two-sims-folders', twoSimsFolders],
  ['log-names-mod', logNamesMod],
  ['script-too-deep', scriptTooDeep],
  ['package-too-deep', packageTooDeep],
  ['archive-in-mods', archiveInMods],
  ['broken-package', brokenPackage],
  ['wrong-game-package', wrongGamePackage],
  ['duplicate-files', duplicateFiles],
  ['script-older-than-update', scriptOlderThanUpdate],
  ['stale-thumbnail-cache', staleThumbnailCache],
  ['crash-without-cause', crashWithoutCause]
]

const SEVERITY_RANK: Record<Severity, number> = { stop: 0, warn: 1, info: 2 }

/** Every rule's findings, sorted stop, warn, info, then in RULES order. */
export function runAllRules(scan: ScanInput): Finding[] {
  return RULES.flatMap(([, rule]) => rule(scan)).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}
