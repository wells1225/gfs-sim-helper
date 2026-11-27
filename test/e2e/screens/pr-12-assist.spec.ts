import { expect, test } from '@playwright/test'
import { NO_ANSWER_WORDS } from '../../../src/renderer/assist/words.ts'
import type { AssistAnswer, AssistPreview } from '../../../src/shared/model.ts'
import { sampleScan } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc, type LaunchedApp } from '../support/app.ts'

const PR_SLUG = 'pr-12-assist'
// Made up. Every channel is stubbed, so no key store and no network is reached.
const FAKE_KEY = 'sk-ant-FAKE-TEST-KEY-not-real-0000'

test('branch shot: key-setup', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'assist:status': { key: 'not-set', offer: 'hide' }
    })

    // The shell binds Ctrl+Shift+K in an effect after the first render. Since PR 7 it opens on the start
    // screen, so go to About and wait for it before pressing.
    await running.page.getByRole('button', { name: 'About' }).click()
    await expect(running.page.getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'page')
    await running.page.keyboard.press('Control+Shift+K')
    await expect(running.page.getByText('Ask for help setup')).toBeVisible()
    await expect(running.page.getByText('No key is stored on this PC.')).toBeVisible()
    await expect(running.page.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password')

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'key-setup')
  } finally {
    await running.close()
  }
})

test('branch shot: key-setup-saved', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'assist:status': { key: 'not-set', offer: 'hide' },
      'assist:set-key': 'set'
    })

    // The shell binds Ctrl+Shift+K in an effect after the first render. Since PR 7 it opens on the start
    // screen, so go to About and wait for it before pressing.
    await running.page.getByRole('button', { name: 'About' }).click()
    await expect(running.page.getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'page')
    await running.page.keyboard.press('Control+Shift+K')
    await expect(running.page.getByText('No key is stored on this PC.')).toBeVisible()

    const field = running.page.getByLabel('Anthropic API key')
    await field.fill(FAKE_KEY)
    await running.page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(running.page.getByText('A key is stored on this PC.')).toBeVisible()
    await expect(field).toHaveValue('')
    expect(await running.page.content()).not.toContain(FAKE_KEY)

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'key-setup-saved')
  } finally {
    await running.close()
  }
})

// After-main shots: AskEntry sits under PR 7's check-up cards, and AskScreen is behind it.
const PREVIEW: AssistPreview = {
  id: 'preview-1',
  text: [
    'Game version: 1.129.39.1030',
    '',
    'Newest error log (lastException_63887259912.txt):',
    'AttributeError: NoneType object has no attribute sim_info',
    '  at outfit_picker.py:42',
    '',
    'Mods (2): Wicked Wardrobe, cozy_braids.package'
  ].join('\n')
}
const ANSWER_TEXT =
  'The error comes from Wicked Wardrobe (outfit_picker.py). It often breaks after a game patch. ' +
  'Check CurseForge for an update to Wicked Wardrobe, or move it out of Mods for now and see if the game still crashes.'

// Kills Button's transition-colors, so shoot()'s instant light-to-dark switch never lands mid-fade.
const NO_TRANSITIONS = `(() => {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  const attach = () => {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  };
  if (document.head) attach();
  else window.addEventListener('DOMContentLoaded', attach, { once: true });
})();`

/** The app on PR 7's check-up with findings and a stored key, so AskEntry offers help. */
async function openCheckUp(running: LaunchedApp, send: AssistAnswer): Promise<void> {
  const scan = sampleScan()
  await running.page.addInitScript({ content: NO_TRANSITIONS })
  await stubIpc(running.app, {
    'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
    'scan:run': { status: 'done', scan },
    'assist:status': { key: 'set', offer: 'offer' },
    'assist:preview': PREVIEW,
    'assist:send': send
  })
  await running.page.getByRole('button', { name: /closes by itself/i }).click()
  await expect(running.page.getByRole('heading', { name: 'Do this first', exact: true })).toBeVisible()
  await expect(running.page.getByText('Still stuck? Ask for help')).toBeVisible()
}

async function openPreview(running: LaunchedApp): Promise<void> {
  await running.page.getByRole('button', { name: 'Ask for help', exact: true }).click()
  await expect(running.page.getByText('Here is exactly what will be sent')).toBeVisible()
  await expect(running.page.getByTestId('assist-preview')).toHaveText(PREVIEW.text)
}

test('after-main shot: ask-entry', async () => {
  const running = await launchApp()
  try {
    await openCheckUp(running, { status: 'answered', text: ANSWER_TEXT })
    const entry = running.page.getByRole('button', { name: 'Ask for help', exact: true })
    await entry.scrollIntoViewIfNeeded()
    await expect(entry).toBeInViewport()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'ask-entry')
  } finally {
    await running.close()
  }
})

test('after-main shot: ask-preview', async () => {
  const running = await launchApp()
  try {
    await openCheckUp(running, { status: 'answered', text: ANSWER_TEXT })
    await openPreview(running)
    await expect(running.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await expect(running.page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'ask-preview')
  } finally {
    await running.close()
  }
})

test('after-main shot: ask-answer', async () => {
  const running = await launchApp()
  try {
    await openCheckUp(running, { status: 'answered', text: ANSWER_TEXT })
    await openPreview(running)
    await running.page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(running.page.getByText('This is a guess')).toBeVisible()
    await expect(running.page.getByTestId('assist-answer')).toHaveText(ANSWER_TEXT)

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'ask-answer')
  } finally {
    await running.close()
  }
})

test('after-main shot: ask-no-answer', async () => {
  const running = await launchApp()
  try {
    await openCheckUp(running, { status: 'no-answer', why: 'offline' })
    await openPreview(running)
    await running.page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(running.page.getByText(NO_ANSWER_WORDS.offline.title)).toBeVisible()
    await expect(running.page.getByText(NO_ANSWER_WORDS.offline.detail)).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Try again' })).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'ask-no-answer')
  } finally {
    await running.close()
  }
})
