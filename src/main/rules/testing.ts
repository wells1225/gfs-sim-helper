// Hand-built scans for the rule tests. Not imported by shipped code.
import type { LogReport, ModFile, ModGroup, Scan } from '../../shared/model.ts'
import { sampleScan } from '../../shared/testing/sample.ts'

export type ScanInput = Omit<Scan, 'findings'>

const OLD = '2026-11-01T10:00:00.000Z'

type FileExtras = Partial<Pick<ModFile, 'bytes' | 'modifiedAt' | 'hash' | 'groupId' | 'depth'>>

function depthOf(relPath: string): number {
  return relPath.split('/').length - 1
}

function defaultGroupId(relPath: string): string {
  const parts = relPath.split('/')
  return parts.length > 1 ? `dir:${parts[0]!.toLowerCase()}` : `file:${relPath.toLowerCase()}`
}

function base(relPath: string, extras: FileExtras) {
  return {
    relPath,
    bytes: extras.bytes ?? 1000,
    modifiedAt: extras.modifiedAt ?? OLD,
    hash: extras.hash ?? { status: 'not-needed' as const },
    groupId: extras.groupId ?? defaultGroupId(relPath),
    depth: extras.depth ?? depthOf(relPath)
  }
}

export function pkg(relPath: string, extras: FileExtras & { dbpf?: Extract<ModFile, { kind: 'package' }>['dbpf'] } = {}): ModFile {
  return { ...base(relPath, extras), kind: 'package', dbpf: extras.dbpf ?? { status: 'ok', keyCount: 3 } }
}

export function script(
  relPath: string,
  entries: string[] = ['some_mod/main.pyc'],
  extras: FileExtras & { script?: Extract<ModFile, { kind: 'script' }>['script'] } = {}
): ModFile {
  return { ...base(relPath, extras), kind: 'script', script: extras.script ?? { status: 'ok', entries } }
}

export function archive(relPath: string, extras: FileExtras = {}): ModFile {
  return { ...base(relPath, extras), kind: 'archive' }
}

export function other(relPath: string, extras: FileExtras = {}): ModFile {
  return { ...base(relPath, extras), kind: 'other' }
}

/** Builds one group per groupId. A 'cf:' id becomes a CurseForge group, 'dir:' a folder, 'file:' a loose file. */
export function groupsFor(files: ModFile[], labels: Record<string, string> = {}): ModGroup[] {
  const byId = new Map<string, ModFile[]>()
  for (const file of files) byId.set(file.groupId, [...(byId.get(file.groupId) ?? []), file])
  return [...byId].map(([id, members]) => {
    const source = id.startsWith('cf:') ? 'curseforge' : id.startsWith('dir:') ? 'folder' : 'loose'
    const fallback = id.startsWith('file:') ? members[0]!.relPath.split('/').pop()!.replace(/\.[^.]*$/, '') : members[0]!.relPath.split('/')[0]!
    const addonId = Number(id.slice(3))
    return {
      id,
      label: labels[id] ?? fallback,
      source,
      files: members.map((f) => f.relPath),
      bytes: members.reduce((sum, f) => sum + f.bytes, 0),
      hasScript: members.some((f) => f.kind === 'script'),
      curseForge: source === 'curseforge' ? { addonId, fileId: addonId + 1, fileDate: OLD } : null
    }
  })
}

export function log(overrides: Partial<LogReport> = {}): LogReport {
  return {
    file: 'lastException_63887259912.txt',
    kind: 'exception',
    fileModifiedAt: '2026-11-23T22:14:00.000Z',
    createdLocal: '2026-11-23 15:14:00',
    gameVersion: '1.129.39.1030',
    categoryId: 'outfit_picker.py:42',
    message: 'AttributeError: NoneType object has no attribute sim_info',
    count: 1,
    frames: [],
    modHints: [],
    completeness: 'complete',
    ...overrides
  }
}

export function crashLog(overrides: Partial<LogReport> = {}): LogReport {
  return log({
    file: 'lastCrash.txt',
    kind: 'crash',
    categoryId: '0xce2052',
    message: null,
    frames: [],
    modHints: [],
    ...overrides
  })
}

/**
 * A healthy scan: mods on, one CurseForge script mod one folder down and one package, both newer than the game
 * update and older than the thumbnail cache, one Sims folder, no logs. runRules gives nothing for it.
 */
export function cleanScan(change: { files?: ModFile[]; labels?: Record<string, string> } & Partial<ScanInput> = {}): ScanInput {
  const { files: givenFiles, labels, ...rest } = change
  const { findings: _findings, ...sample } = sampleScan()
  const files = givenFiles ?? [
    script('WickedWardrobe/wardrobe.ts4script', ['wicked_wardrobe/outfit_picker.pyc'], {
      groupId: 'cf:901234',
      modifiedAt: '2026-11-16T10:00:00.000Z'
    }),
    pkg('Hair/cozy_braids.package', { modifiedAt: '2026-11-18T18:05:00.000Z' })
  ]
  return {
    ...sample,
    facts: {
      options: { status: 'ok', mods: 'on', scriptMods: 'on' },
      gameUpdatedAt: '2026-11-15T17:00:00.000Z',
      thumbCacheAt: '2026-11-20T10:00:00.000Z'
    },
    inventory: {
      ...sample.inventory,
      files,
      groups: groupsFor(files, { 'cf:901234': 'Wicked Wardrobe', ...labels }),
      resourceCfg: { status: 'ok', maxPackageDepth: 5 }
    },
    logs: [],
    ...rest
  }
}
