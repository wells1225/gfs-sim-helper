import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface Host {
  documentsDir: string
  env: Record<string, string | undefined>
  readRegistry(key: string, value: string): Promise<string | undefined>
  listProcesses(): Promise<string[]>
  fileVersion(filePath: string): Promise<string | undefined>
}

export function getEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name]
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct.trim()
  }
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && typeof v === 'string' && v.trim() !== '') {
      return v.trim()
    }
  }
  return undefined
}

export function parseRegQueryOutput(stdout: string, valueName: string): string | undefined {
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.*)$`, 'i')
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(pattern)
    if (match) {
      const value = match[1]?.trim()
      return value ? value : undefined
    }
  }
  return undefined
}

export function parseTasklistCsv(stdout: string): string[] {
  const names: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('"')) continue
    const match = line.match(/^"([^"]+)"/)
    if (match?.[1]) {
      names.push(match[1])
    }
  }
  return names
}

const POWERSHELL_FILE_VERSION_SCRIPT =
  '$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:SIMS_HELPER_VERSION_PATH); ' +
  'if ($v.FileVersion) { $v.FileVersion } ' +
  'elseif ($v.FileMajorPart -or $v.FileMinorPart -or $v.FileBuildPart -or $v.FilePrivatePart) { ' +
  '"$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart).$($v.FilePrivatePart)" }'

export function createWindowsHost(
  documentsDir: string = join(homedir(), 'Documents'),
  env: Record<string, string | undefined> = process.env
): Host {
  return {
    documentsDir,
    env,
    async readRegistry(key: string, value: string): Promise<string | undefined> {
      try {
        const { stdout } = await execFileAsync('reg', ['query', key, '/v', value], {
          windowsHide: true
        })
        return parseRegQueryOutput(stdout, value)
      } catch {
        return undefined
      }
    },
    async listProcesses(): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], {
          windowsHide: true
        })
        return parseTasklistCsv(stdout)
      } catch {
        return []
      }
    },
    async fileVersion(filePath: string): Promise<string | undefined> {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_FILE_VERSION_SCRIPT],
          {
            windowsHide: true,
            env: {
              ...process.env,
              SIMS_HELPER_VERSION_PATH: filePath
            }
          }
        )
        const trimmed = stdout.trim()
        return trimmed || undefined
      } catch {
        return undefined
      }
    }
  }
}

export async function createRealHost(): Promise<Host> {
  if (process.versions['electron']) {
    const { app } = await import('electron')
    return createWindowsHost(app.getPath('documents'), process.env)
  }
  return createWindowsHost(join(homedir(), 'Documents'), process.env)
}
