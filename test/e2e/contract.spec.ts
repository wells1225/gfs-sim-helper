import { expect, test } from '@playwright/test'
import { FIXES_READY } from '../../src/renderer/fixes/feature.ts'
import type { SimsHelperApi } from '../../src/shared/ipc.ts'
import { inOrder, launchApp, setColorScheme, stubIpc } from './support/app.ts'

const FOOTER = 'Saves and Tray are never touched · A backup is made before any change'

test('launches a first run against the clean fixture with the shell and an empty console', async () => {
  const running = await launchApp({ fixture: 'clean' })
  try {
    await expect(running.page).toHaveTitle('Sims Helper')
    await expect(running.page.getByText(FOOTER)).toBeVisible()
    await expect(running.page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Check-up' })).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'About' })).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Your mods' })).toHaveCount(FIXES_READY ? 1 : 0)
    await expect(running.page.getByRole('button', { name: 'History' })).toHaveCount(FIXES_READY ? 1 : 0)
    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})

test('with reduced motion, switching to dark repaints the header title and nav in the dark foreground', async () => {
  const running = await launchApp()
  try {
    const { page } = running
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })

    const colors = () =>
      page.evaluate(() => {
        interface El {
          textContent: string | null
          getAttribute(name: string): string | null
        }
        const g = globalThis as unknown as {
          document: { body: El; querySelectorAll(selector: string): Iterable<El> }
          getComputedStyle(el: El): { color: string }
        }
        const color = (el: El) => g.getComputedStyle(el).color
        const title = [...g.document.querySelectorAll('header span')].find((el) => el.textContent === 'Sims Helper')
        return {
          foreground: color(g.document.body),
          title: title ? color(title) : 'missing',
          nav: [...g.document.querySelectorAll('nav[aria-label="Primary"] button')]
            .filter((el) => el.getAttribute('aria-current') !== 'page')
            .map((el) => `${el.textContent}: ${color(el)}`)
        }
      })

    await setColorScheme(page, 'light')
    const light = await colors()
    await setColorScheme(page, 'dark')
    const dark = await colors()

    expect(dark.foreground).not.toBe(light.foreground)
    expect(dark.title).toBe(dark.foreground)
    expect(dark.nav.length).toBeGreaterThan(0)
    for (const item of dark.nav) {
      expect(item).toBe(`${item.split(':')[0]}: ${dark.foreground}`)
    }
  } finally {
    await running.close()
  }
})

test('the built page carries the exact Content-Security-Policy', async () => {
  const running = await launchApp()
  try {
    const csp = running.page.locator('meta[http-equiv="Content-Security-Policy"]')
    await expect(csp).toHaveCount(1)
    expect(await csp.getAttribute('content')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; " +
        "form-action 'none'"
    )
  } finally {
    await running.close()
  }
})

test('the installed app ignores ELECTRON_RENDERER_URL and still opens its own page', async () => {
  test.skip(!process.env['SIMS_HELPER_EXE'], 'needs the installed app (Windows CI)')
  const running = await launchApp({ env: { ELECTRON_RENDERER_URL: 'http://127.0.0.1:9/' } })
  try {
    await expect(running.page.getByText(FOOTER)).toBeVisible()
    expect(running.page.url()).toMatch(/^file:/)
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
