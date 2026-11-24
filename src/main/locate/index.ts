import type { GameInstall, SimsFolder } from '../../shared/model.ts'
import { findGameInstall } from './game-install.ts'
import type { Host } from './host.ts'
import { checkGameRunning } from './process.ts'
import type { GameRunState } from './process.ts'
import { findUserFolders } from './user-folders.ts'

export interface LocateResult {
  userFolders: SimsFolder[]
  gameInstall: GameInstall | null
  gameRunning: GameRunState
}

export async function locate(host: Host): Promise<LocateResult> {
  const [userFolders, gameRunning] = await Promise.all([findUserFolders(host), checkGameRunning(host)])
  const gameInstall = await findGameInstall(host, userFolders)
  return {
    userFolders,
    gameInstall,
    gameRunning
  }
}

export {
  extractVersion,
  findGameInstall,
  listInstalledPacks,
  PACK_CODE_PATTERN,
  readGameVersionFromTxt,
  SIMS_REGISTRY_KEY,
  SIMS_REGISTRY_VALUE,
  VERSION_PATTERN
} from './game-install.ts'
export {
  createRealHost,
  createWindowsHost,
  getEnvValue,
  parseRegQueryOutput,
  parseTasklistCsv
} from './host.ts'
export type { ExecRunner, Host } from './host.ts'
export { checkGameRunning, isSimsProcessName, SIMS_PROCESS_NAMES } from './process.ts'
export type { GameRunState } from './process.ts'
export { findUserFolders, LOCALIZED_SIMS_FOLDER_NAMES, normalizeSimsFolderName } from './user-folders.ts'
