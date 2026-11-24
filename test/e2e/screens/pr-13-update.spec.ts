import { expect, test } from '@playwright/test'
import type { UpdateState } from '../../../src/shared/model.ts'
import { launchApp, shoot, stubIpc } from '../support/app.ts'

const SLUG = 'pr-13-update'

const AVAILABLE: UpdateState = { state: 'available', current: '0.2.0', next: '0.3.0' }
const DOWNLOADING: UpdateState = { state: 'downloading', current: '0.2.0', next: '0.3.0', percent: 42 }
const READY: UpdateState = { state: 'ready', current: '0.2.0', next: '0.3.0' }
const FAILED: UpdateState = { state: 'failed', current: '0.2.0', step: 'download', why: 'bad-file' }
const IDLE: UpdateState = { state: 'idle', current: '0.2.0', checkedAt: '2026-11-24T10:00:00.000Z', justUpdated: false }

// The welcome screen sits under the banner: it reads only settings, so the shots stay the same as other PRs land.
const WELCOME = { welcome: 'not-seen', folderPath: null } as const

test('captures light and dark screenshots of each update state', async () => {
  const running = await launchApp()
  try {
    const { app, page } = running

    const banners: [string, UpdateState, string][] = [
      ['banner-available', AVAILABLE, 'A new version of Sims Helper is ready.'],
      ['banner-downloading', DOWNLOADING, 'Getting the update… 42%'],
      ['banner-ready', READY, 'The update is ready. Sims Helper will close and open again to finish.'],
      ['banner-failed', FAILED, "The update didn't download. Nothing changed."]
    ]
    for (const [name, state, text] of banners) {
      await stubIpc(app, { 'settings:get': WELCOME, 'update:check': state, 'update:get': state })
      await expect(page.getByText(text)).toBeVisible()
      await shoot(page, SLUG, name)
    }

    await stubIpc(app, { 'settings:get': WELCOME, 'update:check': IDLE, 'update:get': IDLE })
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'About' }).click()
    await expect(page.getByText('Version 0.2.0')).toBeVisible()
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await expect(page.getByText('You have the newest version.')).toBeVisible()
    await shoot(page, SLUG, 'about-version')
  } finally {
    await running.close()
  }
})
