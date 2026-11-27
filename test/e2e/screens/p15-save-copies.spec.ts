import { expect, test, type Page } from '@playwright/test'
import type { GameVersionWatch, SaveCopy, StartupRecovery } from '../../../src/shared/model.ts'
import { launchApp, shoot, stubIpc, type LaunchedApp, type StubIpcMap } from '../support/app.ts'

const SLUG = 'p15-save-copies'

const NOTHING_RECOVERED: StartupRecovery = { status: 'finished', touched: [] }
const NO_GAME_UPDATE: GameVersionWatch = { current: null, lastSeen: null, changed: false, seenAt: null }
const WELCOME = { welcome: 'not-seen', folderPath: null } as const
const HASH = 'a'.repeat(64)

function copy(overrides: Partial<SaveCopy> = {}): SaveCopy {
  return {
    id: '20261126-120000-0001',
    at: '2026-11-26T18:00:00.000Z',
    reason: 'by-hand',
    gameVersion: '1.130.12.1020',
    saves: [
      { name: 'Slot_00000002.save', bytes: 4_200_000, sha256: HASH, savedAt: '2026-11-25T20:00:00.000Z' },
      { name: 'Slot_00000005.save', bytes: 9_800_000, sha256: HASH, savedAt: '2026-11-26T17:30:00.000Z' },
      { name: 'Slot_00000009.save', bytes: 2_100_000, sha256: HASH, savedAt: '2026-11-20T15:10:00.000Z' }
    ],
    trayFiles: 24,
    bytes: 18_400_000,
    status: 'checked',
    ...overrides
  }
}

const COPIES: SaveCopy[] = [
  copy(),
  copy({ id: '20261125-090000-0002', at: '2026-11-25T09:00:00.000Z', reason: 'before-change', bytes: 17_900_000 }),
  copy({
    id: '20261119-210000-0003',
    at: '2026-11-19T21:00:00.000Z',
    reason: 'game-updated',
    gameVersion: '1.129.39.1030',
    bytes: 16_200_000
  })
]

let running: LaunchedApp

test.beforeAll(async () => {
  running = await launchApp()
  // Screenshot mode: no transitions, so the instant light to dark switch never catches a color mid-fade.
  await running.page.addInitScript({
    content: `(() => {
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      const attach = () => { if (!style.isConnected) (document.head || document.documentElement).appendChild(style) };
      if (document.head) attach(); else window.addEventListener('DOMContentLoaded', attach, { once: true });
    })();`
  })
})

test.afterAll(async () => {
  await running?.close()
})

async function openSaveCopies(page: Page, stubs: StubIpcMap): Promise<void> {
  await stubIpc(running.app, {
    'settings:get': WELCOME,
    'journal:recovery': NOTHING_RECOVERED,
    'patchguard:watch': NO_GAME_UPDATE,
    ...stubs
  })
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Save copies' }).click()
  await page.mouse.move(480, 650) // no hover left on the nav in the shot
}

test('captures light and dark screenshots of each save copies state', async () => {
  const { page, app } = running

  await openSaveCopies(page, { 'savecopies:list': COPIES })
  await expect(page.getByTestId('save-copy')).toHaveCount(3)
  await shoot(page, SLUG, 'list')

  await openSaveCopies(page, { 'savecopies:list': [] })
  await expect(page.getByText('No save copies yet')).toBeVisible()
  await shoot(page, SLUG, 'empty')

  await openSaveCopies(page, { 'savecopies:list': COPIES })
  // A copy that never finishes, so the shot catches it working.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('savecopies:make')
    ipcMain.handle('savecopies:make', () => new Promise(() => {}))
  })
  await page.getByRole('button', { name: 'Save a copy now' }).click()
  await expect(page.getByText('Making a copy of your saves…')).toBeVisible()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'making-a-copy')

  await openSaveCopies(page, {
    'savecopies:list': COPIES,
    'savecopies:put-back': { kind: 'done', newSlot: 'Slot_0000000a.save' }
  })
  await page.getByRole('button', { name: 'Put a save back' }).first().click()
  await expect(page.getByRole('list', { name: 'Saves in this copy' })).toBeVisible()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'put-back-picker')

  await page.getByRole('button', { name: 'Put this one back' }).first().click()
  await expect(page.getByText("It's in the game's Load menu as a new save.", { exact: false })).toBeVisible()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'put-back-done')

  await openSaveCopies(page, {
    'savecopies:list': [copy({ status: 'broken' }), ...COPIES.slice(1)]
  })
  await expect(page.getByText("This copy didn't check out, so it can't be put back.")).toBeVisible()
  await shoot(page, SLUG, 'broken-copy')

  await openSaveCopies(page, {
    'savecopies:list': COPIES,
    'savecopies:make': { kind: 'refused', why: 'game-running' }
  })
  await page.getByRole('button', { name: 'Save a copy now' }).click()
  await expect(page.getByText('Close The Sims 4 first')).toBeVisible()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'game-running')

  expect(running.consoleErrors).toEqual([])
})
