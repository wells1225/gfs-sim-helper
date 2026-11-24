import { expect, test } from '@playwright/test'
import { launchApp, shoot, stubIpc } from '../support/app.ts'

const PR_SLUG = 'pr-12-assist'
// Made up. Every channel is stubbed, so no key store and no network is reached.
const FAKE_KEY = 'sk-ant-FAKE-TEST-KEY-not-real-0000'

test('branch shot: key-setup', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'assist:status': { key: 'not-set', offer: 'hide' }
    })

    // The shell binds Ctrl+Shift+K in an effect after the first render: wait for it before pressing.
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

    // The shell binds Ctrl+Shift+K in an effect after the first render: wait for it before pressing.
    await expect(running.page.getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'page')
    await running.page.keyboard.press('Control+Shift+K')
    await expect(running.page.getByText('No key is stored on this PC.')).toBeVisible()

    const field = running.page.getByLabel('Anthropic API key')
    await field.fill(FAKE_KEY)
    await running.page.getByRole('button', { name: 'Save' }).click()

    await expect(running.page.getByText('A key is stored on this PC.')).toBeVisible()
    await expect(field).toHaveValue('')
    expect(await running.page.content()).not.toContain(FAKE_KEY)

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'key-setup-saved')
  } finally {
    await running.close()
  }
})

// After-main shots: AskEntry sits in PR 7's check-up screen, which is a stub on this branch.
test.fixme('after-main shot: ask-entry', async () => {})
test.fixme('after-main shot: ask-preview', async () => {})
test.fixme('after-main shot: ask-answer', async () => {})
test.fixme('after-main shot: ask-no-answer', async () => {})
