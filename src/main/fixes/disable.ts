import type { ModGroup } from '../../shared/model.ts'
import type { DisableMechanism, PlannedStep } from '../ports.ts'

export const DISABLE: DisableMechanism = {
  method: 'move-to-holding',
  plan(_group: ModGroup, _at: { modsDir: string; holdingDir: string; entryId: string }): PlannedStep[] {
    throw new Error('not implemented: DISABLE.plan')
  }
}
