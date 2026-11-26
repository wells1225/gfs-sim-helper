import { join } from 'node:path'
import type { LocateView, Progress, Scan, ScanResult, SimsFolder, Symptom } from '../../shared/model.ts'
import type { OnProgress, ScanDeps } from '../ports.ts'

export function normalizePathForCompare(value: string): string {
  const unified = value.replaceAll('\\', '/').replace(/\/+$/, '')
  const isWindowsStyle = process.platform === 'win32' || /^[a-zA-Z]:/.test(unified)
  return isWindowsStyle ? unified.toLowerCase() : unified
}

export function sameFolderPath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b)
}

export async function runScan(
  deps: ScanDeps,
  input: LocateView & { folder: SimsFolder; symptom: Symptom },
  onProgress?: OnProgress
): Promise<ScanResult> {
  const startedAt = deps.clock.now()
  const emit = (progress: Progress): void => {
    onProgress?.(progress)
  }

  try {
    emit({ task: 'scan', stage: 'counting', done: 0, total: null })

    const modsDir = join(input.folder.path, 'Mods')
    const inventory = await deps.buildInventory({
      modsDir,
      curseForgeInstanceFile: deps.paths.curseForgeInstanceFile,
      onProgress: (progress) => {
        emit(progress)
      }
    })

    emit({
      task: 'scan',
      stage: 'mods',
      done: inventory.files.length,
      total: inventory.files.length
    })

    emit({ task: 'scan', stage: 'logs', done: 0, total: null })
    const logs = await deps.readLogs({ folderPath: input.folder.path })
    const facts = await deps.readFolderFacts({
      folderPath: input.folder.path,
      game: input.game
    })

    emit({ task: 'scan', stage: 'rules', done: 0, total: 1 })

    const otherFolders = input.folders.filter((f) => !sameFolderPath(f.path, input.folder.path))
    const baseScan: Omit<Scan, 'findings'> = {
      id: deps.newId(),
      at: startedAt.toISOString(),
      tookMs: Math.max(0, deps.clock.now().getTime() - startedAt.getTime()),
      symptom: input.symptom,
      folder: input.folder,
      otherFolders,
      game: input.game,
      gameRunning: input.gameRunning,
      facts,
      inventory,
      logs
    }

    const findings = deps.runRules(baseScan)
    emit({ task: 'scan', stage: 'rules', done: 1, total: 1 })

    const tookMs = Math.max(0, deps.clock.now().getTime() - startedAt.getTime())
    return {
      status: 'done',
      scan: {
        ...baseScan,
        tookMs,
        findings
      }
    }
  } catch (err) {
    return {
      status: 'failed',
      why: 'unexpected',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}
