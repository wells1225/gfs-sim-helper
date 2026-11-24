import type { Host } from './host.ts'

export const SIMS_PROCESS_NAMES = ['TS4_x64', 'TS4_x64_fpb', 'TS4_DX9_x64'] as const

const NORMALIZED_PROCESS_NAMES = new Set<string>(SIMS_PROCESS_NAMES.map((name) => name.toLowerCase()))

export function isSimsProcessName(processName: string): boolean {
  const normalized = processName.trim().toLowerCase().replace(/\.exe$/i, '')
  return NORMALIZED_PROCESS_NAMES.has(normalized)
}

export async function isGameRunning(host: Pick<Host, 'listProcesses'>): Promise<boolean> {
  const processes = await host.listProcesses()
  return processes.some(isSimsProcessName)
}
