import { join } from 'node:path'
import type { ModGroup, RelPath } from '../../shared/model.ts'
import type { DisableMechanism, PlannedStep } from '../ports.ts'

export function holdingModPath(holdingDir: string, entryId: string, relPath: RelPath): string {
  return join(holdingDir, entryId, 'Mods', ...relPath.split('/'))
}

export const DISABLE: DisableMechanism = {
  method: 'move-to-holding',
  plan(group: ModGroup, at: { modsDir: string; holdingDir: string; entryId: string }): PlannedStep[] {
    return group.files.map((relPath) => ({
      kind: 'move',
      from: join(at.modsDir, ...relPath.split('/')),
      to: holdingModPath(at.holdingDir, at.entryId, relPath)
    }))
  }
}
