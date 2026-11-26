import { join } from 'node:path'

/** Relative path from the app root (repo root in dev and app.asar root when packaged). */
export const APP_ICON_RELATIVE_PATH = 'build/icon.png'

/** Resolves the window and taskbar PNG icon from `src/main` or `out/main`. */
export function appIconPath(mainDir: string = __dirname): string {
  return join(mainDir, '../..', APP_ICON_RELATIVE_PATH)
}
