import { app } from 'electron'
import { createWindowsHost } from './locate/host.ts'
import type { Host } from './locate/host.ts'

function envOverride(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function desktopDir(): string {
  return envOverride('SIMS_HELPER_DESKTOP_DIR') ?? app.getPath('desktop')
}

export function createAppHost(): Host {
  const documentsDir = envOverride('SIMS_HELPER_DOCUMENTS_DIR') ?? app.getPath('documents')
  return createWindowsHost(documentsDir, process.env)
}
