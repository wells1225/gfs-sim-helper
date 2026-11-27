import { expect, test } from '@playwright/test'
import type {
  GameVersionWatch,
  SaveCopy,
  StartupRecovery,
  WaitingOnMod
} from '../../../src/shared/model.ts'
import { sampleScan } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc, type LaunchedApp } from '../support/app.ts'

const SLUG = 'p16-patch-guard'

const NOTHING_RECOVERED: StartupRecovery = { status: 'finished', touched: [] }

const UPDATED_WATCH: GameVersionWatch = {
  current: '1.130.12.1020',
  lastSeen: '1.129.39.1030',
  changed: true,
  seenAt: '2026-11-20T18:00:00.000Z'
}

const NO_UPDATE_WATCH: GameVersionWatch = {
  current: '1.130.12.1020',
  lastSeen: '1.130.12.1020',
  changed: false,
  seenAt: '2026-11-26T18:00:00.000Z'
}

const UPDATE_SAVE_COPY: SaveCopy = {
  id: '20261126-180000-pg01',
  at: '2026-11-26T18:00:00.000Z',
  reason: 'game-updated',
  gameVersion: '1.130.12.1020',
  saves: [
    {
      name: 'Slot_00000002.save',
      bytes: 4_200_000,
      sha256: 'a'.repeat(64),
      savedAt: '2026-11-25T20:00:00.000Z'
    }
  ],
  trayFiles: 8,
  bytes: 6_400_000,
  status: 'checked'
}

const FOUR_WAITING: WaitingOnMod[] = [
  {
    groupId: 'cf:160101',
    label: 'MC Command Center',
    entryId: '20261122-120001-w001',
    setAsideAt: '2026-11-22T12:00:01.000Z',
    state: 'waiting',
    updatedAt: null
  },
  {
    groupId: 'cf:160102',
    label: 'UI Cheats Extension',
    entryId: '20261122-120002-u002',
    setAsideAt: '2026-11-22T12:00:02.000Z',
    state: 'updated',
    updatedAt: '2026-11-25T15:00:00.000Z'
  },
  {
    groupId: 'cf:160103',
    label: 'Wicked Wardrobe',
    entryId: '20261122-120003-b003',
    setAsideAt: '2026-11-22T12:00:03.000Z',
    state: 'back-in-mods',
    updatedAt: '2026-11-26T14:00:00.000Z'
  },
  {
    groupId: 'dir:manualscript',
    label: 'Better BuildBuy',
    entryId: '20261122-120004-m004',
    setAsideAt: '2026-11-22T12:00:04.000Z',
    state: 'not-curseforge',
    updatedAt: null
  }
]

let running: LaunchedApp

test.beforeAll(async () => {
  running = await launchApp()
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

test('captures light and dark screenshots for patch day guard and Play button', async () => {
  const { app, page } = running
  const scan = sampleScan()

  // 1. Update banner on every screen
  await stubIpc(app, {
    'journal:recovery': NOTHING_RECOVERED,
    'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
    'patchguard:watch': UPDATED_WATCH,
    'patchguard:waiting': [],
    'groups:disabled': [],
    'journal:list': [],
    'scan:run': { status: 'done', scan },
    'savecopies:make': { kind: 'done', copy: UPDATE_SAVE_COPY }
  })
  await expect(page.getByText(/The Sims 4 updated/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Get ready' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'banner')

  // 2. Patch day screen with the three steps (after running a quick check-up so Step 2 lists script mods)
  await page.getByRole('button', { name: /closes by itself/i }).click()
  await expect(page.getByRole('heading', { name: 'Do this first', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Get ready' }).click()
  await expect(page.getByTestId('patch-day-step-1')).toBeVisible()
  await expect(page.getByText('Your saves and households are backed up.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set aside all script mods' })).toBeVisible()
  await expect(page.getByRole('button', { name: "I'm ready, let's play" })).toBeVisible()
  await page.getByTestId('patch-day-step-3').scrollIntoViewIfNeeded()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'patch-day-steps')

  // 3. Waiting on list with all four states
  await stubIpc(app, {
    'journal:recovery': NOTHING_RECOVERED,
    'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
    'patchguard:watch': NO_UPDATE_WATCH,
    'patchguard:waiting': FOUR_WAITING,
    'groups:disabled': [],
    'journal:list': []
  })
  await page.getByRole('button', { name: /just updated/i }).click()
  const waitingHeading = page.getByRole('heading', { name: 'Waiting on', exact: true })
  await expect(waitingHeading).toBeVisible()
  await expect(page.getByText('MC Command Center')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Turn it back on' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear the old copy' })).toBeVisible()
  await expect(page.getByText("Check the creator's page.")).toBeVisible()
  await page.getByTestId('waiting-on-item').last().scrollIntoViewIfNeeded()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'waiting-on-list')

  // 4. Play refused while running
  await stubIpc(app, {
    'journal:recovery': NOTHING_RECOVERED,
    'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
    'patchguard:watch': NO_UPDATE_WATCH,
    'patchguard:play': { kind: 'refused', why: 'already-running' }
  })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByText('The Sims 4 is already open')).toBeVisible()
  await page.mouse.move(480, 650)
  await shoot(page, SLUG, 'play-refused-running')

  expect(running.consoleErrors).toEqual([])
})
