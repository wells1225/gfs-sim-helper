import type {
  CurseForgeRead,
  DbpfIndex,
  Inventory,
  ResourceCfgRead,
  ScriptRead
} from '../../shared/model.ts'
import type { OnProgress } from '../ports.ts'

export async function readDbpfIndex(_file: string): Promise<DbpfIndex> {
  throw new Error('not implemented: readDbpfIndex')
}

export async function listScriptEntries(_file: string): Promise<ScriptRead> {
  throw new Error('not implemented: listScriptEntries')
}

export async function readResourceCfg(_modsDir: string): Promise<ResourceCfgRead> {
  throw new Error('not implemented: readResourceCfg')
}

export async function readCurseForge(_instanceFile: string | null): Promise<CurseForgeRead> {
  throw new Error('not implemented: readCurseForge')
}

export async function buildInventory(_input: {
  modsDir: string
  curseForgeInstanceFile: string | null
  onProgress?: OnProgress
}): Promise<Inventory> {
  throw new Error('not implemented: buildInventory')
}
