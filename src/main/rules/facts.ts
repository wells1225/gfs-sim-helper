// Reads the few facts about her Sims folder that the rules need. Reads only; changes nothing.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FolderFacts, GameInstall, ModSwitch, OptionsRead } from '../../shared/model.ts'

function decode(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

/** The two mod switches in the [options] section. A key that is absent or holds another value is 'missing'. */
export function parseOptionsIni(text: string): { mods: ModSwitch; scriptMods: ModSwitch } {
  let section = ''
  const values = new Map<string, string>()
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim().toLowerCase()
      continue
    }
    const equals = line.indexOf('=')
    if (section !== 'options' || equals === -1) continue
    values.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim())
  }
  const disabled = values.get('modsdisabled')
  const enabled = values.get('scriptmodsenabled')
  return {
    mods: disabled === '0' ? 'on' : disabled === '1' ? 'off' : 'missing',
    scriptMods: enabled === '1' ? 'on' : enabled === '0' ? 'off' : 'missing'
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
}

async function readOptions(folderPath: string): Promise<OptionsRead> {
  let bytes: Buffer
  try {
    bytes = await readFile(join(folderPath, 'Options.ini'))
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' }
    return { status: 'unreadable', detail: code ?? (error instanceof Error ? error.message : String(error)) }
  }
  return { status: 'ok', ...parseOptionsIni(decode(bytes)) }
}

async function modifiedAt(file: string): Promise<string | null> {
  try {
    const info = await stat(file)
    return info.isFile() ? info.mtime.toISOString() : null
  } catch {
    return null
  }
}

export async function readFolderFacts(input: { folderPath: string; game: GameInstall | null }): Promise<FolderFacts> {
  const [options, gameUpdatedAt, thumbCacheAt] = await Promise.all([
    readOptions(input.folderPath),
    input.game ? modifiedAt(join(input.game.path, 'Game', 'Bin', 'TS4_x64.exe')) : Promise.resolve(null),
    modifiedAt(join(input.folderPath, 'localthumbcache.package'))
  ])
  return { options, gameUpdatedAt, thumbCacheAt }
}
