import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('opens the Sims Helper window and shows the dedication', async () => {
  const installedExe = process.env['SIMS_HELPER_EXE']
  const launchOptions = installedExe
    ? { executablePath: installedExe }
    : { args: [resolve(process.cwd(), 'out/main/index.js')] }

  if (installedExe && !existsSync(installedExe)) {
    throw new Error(`Installed executable not found at: ${installedExe}`)
  }

  const app = await electron.launch(launchOptions)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window).toHaveTitle('Sims Helper')
    await expect(window.getByText('Built by Tyler, for Lila.')).toBeVisible()
  } finally {
    await app.close()
  }
})
