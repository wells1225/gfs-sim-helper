import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sha256 } from '../../shared/model.ts'
import {
  MAX_DELIVERY_FILES,
  MAX_FILE_BYTES,
  MAX_NOTE_CHARS,
  MAX_READY_BYTES,
  MAX_TITLE_CHARS,
  SHA256_HEX,
  badDeliveryFileName,
  charCount,
  hasCaseDuplicates,
  hasControl
} from './names.ts'

export interface ValidatedDeliveryFile {
  name: string
  bytes: number
  sha256: Sha256
}

export interface ValidatedDelivery {
  title: string
  note: string
  files: ValidatedDeliveryFile[]
  hasScript: boolean
}

export type DeliveryCheck =
  | { kind: 'none' }
  | { kind: 'ready'; delivery: ValidatedDelivery }
  | { kind: 'broken' }

function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (err) {
    if (isMissingError(err)) return null
    throw err
  }
}

/**
 * Inspects from-tyler/<requestId>/ready.json and its files on disk.
 * - Missing folder or missing ready.json -> 'none' (not finished yet).
 * - Any symlink, bad JSON, wrong format/requestId, bad filename, duplicate case-insensitive filename,
 *   missing file, size mismatch or > 200_000_000 bytes -> 'broken'.
 */
export async function readDelivery(modFolder: string, requestId: string): Promise<DeliveryCheck> {
  const fromTylerDir = join(modFolder, 'from-tyler')
  let fromTylerInfo
  try {
    fromTylerInfo = await lstatOrNull(fromTylerDir)
  } catch {
    return { kind: 'broken' }
  }
  if (fromTylerInfo === null) return { kind: 'none' }
  if (fromTylerInfo.isSymbolicLink() || !fromTylerInfo.isDirectory()) return { kind: 'broken' }

  const deliveryDir = join(fromTylerDir, requestId)
  let dirInfo
  try {
    dirInfo = await lstatOrNull(deliveryDir)
  } catch {
    return { kind: 'broken' }
  }
  if (dirInfo === null) return { kind: 'none' }
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return { kind: 'broken' }

  const readyPath = join(deliveryDir, 'ready.json')
  let readyInfo
  try {
    readyInfo = await lstatOrNull(readyPath)
  } catch {
    return { kind: 'broken' }
  }
  // ready.json is written last: a folder without it is still arriving.
  if (readyInfo === null) return { kind: 'none' }
  if (readyInfo.isSymbolicLink() || !readyInfo.isFile() || readyInfo.size > MAX_READY_BYTES) {
    return { kind: 'broken' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(readyPath, 'utf8'))
  } catch {
    return { kind: 'broken' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'broken' }
  const data = parsed as Record<string, unknown>

  if (data.format !== 1) return { kind: 'broken' }
  if (data.requestId !== requestId) return { kind: 'broken' }

  if (typeof data.title !== 'string') return { kind: 'broken' }
  const title = data.title.trim()
  if (title.length === 0 || charCount(title) > MAX_TITLE_CHARS || hasControl(title)) {
    return { kind: 'broken' }
  }

  if (typeof data.note !== 'string') return { kind: 'broken' }
  const note = data.note.replace(/\r\n/g, '\n').trim()
  if (charCount(note) > MAX_NOTE_CHARS || hasControl(note, { allowNewline: true })) {
    return { kind: 'broken' }
  }

  if (typeof data.hasScript !== 'boolean') return { kind: 'broken' }

  if (!Array.isArray(data.files) || data.files.length === 0 || data.files.length > MAX_DELIVERY_FILES) {
    return { kind: 'broken' }
  }

  const files: ValidatedDeliveryFile[] = []
  for (const item of data.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { kind: 'broken' }
    const f = item as Record<string, unknown>
    if (typeof f.name !== 'string' || badDeliveryFileName(f.name) !== null) return { kind: 'broken' }
    if (typeof f.bytes !== 'number' || !Number.isInteger(f.bytes) || f.bytes <= 0 || f.bytes > MAX_FILE_BYTES) {
      return { kind: 'broken' }
    }
    if (typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256)) return { kind: 'broken' }
    files.push({ name: f.name, bytes: f.bytes, sha256: f.sha256 })
  }

  if (hasCaseDuplicates(files.map((f) => f.name))) {
    return { kind: 'broken' }
  }

  const filesDir = join(deliveryDir, 'files')
  let filesDirInfo
  try {
    filesDirInfo = await lstatOrNull(filesDir)
  } catch {
    return { kind: 'broken' }
  }
  if (!filesDirInfo || filesDirInfo.isSymbolicLink() || !filesDirInfo.isDirectory()) {
    return { kind: 'broken' }
  }

  for (const file of files) {
    const filePath = join(filesDir, file.name)
    let fileInfo
    try {
      fileInfo = await lstatOrNull(filePath)
    } catch {
      return { kind: 'broken' }
    }
    if (!fileInfo || fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      return { kind: 'broken' }
    }
    if (fileInfo.size !== file.bytes || fileInfo.size <= 0 || fileInfo.size > MAX_FILE_BYTES) {
      return { kind: 'broken' }
    }
  }

  const hasScript = data.hasScript || files.some((f) => f.name.toLowerCase().endsWith('.ts4script'))
  return {
    kind: 'ready',
    delivery: { title, note, files, hasScript }
  }
}
