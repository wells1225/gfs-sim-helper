/**
 * PR 17 (briefs/pr-17.md): the Sims Helper Mods folder she picked, as state/mod-folder.json holds it. services.ts
 * wires GateDeps.modFolderRoot to this, and the gate asks it once for each mod-request or mod-install request. It
 * must answer at once, so PR 17 keeps the folder in memory here: read on start, and set again after a pick. The gate
 * checks the answer itself (name, place, no link); null means no mod-folder zone.
 *
 * Round 7 stub: no folder is set.
 */
export function modFolderRoot(): string | null {
  return null
}
