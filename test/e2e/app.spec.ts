import { expect, test } from '@playwright/test'
import { launchApp } from './support/app.ts'

test('first window greets Lila and About shows the dedication and disclaimer', async () => {
  const running = await launchApp({ fixture: 'clean' })
  try {
    await expect(running.page).toHaveTitle('Sims Helper')
    await expect(
      running.page.getByText("Hi Lila! Tyler made this so your game can stop crashing. Let's take a look at your mods.")
    ).toBeVisible()

    await running.page.getByRole('button', { name: 'About' }).click()
    await expect(running.page.getByText('Built by Tyler, for Lila.')).toBeVisible()
    await expect(
      running.page.getByText(
        'Independent helper tool for The Sims 4. Not affiliated with or endorsed by Electronic Arts or Maxis.'
      )
    ).toBeVisible()
    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})
