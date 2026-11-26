import { expect, test, type Page } from '@playwright/test'
import { crashWithoutCauseWords } from '../../../src/shared/copy/findings.ts'
import type { FiftyFifty, ModGroup, StartupRecovery } from '../../../src/shared/model.ts'
import { sampleFiftyFifty, sampleFinding, sampleJournalEntry, sampleScan } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc, type LaunchedApp } from '../support/app.ts'

const SLUG = 'pr-11-fifty-fifty'

const NOTHING_RECOVERED: StartupRecovery = { status: 'finished', touched: [] }

const LABELS = ['Wicked Wardrobe', 'MC Command Center', 'Hair', 'BuildBuy', 'Skin Details', 'Poses', 'Clutter', 'Shoes']

/** 64 groups, round 2 (displayed as Round 3 of about 7), with 32 suspects left and 16 of them set aside. */
function midSession(overrides: Partial<FiftyFifty> = {}): FiftyFifty {
  const groups: ModGroup[] = Array.from({ length: 64 }, (_, i) => ({
    id: `dir:g${i}`,
    label: i < LABELS.length ? LABELS[i]! : `CC folder ${i + 1}`,
    source: 'folder',
    files: [`g${i}/a.package`],
    bytes: 1000,
    hasScript: i < 2,
    curseForge: null
  }))
  const ids = groups.map((g) => g.id)
  return sampleFiftyFifty({
    phase: 'awaiting-answer',
    round: 2,
    roundsAtMost: 7,
    groups,
    suspects: ids.slice(0, 32),
    parked: ids.slice(0, 16),
    inMods: ids.slice(16, 32),
    cleared: ids.slice(32),
    history: [
      { round: 0, parked: ids, answer: 'worked' },
      { round: 1, parked: ids.slice(32), answer: 'crashed' }
    ],
    ...overrides
  })
}

const FOUND = midSession({
  phase: 'found',
  round: 6,
  suspects: ['dir:g1'],
  parked: ['dir:g1'],
  inMods: [],
  cleared: Array.from({ length: 64 }, (_, i) => `dir:g${i}`).filter((id) => id !== 'dir:g1'),
  culprit: 'dir:g1',
  history: Array.from({ length: 7 }, (_, i) => ({ round: i, parked: [], answer: 'worked' as const }))
})

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

test.beforeEach(async () => {
  // A cut-off change on this machine must never leak a notice into the shots.
  await stubIpc(running.app, { 'journal:recovery': NOTHING_RECOVERED })
  running.consoleErrors.length = 0
})

test.afterEach(async () => {
  expect(running.consoleErrors).toEqual([])
})

test.afterAll(async () => {
  await running?.close()
})

/** Stubs fifty:get with `state`, reloads, and enters the test through the resume banner. */
async function enterAt(state: FiftyFifty, extra: Parameters<typeof stubIpc>[1] = {}): Promise<Page> {
  await stubIpc(running.app, { 'fifty:get': state, ...extra })
  const { page } = running
  await page.getByRole('button', { name: 'Continue' }).click()
  return page
}

test('resume-banner', async () => {
  await stubIpc(running.app, { 'fifty:get': midSession() })
  await expect(running.page.getByText('50/50 test in progress · Round 3 of about 7')).toBeVisible()
  await shoot(running.page, SLUG, 'resume-banner')
})

test('close-curseforge', async () => {
  const page = await enterAt(midSession({ phase: 'close-curseforge' }))
  await expect(page.getByRole('heading', { name: 'First, close CurseForge' })).toBeVisible()
  await expect(page.getByText('Round 3 of about 7 · 32 mod groups left')).toBeVisible()
  await shoot(page, SLUG, 'close-curseforge')
})

test('round-test', async () => {
  const page = await enterAt(midSession())
  await expect(page.getByText('We set aside 16 mod groups and cleared the cache.')).toBeVisible()
  await shoot(page, SLUG, 'round-test')
})

test('round-answer', async () => {
  const page = await enterAt(midSession())
  await page.getByRole('button', { name: "I've tested it" }).click()
  await expect(page.getByRole('button', { name: 'It still crashed' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'No crash, it worked!' })).toBeVisible()
  await shoot(page, SLUG, 'round-answer')
})

test('found', async () => {
  await stubIpc(running.app, { 'fifty:get': FOUND })
  await expect(running.page.getByText('50/50 test: we found the most likely cause')).toBeVisible()
  // The card only says the other mods are back when History shows it: the cause is the one entry still set aside.
  const stillAside = sampleJournalEntry({
    action: 'disable-group',
    groupId: 'dir:g1',
    groupLabel: 'MC Command Center',
    folderPath: FOUND.folderPath,
    origin: { by: 'fifty-fifty', sessionId: FOUND.id, round: 6 }
  })
  const page = await enterAt(FOUND, { 'journal:list': [stillAside] })
  await expect(page.getByRole('heading', { name: 'We found the most likely cause' })).toBeVisible()
  await expect(page.getByText('MC Command Center', { exact: true })).toBeVisible()
  await expect(page.getByText(/We already put your other mods back and left MC Command Center set aside/)).toBeVisible()
  await shoot(page, SLUG, 'found')
})

test('stopped', async () => {
  const state = midSession()
  const page = await enterAt(state, {
    'fifty:stop': { status: 'ok', state: { ...state, phase: 'stopped', parked: [] } },
    'journal:list': []
  })
  await page.getByRole('button', { name: 'Stop the test' }).click()
  await expect(page.getByText('Stop the 50/50 test and put all your mods back?')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Put everything back and stop' }).click()
  await expect(page.getByRole('heading', { name: 'The 50/50 test is stopped' })).toBeVisible()
  await shoot(page, SLUG, 'stopped')
})

test('damaged-progress', async () => {
  await stubIpc(running.app, { 'fifty:get': { status: 'damaged' } })
  await expect(running.page.getByText("The 50/50 test's progress file is damaged")).toBeVisible()
  await expect(running.page.getByRole('button', { name: 'Put everything back and stop' })).toBeVisible()
  await shoot(running.page, SLUG, 'damaged-progress')
})

// After main: PR 7's check-up screen hosts <FiftyEntry />. A scan with a 'fifty-fifty' finding shows the big card.
test('entry-on-check-up', async () => {
  const words = crashWithoutCauseWords({ crashCount: 1, hasMods: true })
  const crash = sampleFinding({
    id: 'crash-without-cause',
    rule: 'crash-without-cause',
    severity: 'warn',
    certainty: 'worth-testing',
    title: words.title,
    detail: words.detail,
    evidence: ['lastCrash_2026-11-24.txt: crash at 2026-11-24 20:14, game 1.129.39.1030'],
    fixes: [],
    next: 'fifty-fifty'
  })
  const scan = sampleScan({ findings: [crash] })
  await stubIpc(running.app, {
    'fifty:get': null,
    'journal:list': [],
    'groups:disabled': [],
    'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
    'scan:run': { status: 'done', scan }
  })
  const { page } = running
  await page.getByRole('button', { name: /closes by itself/i }).click()
  await expect(page.getByText(words.title)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Not sure which mod it is?' })).toBeVisible()

  await page.setViewportSize({ width: 960, height: 700 })
  const start = page.getByRole('button', { name: 'Find it with the 50/50 test' })
  await start.scrollIntoViewIfNeeded()
  await expect(start).toBeInViewport()
  await expect(page.getByRole('heading', { name: 'Not sure which mod it is?' })).toBeInViewport()
  await shoot(page, SLUG, 'entry-on-check-up')
})

test('moving-mods', async () => {
  const page = await enterAt(midSession({ phase: 'ready-to-test' }))
  await running.app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('fifty:begin-round')
    ipcMain.handle('fifty:begin-round', () => {
      setTimeout(() => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send('progress', {
            task: 'fix',
            stage: 'moving',
            done: 11,
            total: 24
          })
        }
      }, 50)
      return new Promise(() => {
        // Held open so the screenshot captures the in-progress moving state
      })
    })
  })

  await page.getByRole('button', { name: 'Set up round 3' }).click()
  const status = page.locator('main').getByRole('status')
  await expect(status.getByText('Moving mod 11 of 24…')).toBeVisible()
  await expect(status.getByRole('progressbar')).toBeVisible()
  await expect(status.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '46')
  await shoot(page, SLUG, 'moving-mods')
})
