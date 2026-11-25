import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResourceCfgRead } from '../../shared/model.ts'

const MAX_RESOURCE_CFG_BYTES = 1024 * 1024

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function resolveResourceCfgPath(modsDir: string): Promise<string | null> {
  const direct = join(modsDir, 'Resource.cfg')
  try {
    await stat(direct)
    return direct
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err
    }
  }

  let names: string[]
  try {
    names = await readdir(modsDir)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw err
  }

  const matched = names.find((name) => name.toLowerCase() === 'resource.cfg')
  return matched ? join(modsDir, matched) : null
}

export async function readResourceCfg(modsDir: string): Promise<ResourceCfgRead> {
  let filePath: string | null
  try {
    filePath = await resolveResourceCfgPath(modsDir)
  } catch (err) {
    return { status: 'unreadable', detail: formatError(err) }
  }

  if (filePath === null) {
    return { status: 'missing' }
  }

  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return { status: 'unreadable', detail: 'Resource.cfg is not a regular file' }
    }
    if (info.size > MAX_RESOURCE_CFG_BYTES) {
      return { status: 'unreadable', detail: `Resource.cfg is ${info.size} bytes (limit is 1 MB)` }
    }
    const text = await readFile(filePath, 'utf8')
    let maxPackageDepth = 0
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
        continue
      }
      const match = /^PackedFile\s+(.+)$/i.exec(line)
      if (!match) continue
      const pattern = match[1]!.replaceAll('\\', '/')
      const depth = (pattern.match(/\*\//g) ?? []).length
      if (depth > maxPackageDepth) {
        maxPackageDepth = depth
      }
    }
    return { status: 'ok', maxPackageDepth }
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing' }
    }
    return { status: 'unreadable', detail: formatError(err) }
  }
}
