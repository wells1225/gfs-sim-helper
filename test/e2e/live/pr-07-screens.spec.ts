import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, test } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { launchApp } from '../support/app.ts'

async function readWindowsBigBaselineMs(): Promise<number> {
  const raw = await readFile(resolve(process.cwd(), 'src/main/inventory/perf-baseline.json'), 'utf8')
  const parsed = JSON.parse(raw) as { windowsBigMs?: unknown }
  if (typeof parsed.windowsBigMs !== 'number' || parsed.windowsBigMs <= 0) {
    throw new Error(`Invalid windowsBigMs in perf-baseline.json: ${raw}`)
  }
  return parsed.windowsBigMs
}

test('live: patch-day shows mods-off first and Send to Tyler writes a redacted report zip', async () => {
  test.setTimeout(60_000)
  const running = await launchApp({ fixture: 'patch-day' })
  try {
    const { page, desktopDir } = running
    expect(desktopDir).not.toBeNull()

    await expect(page.getByRole('heading', { name: 'Welcome to Sims Helper' })).toBeVisible()
    await page.getByRole('button', { name: "Let's take a look" }).click()

    await expect(page.getByRole('heading', { name: 'What happened?' })).toBeVisible()
    await page.getByRole('button', { name: /closes by itself/i }).click()

    await expect(page.getByRole('heading', { name: 'Do this first', exact: true })).toBeVisible({ timeout: 20_000 })
    const firstSectionHeading = page.locator('main section h2').first()
    await expect(firstSectionHeading).toHaveText('Do this first')

    const firstCard = page.locator('main section').first().locator('[role="alert"]').first()
    await expect(firstCard).toBeVisible()
    await expect(firstCard).toContainText('Your mods and script mods are turned off')

    await page.getByRole('button', { name: 'Send to Tyler' }).click()
    await expect(page.getByRole('heading', { name: 'Send a report to Tyler' })).toBeVisible()
    await page.getByRole('button', { name: /create report zip/i }).click()
    await expect(page.getByText('Report saved on your Desktop')).toBeVisible({ timeout: 15_000 })

    const desktopFiles = (await readdir(desktopDir!)).filter((name) => name.toLowerCase().endsWith('.zip'))
    expect(desktopFiles).toHaveLength(1)
    expect(desktopFiles[0]).toMatch(/^Sims Helper report \d{8}-\d{6}\.zip$/)

    const zipBytes = await readFile(join(desktopDir!, desktopFiles[0]!))
    const unzipped = unzipSync(new Uint8Array(zipBytes))
    const entryNames = Object.keys(unzipped)
    expect(entryNames).toContain('Options.ini')
    expect(entryNames).toContain('GameVersion.txt')
    expect(entryNames).toContain('scan.json')

    for (const [name, bytes] of Object.entries(unzipped)) {
      expect(name, `entry name ${name} must not contain player`).not.toMatch(/player/i)
      const content = strFromU8(bytes)
      expect(content, `entry content of ${name} must not contain player`).not.toMatch(/player/i)
    }

    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})

test('live: big fixture shows the first finding within twice the PR 4 baseline plus 3 seconds', async () => {
  test.setTimeout(90_000)
  const baselineMs = await readWindowsBigBaselineMs()
  const budgetMs = baselineMs * 2 + 3_000

  const running = await launchApp({ fixture: 'big' })
  try {
    const { page } = running

    await expect(page.getByRole('heading', { name: 'Welcome to Sims Helper' })).toBeVisible()
    await page.getByRole('button', { name: "Let's take a look" }).click()
    await expect(page.getByRole('heading', { name: 'What happened?' })).toBeVisible()

    const started = performance.now()
    await page.getByRole('button', { name: /just check everything/i }).click()

    const finishedMarker = page
      .locator('main section')
      .first()
      .or(page.getByRole('button', { name: 'Check again' }))
      .or(page.getByRole('heading', { name: "We couldn't finish the check-up" }))
    try {
      await expect(finishedMarker.first()).toBeVisible({ timeout: 45_000 })
    } catch (err) {
      const mainText = await page.locator('main').innerText().catch(() => '<unreadable>')
      console.error(`[pr-07-live] big timed out; consoleErrors=${JSON.stringify(running.consoleErrors)}\nmain:\n${mainText}`)
      throw err
    }

    const elapsedMs = Math.round(performance.now() - started)
    const sectionCount = await page.locator('main section').count()
    if (sectionCount === 0) {
      const mainText = await page.locator('main').innerText().catch(() => '<unreadable>')
      console.error(`[pr-07-live] big finished in ${elapsedMs}ms with 0 sections; consoleErrors=${JSON.stringify(running.consoleErrors)}\nmain:\n${mainText}`)
    }
    expect(sectionCount, 'expected at least one finding section on big').toBeGreaterThan(0)

    console.log(`[pr-07-live] big first finding elapsedMs=${elapsedMs} budgetMs=${budgetMs} baselineMs=${baselineMs}`)
    expect(elapsedMs).toBeLessThan(budgetMs)
    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})
