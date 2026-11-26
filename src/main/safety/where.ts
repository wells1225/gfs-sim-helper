import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const CASELESS = process.platform === 'win32'

/** A path in the form used to compare two paths: resolved, and lowercased on Windows. */
export function pathKey(path: string): string {
  const resolved = resolve(path)
  return CASELESS ? resolved.toLowerCase() : resolved
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Resolves links on the deepest existing ancestor of `target`, re-attaching any missing tail. */
export async function resolveDeepest(target: string): Promise<string> {
  const full = resolve(target)
  const tail: string[] = []
  let at = full
  for (;;) {
    try {
      const real = await realpath(at)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch (err) {
      if (!isMissing(err)) return full
      const parent = dirname(at)
      if (parent === at) return full
      tail.unshift(basename(at))
      at = parent
    }
  }
}

export async function isInsideReal(child: string, parent: string): Promise<boolean> {
  if (isInside(child, parent)) return true
  const [realChild, realParent] = await Promise.all([resolveDeepest(child), resolveDeepest(parent)])
  return isInside(realChild, realParent)
}

/** Under one of the OneDrive roots, or under a folder whose name starts with "OneDrive". */
export function inOneDrive(path: string, oneDriveRoots: readonly string[]): boolean {
  if (oneDriveRoots.some((root) => root !== '' && isInside(path, root))) return true
  return resolve(path)
    .split(/[\\/]/)
    .some((part) => part.toLowerCase().startsWith('onedrive'))
}

export async function inOneDriveReal(path: string, oneDriveRoots: readonly string[]): Promise<boolean> {
  if (inOneDrive(path, oneDriveRoots)) return true
  const realPath = await resolveDeepest(path)
  const realRoots = await Promise.all(oneDriveRoots.filter((r) => r !== '').map((r) => resolveDeepest(r)))
  return inOneDrive(realPath, [...oneDriveRoots, ...realRoots])
}

/** A path inside the Sims folder as the manifest keeps it: relative, forward slashes. */
export function manifestPath(folderPath: string, file: string): string {
  return relative(folderPath, file).split(sep).join('/')
}

export function fromManifestPath(base: string, path: string): string {
  return join(base, ...path.split('/'))
}

export function manifestKey(path: string): string {
  return CASELESS ? path.toLowerCase() : path
}

export function isSafeId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && id !== '.' && id !== '..'
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Returns `[dir]` when `dir` is not yet planned or on disk. The gate's mkdir creates missing parents. */
export async function missingDirs(dir: string, planned: Set<string>): Promise<string[]> {
  const at = resolve(dir)
  const key = pathKey(at)
  if (planned.has(key) || (await exists(at))) {
    planned.add(key)
    return []
  }
  planned.add(key)
  return [at]
}
