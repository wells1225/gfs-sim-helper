import type { ModGroup } from '../../shared/model.ts'

/** Test data only: `count` folder groups labelled "Group 000"…, with every `scriptEvery`-th one a script mod. */
export function makeGroups(count: number, scriptEvery = 0): ModGroup[] {
  return Array.from({ length: count }, (_, i) => {
    const label = `Group ${String(i).padStart(3, '0')}`
    const hasScript = scriptEvery > 0 && i % scriptEvery === 0
    return {
      id: `dir:g${i}`,
      label,
      source: 'folder',
      files: [`${label}/a.${hasScript ? 'ts4script' : 'package'}`],
      bytes: 100,
      hasScript,
      curseForge: null
    }
  })
}
