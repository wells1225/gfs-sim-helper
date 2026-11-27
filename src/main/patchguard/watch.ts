import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameInstall, GameVersionWatch, IsoTime } from '../../shared/model.ts'
import { findGameInstall, findUserFolders } from '../locate/index.ts'
import type { AppContext } from '../ports.ts'
import { oneAtATime } from '../safety/lock.ts'
import { isStrictIsoTime, normalizeIsoTime } from '../safety/manifest.ts'

export const GAME_VERSION_FILE = 'game-version.json'
const MAX_VERSION_FILE_BYTES = 64 * 1024

interface StoredGameVersion {
  format: 1
  version: string
  seenAt: IsoTime
}

const watchLocks = new WeakMap<AppContext, object>()

function watchLockFor(ctx: AppContext): object {
  let lock = watchLocks.get(ctx)
  if (!lock) {
    lock = {}
    watchLocks.set(ctx, lock)
  }
  return lock
}

function versionFilePath(stateDir: string): string {
  return join(stateDir, GAME_VERSION_FILE)
}

export async function readGameVersionState(stateDir: string): Promise<StoredGameVersion | null> {
  const filePath = versionFilePath(stateDir)
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.size > MAX_VERSION_FILE_BYTES) return null
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { format, version, seenAt } = parsed as Record<string, unknown>
    if (format !== 1) return null
    if (typeof version !== 'string' || version.trim() === '') return null
    if (typeof seenAt !== 'string' || !isStrictIsoTime(seenAt)) return null
    return {
      format: 1,
      version: version.trim(),
      seenAt: normalizeIsoTime(seenAt)
    }
  } catch {
    return null
  }
}

export async function locateCurrentInstall(ctx: AppContext): Promise<GameInstall | null> {
  let userFolders = await findUserFolders(ctx.host).catch(() => [])
  const scanFolder = ctx.session.scan?.folder
  if (scanFolder && !userFolders.some((f) => f.path.toLowerCase() === scanFolder.path.toLowerCase())) {
    userFolders = [scanFolder, ...userFolders]
  }
  try {
    return await findGameInstall(ctx.host, userFolders)
  } catch {
    return null
  }
}

function normalizeVersion(install: GameInstall | null): string | null {
  const trimmed = install?.version?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Pure read-only comparison of the installed game version against state/game-version.json.
 * Never writes any file. Used by patchguard:play so Play never touches the disk.
 */
export async function checkGameVersionReadOnly(
  ctx: AppContext,
  install?: GameInstall | null
): Promise<GameVersionWatch> {
  const resolvedInstall = install === undefined ? await locateCurrentInstall(ctx) : install
  const current = normalizeVersion(resolvedInstall)
  const stored = await readGameVersionState(ctx.paths.stateDir)
  if (current === null) {
    return {
      current: null,
      lastSeen: stored?.version ?? null,
      changed: false,
      seenAt: stored?.seenAt ?? null
    }
  }
  if (stored === null) {
    return {
      current,
      lastSeen: null,
      changed: false,
      seenAt: null
    }
  }
  return {
    current,
    lastSeen: stored.version,
    changed: current !== stored.version,
    seenAt: stored.seenAt
  }
}

async function writeGameVersionState(
  ctx: AppContext,
  version: string
): Promise<{ ok: boolean; seenAt: IsoTime }> {
  const seenAt = ctx.clock.now().toISOString()
  const payload: StoredGameVersion = { format: 1, version, seenAt }
  const data = `${JSON.stringify(payload, null, 2)}\n`
  try {
    const result = await ctx.gate.run({
      reason: 'state',
      folderPath: null,
      ops: [
        { op: 'mkdir', path: ctx.paths.stateDir },
        { op: 'write', path: versionFilePath(ctx.paths.stateDir), data, mode: 'replace' }
      ]
    })
    return { ok: result.status === 'done', seenAt }
  } catch {
    return { ok: false, seenAt }
  }
}

/**
 * Checks whether The Sims 4 updated since last seen.
 * First run (or unreadable/invalid state file) stores the current version and returns changed: false.
 * When both current and lastSeen are known and different, returns changed: true without advancing lastSeen.
 */
export function watchGameVersion(ctx: AppContext): Promise<GameVersionWatch> {
  return oneAtATime(watchLockFor(ctx), async () => {
    const install = await locateCurrentInstall(ctx)
    const current = normalizeVersion(install)
    const stored = await readGameVersionState(ctx.paths.stateDir)

    if (current === null) {
      return {
        current: null,
        lastSeen: stored?.version ?? null,
        changed: false,
        seenAt: stored?.seenAt ?? null
      }
    }

    if (stored === null) {
      const saved = await writeGameVersionState(ctx, current)
      if (!saved.ok) {
        return { current, lastSeen: null, changed: false, seenAt: null }
      }
      return {
        current,
        lastSeen: current,
        changed: false,
        seenAt: saved.seenAt
      }
    }

    return {
      current,
      lastSeen: stored.version,
      changed: current !== stored.version,
      seenAt: stored.seenAt
    }
  })
}

/**
 * Marks the current game version as seen ("I'm ready, let's play"): advances lastSeen to current.
 */
export function markGameVersionSeen(ctx: AppContext): Promise<GameVersionWatch> {
  return oneAtATime(watchLockFor(ctx), async () => {
    const install = await locateCurrentInstall(ctx)
    const current = normalizeVersion(install)
    if (current === null) {
      return checkGameVersionReadOnly(ctx, install)
    }
    const saved = await writeGameVersionState(ctx, current)
    if (!saved.ok) {
      return checkGameVersionReadOnly(ctx, install)
    }
    return {
      current,
      lastSeen: current,
      changed: false,
      seenAt: saved.seenAt
    }
  })
}
