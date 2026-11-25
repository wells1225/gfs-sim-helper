import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { SimsFolder } from '../../shared/model.ts'
import { getEnvValue } from './host.ts'
import type { Host } from './host.ts'

export const LOCALIZED_SIMS_FOLDER_NAMES = [
  'The Sims 4',
  'Die Sims 4',
  'Les Sims 4',
  'Los Sims 4',
  'De Sims 4',
  'Os Sims 4',
  'ザ・シムズ 4',
  '模擬市民4'
] as const

const ONEDRIVE_ENV_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const
const ONEDRIVE_DIR_PATTERN = /^onedrive(\b|\s*-)/i

export function normalizeSimsFolderName(name: string): string {
  return name.replaceAll('\u00a0', ' ').normalize('NFC').toLowerCase()
}

const NORMALIZED_SIMS_FOLDER_NAMES = new Set(LOCALIZED_SIMS_FOLDER_NAMES.map(normalizeSimsFolderName))

function normalizeForComparison(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function resolveRealPath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizeForComparison(targetPath)
  const normRoot = normalizeForComparison(rootPath).replace(/[\\/]+$/, '')
  return normTarget === normRoot || normTarget.startsWith(normRoot + sep)
}

function isParentOfDocumentsOneDrive(userFolderPath: string): boolean {
  // Expected shape: <parentOfDocuments>/Documents/Electronic Arts/<Sims 4>
  const eaDir = dirname(userFolderPath)
  const docsDir = dirname(eaDir)
  const docsParent = dirname(docsDir)
  return ONEDRIVE_DIR_PATTERN.test(basename(docsParent))
}

async function hasOptionsIniFile(folderPath: string): Promise<boolean> {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.toLowerCase() !== 'options.ini') continue
      if (entry.isFile()) return true
      if (entry.isSymbolicLink()) {
        try {
          const info = await stat(join(folderPath, entry.name))
          if (info.isFile()) return true
        } catch {
          // Ignore broken symlinks
        }
      }
    }
    return false
  } catch {
    return false
  }
}

// Only what the game itself writes dates a folder. A mod manager can keep installing into Mods/
// of a folder the game no longer uses, and caches and Tray files are copied around by hand.
const GAME_WRITTEN_FILE_NAMES = new Set(['options.ini', 'gameversion.txt', 'config.log', 'usersetting.ini'])
const GAME_WRITTEN_LOG_PATTERN = /^last(exception|uiexception|crash).*\.txt$/
const SAVES_DIR_NAME = 'saves'

async function findNewestGameWrittenFileDate(rootDir: string): Promise<Date> {
  let newestMs = 0
  // Real paths already walked, so a link back into the folder cannot loop.
  const visited = new Set<string>()

  async function countFile(filePath: string): Promise<void> {
    try {
      // stat follows links, so a linked file is dated by its target.
      const info = await stat(filePath)
      if (info.isFile() && info.mtimeMs > newestMs) {
        newestMs = info.mtimeMs
      }
    } catch {
      // Ignore transient/unreadable files and broken links
    }
  }

  async function walk(currentDir: string): Promise<void> {
    const key = normalizeForComparison(await resolveRealPath(currentDir))
    if (visited.has(key)) return
    visited.add(key)

    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      try {
        // stat follows links: a linked folder is walked, a linked file is counted.
        const info = await stat(fullPath)
        if (info.isDirectory()) {
          await walk(fullPath)
        } else if (info.isFile() && info.mtimeMs > newestMs) {
          newestMs = info.mtimeMs
        }
      } catch {
        // Ignore transient/unreadable files and broken links
      }
    }
  }

  let topEntries
  try {
    topEntries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return new Date(0)
  }

  // Folder mtimes are ignored on purpose: a look-alike folder can be touched without the game using it.
  for (const entry of topEntries) {
    const name = entry.name.toLowerCase()
    const fullPath = join(rootDir, entry.name)
    if (name === SAVES_DIR_NAME) {
      // walk() returns quietly when saves is a plain file or a broken link.
      await walk(fullPath)
    } else if (GAME_WRITTEN_FILE_NAMES.has(name) || GAME_WRITTEN_LOG_PATTERN.test(name)) {
      await countFile(fullPath)
    }
  }
  return new Date(newestMs)
}

export async function findUserFolders(host: Pick<Host, 'documentsDir' | 'env'>): Promise<SimsFolder[]> {
  const docsRoots: string[] = []
  if (host.documentsDir.trim() !== '') {
    docsRoots.push(host.documentsDir)
  }

  const oneDriveRoots: string[] = []
  for (const envName of ONEDRIVE_ENV_VARS) {
    const envDir = getEnvValue(host.env, envName)
    if (!envDir) continue
    oneDriveRoots.push(await resolveRealPath(envDir))
    docsRoots.push(join(envDir, 'Documents'))
  }

  const seenRealPaths = new Set<string>()
  const folders: SimsFolder[] = []

  for (const docsRoot of docsRoots) {
    const eaRoot = join(docsRoot, 'Electronic Arts')
    let entries
    try {
      entries = await readdir(eaRoot, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!NORMALIZED_SIMS_FOLDER_NAMES.has(normalizeSimsFolderName(entry.name))) {
        continue
      }

      const candidatePath = join(eaRoot, entry.name)
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = (await stat(candidatePath)).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (!isDir) continue

      if (!(await hasOptionsIniFile(candidatePath))) {
        continue
      }

      const realPath = await resolveRealPath(candidatePath)
      const dedupeKey = normalizeForComparison(realPath)
      if (seenRealPaths.has(dedupeKey)) {
        continue
      }
      seenRealPaths.add(dedupeKey)

      const inOneDrive =
        oneDriveRoots.some((root) => isInsideRoot(realPath, root)) || isParentOfDocumentsOneDrive(realPath)
      const newestFileAt = await findNewestGameWrittenFileDate(realPath)

      folders.push({
        path: realPath,
        inOneDrive,
        newestFileAt
      })
    }
  }

  folders.sort((a, b) => {
    const diff = b.newestFileAt.getTime() - a.newestFileAt.getTime()
    if (diff !== 0) return diff
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })

  return folders
}
