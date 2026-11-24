import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

/** Under one of the OneDrive roots, or under a folder whose name starts with "OneDrive". */
export function inOneDrive(path: string, oneDriveRoots: readonly string[]): boolean {
  if (oneDriveRoots.some((root) => isInside(path, root))) return true
  return resolve(path)
    .split(/[\\/]/)
    .some((part) => part.toLowerCase().startsWith('onedrive'))
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

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** The folders to make, parent first, so that `dir` exists. `planned` holds folders already made in this request. */
export async function missingDirs(dir: string, planned: Set<string>): Promise<string[]> {
  const out: string[] = []
  let at = resolve(dir)
  while (!planned.has(pathKey(at)) && !(await exists(at))) {
    out.unshift(at)
    const parent = dirname(at)
    if (parent === at) break
    at = parent
  }
  for (const made of out) planned.add(pathKey(made))
  return out
}
