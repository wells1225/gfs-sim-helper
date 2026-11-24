import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handlers } from '../../shared/ipc.ts'
import type { LocateView, Progress, Settings, Symptom } from '../../shared/model.ts'
import { locate } from '../locate/index.ts'
import type { AppContext } from '../ports.ts'
import { buildReport } from '../report/index.ts'
import { runScan, sameFolderPath } from './index.ts'

export type ScanChannel =
  | 'settings:get'
  | 'settings:update'
  | 'locate:run'
  | 'scan:run'
  | 'game:check'
  | 'report:build'
  | 'report:reveal'

const DEFAULT_SETTINGS: Settings = {
  welcome: 'not-seen',
  folderPath: null
}

const VALID_SYMPTOMS = new Set<Symptom>([
  'closes',
  'freezes',
  'wont-load',
  'one-save-or-lot',
  'not-sure'
])

const PROGRESS_THROTTLE_MS = 100

async function readSettings(settingsPath: string): Promise<Settings> {
  try {
    const raw = await readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SETTINGS }
    }
    const obj = parsed as Record<string, unknown>
    return {
      welcome: obj['welcome'] === 'seen' ? 'seen' : 'not-seen',
      folderPath: typeof obj['folderPath'] === 'string' && obj['folderPath'].trim() !== '' ? obj['folderPath'] : null
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function runLocate(ctx: AppContext): Promise<LocateView> {
  const found = await locate(ctx.host)
  return {
    folders: found.userFolders,
    game: found.gameInstall,
    gameRunning: found.gameRunning
  }
}

export function scanHandlers(ctx: AppContext): Handlers<ScanChannel> {
  const settingsPath = join(ctx.paths.stateDir, 'settings.json')
  let lastReportFile: string | null = null

  return {
    async 'settings:get'() {
      return await readSettings(settingsPath)
    },

    async 'settings:update'(patch) {
      const current = await readSettings(settingsPath)
      const next: Settings = { ...current }

      if (patch && typeof patch === 'object') {
        if (patch.welcome === 'seen' || patch.welcome === 'not-seen') {
          next.welcome = patch.welcome
        }

        if (patch.folderPath !== undefined) {
          if (patch.folderPath === null) {
            next.folderPath = null
          } else if (typeof patch.folderPath === 'string') {
            const located = await runLocate(ctx)
            const matched = located.folders.find((f) => sameFolderPath(f.path, patch.folderPath as string))
            if (!matched) {
              throw new Error('Selected folder was not found among your Sims 4 folders')
            }
            next.folderPath = matched.path
          }
        }
      }

      const gateResult = await ctx.gate.run({
        reason: 'state',
        folderPath: null,
        ops: [
          { op: 'mkdir', path: ctx.paths.stateDir },
          {
            op: 'write',
            path: settingsPath,
            data: `${JSON.stringify(next, null, 2)}\n`,
            mode: 'replace'
          }
        ]
      })

      if (gateResult.status === 'refused') {
        throw new Error(`Could not save settings: ${gateResult.refusal.reason}`)
      }
      if (gateResult.status === 'failed') {
        throw new Error(`Could not save settings: ${gateResult.detail}`)
      }

      return next
    },

    async 'locate:run'() {
      return await runLocate(ctx)
    },

    async 'scan:run'(req) {
      const located = await runLocate(ctx)
      const folder = located.folders.find((f) => sameFolderPath(f.path, req.folderPath))
      if (!folder) {
        return {
          status: 'failed',
          why: 'folder-not-found',
          detail: 'That Sims 4 folder could not be found.'
        }
      }

      const symptom: Symptom = VALID_SYMPTOMS.has(req.symptom) ? req.symptom : 'not-sure'

      let lastStage: Progress['stage'] | null = null
      let lastEmitMs = -Infinity
      const emitProgress = (progress: Progress): void => {
        const nowMs = ctx.clock.now().getTime()
        const isStageChange = progress.stage !== lastStage
        const isDone = progress.total !== null && progress.done >= progress.total
        if (isStageChange || isDone || nowMs - lastEmitMs >= PROGRESS_THROTTLE_MS) {
          lastStage = progress.stage
          lastEmitMs = nowMs
          ctx.emit(progress)
        }
      }

      const result = await runScan(
        ctx.scan,
        {
          ...located,
          folder,
          symptom
        },
        emitProgress
      )

      if (result.status === 'done') {
        ctx.session.scan = result.scan
      }

      return result
    },

    async 'game:check'() {
      return await ctx.gameState()
    },

    async 'report:build'() {
      if (!ctx.session.scan) {
        return {
          status: 'failed',
          why: 'no-scan',
          detail: 'Run a check-up before creating a report.'
        }
      }

      const { result, file } = await buildReport(ctx, ctx.session.scan)
      if (result.status === 'saved' && file) {
        lastReportFile = file
      }
      return result
    },

    async 'report:reveal'() {
      if (lastReportFile) {
        ctx.reveal(lastReportFile)
      }
    }
  }
}
