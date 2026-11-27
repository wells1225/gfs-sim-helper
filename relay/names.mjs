// File name checks for a delivery. The files end up in her Mods folder on Windows, so a name must be safe there.

import { hasControl } from './lib.mjs'

// These limits match her app (src/main/requests/names.ts and delivery.ts): anything past them makes the app mark the
// delivery broken, and a delivery is written once.
export const MAX_NAME_CHARS = 200
export const MAX_FILES = 500
export const MAX_READY_BYTES = 256 * 1024
const ALLOWED = ['.package', '.ts4script']
const WINDOWS_BAD = /[<>:"|?*\\/]/
// Windows device names, with or without an extension or spaces before the dot (CON.package, aux.v2.package,
// LPT9.ts4script, COM¹.package, CONIN$.package, CON .package). Same pattern as the app.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/i

/** Why a file name is refused, or null when it is fine. */
export function badName(name) {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return 'its name is empty or too long'
  if (name.includes('/') || name.includes('\\')) return 'its name has a slash'
  if (name.includes('..')) return 'its name has ".."'
  if (hasControl(name)) return 'its name has control characters'
  if (WINDOWS_BAD.test(name) || /[ .]$/.test(name) || name.startsWith('.')) return 'its name is not a safe Windows file name'
  if (WINDOWS_DEVICE.test(name)) return 'its name is a Windows device name'
  if (!ALLOWED.some((ext) => name.endsWith(ext))) return 'only .package and .ts4script files can be delivered'
  return null
}

/** Groups of names that are the same on Windows, where file names ignore case. */
export function caseDuplicates(names) {
  const groups = new Map()
  for (const n of names) {
    const key = n.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), n])
  }
  return [...groups.values()].filter((g) => g.length > 1)
}
