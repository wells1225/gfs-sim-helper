import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameRunState, PlayAnswer } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { checkGameVersionReadOnly, locateCurrentInstall } from './watch.ts'

async function askGameState(ctx: AppContext): Promise<GameRunState> {
  try {
    const state = await ctx.gameState()
    return state === 'running' || state === 'not-running' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Starts The Sims 4 through <install>/Game/Bin/TS4_x64.exe (never TS4_DX9_x64.exe).
 * Never writes or changes any file.
 */
export async function playGame(
  ctx: AppContext,
  req: { ignoreUpdate: boolean } | null | undefined
): Promise<PlayAnswer> {
  const ignoreUpdate = (req as { ignoreUpdate?: unknown } | null | undefined)?.ignoreUpdate === true

  const state = await askGameState(ctx)
  if (state === 'running') {
    return { kind: 'refused', why: 'already-running' }
  }

  const install = await locateCurrentInstall(ctx)
  const watch = await checkGameVersionReadOnly(ctx, install)
  if (watch.changed && !ignoreUpdate) {
    return { kind: 'stopped', why: 'game-updated', watch }
  }

  if (install === null) {
    return { kind: 'refused', why: 'no-install' }
  }

  const exePath = join(install.path, 'Game', 'Bin', 'TS4_x64.exe')
  const exeInfo = await stat(exePath).catch(() => null)
  if (!exeInfo?.isFile()) {
    return { kind: 'refused', why: 'no-install' }
  }

  try {
    await ctx.openGame(exePath)
    return { kind: 'started' }
  } catch {
    return { kind: 'refused', why: 'error' }
  }
}
