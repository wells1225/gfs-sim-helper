/**
 * PR 17 (briefs/pr-17.md): the Sims Helper Mods folder she picked, as state/mod-folder.json holds it. services.ts
 * wires GateDeps.modFolderRoot to this, and the gate asks it once for each mod-request or mod-install request. It
 * must answer at once, so PR 17 keeps the folder in memory here: loaded asynchronously from state/mod-folder.json
 * at the start of every requests:* handler, and updated after a valid pick. The gate checks the answer itself
 * (name, place, no link); null means no mod-folder zone.
 */
let currentModFolder: string | null = null

export function modFolderRoot(): string | null {
  return currentModFolder
}

export function setModFolderRoot(folderPath: string | null): void {
  currentModFolder = folderPath
}

export function resetModFolderRoot(): void {
  currentModFolder = null
}
