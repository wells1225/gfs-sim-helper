import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface Host {
  documentsDir: string
  env: Record<string, string | undefined>
  readRegistry(key: string, value: string): Promise<string | undefined>
  /** Rejects when the process list cannot be read, so callers never mistake "could not check" for "not running". */
  listProcesses(): Promise<string[]>
  fileVersion(filePath: string): Promise<string | undefined>
}

export type ExecRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; env?: Record<string, string | undefined> }
) => Promise<{ stdout: string }>

// A cold PowerShell start can take several seconds on a slow PC.
const COMMAND_TIMEOUT_MS = 15_000

const defaultRunner: ExecRunner = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], options)
  return { stdout }
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

// Prints the version string, then the numeric parts. The caller takes the first dotted
// version, so a string such as "1, 129, 39, 1030" still yields the numeric version.
const POWERSHELL_FILE_VERSION_SCRIPT =
  '$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:SIMS_HELPER_VERSION_PATH); ' +
  '$v.FileVersion; ' +
  'if ($v.FileMajorPart -or $v.FileMinorPart -or $v.FileBuildPart -or $v.FilePrivatePart) { ' +
  '"$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart).$($v.FilePrivatePart)" }'

export function createWindowsHost(
  documentsDir: string = join(homedir(), 'Documents'),
  env: Record<string, string | undefined> = process.env,
  run: ExecRunner = defaultRunner
): Host {
  return {
    documentsDir,
    env,
    async readRegistry(key: string, value: string): Promise<string | undefined> {
      try {
        const { stdout } = await run('reg', ['query', key, '/v', value], {
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true
        })
        return parseRegQueryOutput(stdout, value)
      } catch {
        return undefined
      }
    },
    async listProcesses(): Promise<string[]> {
      const { stdout } = await run('tasklist', ['/fo', 'csv', '/nh'], {
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true
      })
      const names = parseTasklistCsv(stdout)
      // A real Windows session always has processes; an empty list means tasklist did not work.
      if (names.length === 0) {
        throw new Error('tasklist returned no processes')
      }
      return names
    },
    async fileVersion(filePath: string): Promise<string | undefined> {
      try {
        const { stdout } = await run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_FILE_VERSION_SCRIPT],
          {
            timeout: COMMAND_TIMEOUT_MS,
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
