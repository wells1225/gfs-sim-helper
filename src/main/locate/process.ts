import type { Host } from './host.ts'

export const SIMS_PROCESS_NAMES = ['TS4_x64', 'TS4_x64_fpb', 'TS4_DX9_x64'] as const

const NORMALIZED_PROCESS_NAMES = new Set<string>(SIMS_PROCESS_NAMES.map((name) => name.toLowerCase()))

export function isSimsProcessName(processName: string): boolean {
  const normalized = processName.trim().toLowerCase().replace(/\.exe$/i, '')
  return NORMALIZED_PROCESS_NAMES.has(normalized)
}

/** 'unknown' when the process list could not be read. Anything that changes files must treat it like 'running'. */
export type GameRunState = 'running' | 'not-running' | 'unknown'

export async function checkGameRunning(host: Pick<Host, 'listProcesses'>): Promise<GameRunState> {
  let processes: string[]
  try {
    processes = await host.listProcesses()
  } catch {
    return 'unknown'
  }
  return processes.some(isSimsProcessName) ? 'running' : 'not-running'
}
