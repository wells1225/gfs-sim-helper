import { expect, test } from '@playwright/test'
import type { SimsHelperApi } from '../../src/shared/ipc.ts'
import { inOrder, launchApp, stubIpc } from './support/app.ts'

test('launches against clean fixture and opens to About with an empty console', async () => {
  const running = await launchApp({ fixture: 'clean' })
  try {
    await expect(running.page).toHaveTitle('Sims Helper')
    await expect(running.page.getByText('Built by Tyler, for Lila.')).toBeVisible()
    await expect(
      running.page.getByText('Saves and Tray are never touched · A backup is made before any change')
    ).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Your mods' })).toHaveCount(0)
    await expect(running.page.getByRole('button', { name: 'History' })).toHaveCount(0)
    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})

test('stubIpc replaces IPC handlers with inOrder values and preload blocks unknown channels', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'game:check': inOrder(['running', 'not-running'] as const)
    })

    const first = await running.page.evaluate(() =>
      (globalThis as unknown as { simsHelper: SimsHelperApi }).simsHelper.invoke('game:check')
    )
    const second = await running.page.evaluate(() =>
      (globalThis as unknown as { simsHelper: SimsHelperApi }).simsHelper.invoke('game:check')
    )
    expect(first).toBe('running')
    expect(second).toBe('not-running')

    const rejected = await running.page.evaluate(async () => {
      try {
        await (globalThis as unknown as { simsHelper: SimsHelperApi }).simsHelper.invoke('nope:channel' as never)
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })
    expect(rejected).toContain('not allowed')
    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})
