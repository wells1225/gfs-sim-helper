import type { CurseForgeAddon, CurseForgeRead, ModFile, ModGroup } from '../../shared/model.ts'

export type UngroupedModFile =
  | (Omit<Extract<ModFile, { kind: 'package' }>, 'groupId'>)
  | (Omit<Extract<ModFile, { kind: 'script' }>, 'groupId'>)
  | (Omit<Extract<ModFile, { kind: 'archive' }>, 'groupId'>)
  | (Omit<Extract<ModFile, { kind: 'other' }>, 'groupId'>)

function normalizeSlashPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '')
}

function baseNameOf(slashPath: string): string {
  const idx = slashPath.lastIndexOf('/')
  return idx === -1 ? slashPath : slashPath.slice(idx + 1)
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return fileName
  return fileName.slice(0, dot)
}

function buildCurseForgeLookup(curseForge: CurseForgeRead): {
  byRelPath: Map<string, CurseForgeAddon>
  byBaseName: Map<string, CurseForgeAddon>
} {
  const byRelPath = new Map<string, CurseForgeAddon>()
  const byBaseName = new Map<string, CurseForgeAddon>()

  if (curseForge.status !== 'found') {
    return { byRelPath, byBaseName }
  }

  for (const addon of curseForge.addons) {
    const diskPath = normalizeSlashPath(addon.fileNameOnDisk)
    if (diskPath !== '') {
      const lowerRel = diskPath.toLowerCase()
      if (!byRelPath.has(lowerRel)) {
        byRelPath.set(lowerRel, addon)
      }
      const lowerBase = baseNameOf(diskPath).toLowerCase()
      if (lowerBase !== '' && !byBaseName.has(lowerBase)) {
        byBaseName.set(lowerBase, addon)
      }
    }

    for (const modName of addon.moduleNames) {
      const normalized = normalizeSlashPath(modName)
      const lowerBase = baseNameOf(normalized).toLowerCase()
      if (lowerBase !== '' && !byBaseName.has(lowerBase)) {
        byBaseName.set(lowerBase, addon)
      }
    }
  }

  return { byRelPath, byBaseName }
}

export function assignGroups(
  sortedFiles: readonly UngroupedModFile[],
  curseForge: CurseForgeRead
): { files: ModFile[]; groups: ModGroup[] } {
  const { byRelPath, byBaseName } = buildCurseForgeLookup(curseForge)
  const groupMap = new Map<string, ModGroup>()
  const files: ModFile[] = new Array(sortedFiles.length)

  for (let i = 0; i < sortedFiles.length; i += 1) {
    const file = sortedFiles[i]!
    const lowerRel = file.relPath.toLowerCase()
    const lowerBase = baseNameOf(file.relPath).toLowerCase()
    const matchedAddon = byRelPath.get(lowerRel) ?? byBaseName.get(lowerBase)

    let groupId: string
    if (matchedAddon) {
      groupId = `cf:${matchedAddon.addonId}`.toLowerCase()
      let group = groupMap.get(groupId)
      if (!group) {
        group = {
          id: groupId,
          label: matchedAddon.name,
          source: 'curseforge',
          files: [],
          bytes: 0,
          hasScript: false,
          curseForge: {
            addonId: matchedAddon.addonId,
            fileId: matchedAddon.fileId,
            fileDate: matchedAddon.fileDate
          }
        }
        groupMap.set(groupId, group)
      }
      group.files.push(file.relPath)
      group.bytes += file.bytes
      if (file.kind === 'script') group.hasScript = true
    } else {
      const slash = file.relPath.indexOf('/')
      if (slash !== -1) {
        const topFolder = file.relPath.slice(0, slash)
        groupId = `dir:${topFolder.toLowerCase()}`
        let group = groupMap.get(groupId)
        if (!group) {
          group = {
            id: groupId,
            label: topFolder,
            source: 'folder',
            files: [],
            bytes: 0,
            hasScript: false,
            curseForge: null
          }
          groupMap.set(groupId, group)
        }
        group.files.push(file.relPath)
        group.bytes += file.bytes
        if (file.kind === 'script') group.hasScript = true
      } else {
        groupId = `file:${lowerRel}`
        // Names that differ only in letter case share an id, so they share the group.
        let group = groupMap.get(groupId)
        if (!group) {
          group = {
            id: groupId,
            label: stripExtension(file.relPath),
            source: 'loose',
            files: [],
            bytes: 0,
            hasScript: false,
            curseForge: null
          }
          groupMap.set(groupId, group)
        }
        group.files.push(file.relPath)
        group.bytes += file.bytes
        if (file.kind === 'script') group.hasScript = true
      }
    }

    files[i] = { ...file, groupId }
  }

  const groups = [...groupMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { files, groups }
}
