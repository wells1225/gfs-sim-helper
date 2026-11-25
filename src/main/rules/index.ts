import type { Finding, FolderFacts, GameInstall, Scan } from '../../shared/model.ts'

export async function readFolderFacts(_input: {
  folderPath: string
  game: GameInstall | null
}): Promise<FolderFacts> {
  throw new Error('not implemented: readFolderFacts')
}

export function runRules(_scan: Omit<Scan, 'findings'>): Finding[] {
  throw new Error('not implemented: runRules')
}
