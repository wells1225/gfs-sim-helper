import { expect, test, type Page } from '@playwright/test'
import type { FiftyFifty, ModGroup } from '../../../src/shared/model.ts'
import { sampleFiftyFifty } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc, type LaunchedApp } from '../support/app.ts'

const SLUG = 'pr-11-fifty-fifty'

const LABELS = ['Wicked Wardrobe', 'MC Command Center', 'Hair', 'BuildBuy', 'Skin Details', 'Poses', 'Clutter', 'Shoes']

/** 64 groups, round 2 of about 6, with 32 suspects left and 16 of them set aside. */
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
    roundsAtMost: 6,
    groups,
    suspects: ids.slice(0, 32),
    parked: ids.slice(0, 16),
    inMods: ids.slice(16, 32),
    cleared: ids.slice(32),
    history: [{ round: 1, parked: ids.slice(32), answer: 'crashed' }],
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
  history: Array.from({ length: 6 }, (_, i) => ({ round: i + 1, parked: [], answer: 'worked' as const }))
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
  await expect(running.page.getByText('50/50 test in progress · Round 2 of about 6')).toBeVisible()
  await shoot(running.page, SLUG, 'resume-banner')
})

test('close-curseforge', async () => {
  const page = await enterAt(midSession({ phase: 'close-curseforge' }))
  await expect(page.getByRole('heading', { name: 'First, close CurseForge' })).toBeVisible()
  await expect(page.getByText('Round 2 of about 6 · 32 mod groups left')).toBeVisible()
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
  const page = await enterAt(FOUND)
  await expect(page.getByRole('heading', { name: 'We found the most likely cause' })).toBeVisible()
  await expect(page.getByText('MC Command Center', { exact: true })).toBeVisible()
  await shoot(page, SLUG, 'found')
})

test('stopped', async () => {
  const state = midSession()
  const page = await enterAt(state, { 'fifty:stop': { status: 'ok', state: { ...state, phase: 'stopped', parked: [] } } })
  await page.getByRole('button', { name: 'Stop the test' }).click()
  await expect(page.getByText('Stop the 50/50 test and put all your mods back?')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Put everything back and stop' }).click()
  await expect(page.getByRole('heading', { name: 'The 50/50 test is stopped' })).toBeVisible()
  await shoot(page, SLUG, 'stopped')
})

// After main: PR 7's check-up screen hosts <FiftyEntry />. Needs a scan with a 'fifty-fifty' finding.
test.fixme('entry-on-check-up', async () => {
  await shoot(running.page, SLUG, 'entry-on-check-up')
})
