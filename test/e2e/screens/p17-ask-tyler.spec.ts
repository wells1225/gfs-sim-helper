import { expect, test } from '@playwright/test'
import type { ModRequest } from '../../../src/shared/model.ts'
import { sampleJournalEntry } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc, type LaunchedApp } from '../support/app.ts'

const PR_SLUG = 'p17-ask-tyler'
const MOD_FOLDER = 'G:\\My Drive\\Sims Helper Mods'

// Kills CSS transitions so shoot()'s instant light-to-dark switch never lands mid-fade.
const NO_TRANSITIONS = `(() => {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  const attach = () => {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  };
  if (document.head) attach();
  else window.addEventListener('DOMContentLoaded', attach, { once: true });
})();`

async function openAskTyler(running: LaunchedApp): Promise<void> {
  await running.page.addInitScript({ content: NO_TRANSITIONS })
  await running.page.getByRole('button', { name: 'Ask Tyler for a mod', exact: true }).click()
  await expect(running.page.getByRole('button', { name: 'Ask Tyler for a mod', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
}

const READY_REQUEST: ModRequest = {
  id: 'r-20261126-143000-aa01',
  at: '2026-11-26T14:30:00.000Z',
  text: 'Make Sims react happily when someone walks in wearing a brand new outfit.',
  status: 'ready',
  delivery: {
    title: 'Outfit Reactions',
    note: 'Sims now react to new outfits with a cheerful moodlet. Turn on script mods in Game Options. Works alongside MCCC and XML Injector.',
    files: [
      { name: 'outfit_reactions.package', bytes: 86_400 },
      { name: 'outfit_reactions.ts4script', bytes: 24_120 }
    ],
    hasScript: true
  }
}

const SENT_REQUEST: ModRequest = {
  id: 'r-20261126-130000-bb02',
  at: '2026-11-26T13:00:00.000Z',
  text: 'A matching pastel tea set that sits nicely on the kitchen counter.',
  status: 'sent',
  delivery: null
}

const INSTALLED_REQUEST: ModRequest = {
  id: 'r-20261125-180000-cc03',
  at: '2026-11-25T18:00:00.000Z',
  text: 'More sheer pastel swatches for living room curtains.',
  status: 'installed',
  delivery: {
    title: 'Pastel Curtains',
    note: 'Adds 8 soft pastel swatches to the base game sheer curtains.',
    files: [{ name: 'pastel_curtains.package', bytes: 148_500 }],
    hasScript: false
  }
}

const BROKEN_REQUEST: ModRequest = {
  id: 'r-20261125-120000-dd04',
  at: '2026-11-25T12:00:00.000Z',
  text: 'Make teen Sims finish their homework a bit faster.',
  status: 'broken',
  delivery: null
}

test('shot: setup', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'requests:folder': { kind: 'not-set' },
      'requests:list': []
    })
    await openAskTyler(running)
    await expect(running.page.getByRole('button', { name: 'Pick the Sims Helper Mods folder' })).toBeVisible()
    await expect(running.page.getByText(/Google Drive for desktop/i)).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'setup')
  } finally {
    await running.close()
  }
})

test('shot: send-box', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'requests:folder': { kind: 'set', path: MOD_FOLDER },
      'requests:list': []
    })
    await openAskTyler(running)
    const box = running.page.getByLabel("Tell Tyler what you'd like the mod to do")
    await expect(box).toBeVisible()
    await box.fill('Could you make a cozy slippers mod for Everyday and Sleepwear with soft pastel colors?')
    await expect(running.page.getByText('86 / 2,000')).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'send-box')
  } finally {
    await running.close()
  }
})

test('shot: sent', async () => {
  const running = await launchApp()
  try {
    const newReq: ModRequest = {
      id: 'r-20261126-150000-xy99',
      at: '2026-11-26T15:00:00.000Z',
      text: 'Could you make a cozy slippers mod for Everyday and Sleepwear with soft pastel colors?',
      status: 'sent',
      delivery: null
    }
    await stubIpc(running.app, {
      'requests:folder': { kind: 'set', path: MOD_FOLDER },
      'requests:list': [],
      'requests:send': { kind: 'sent', request: newReq }
    })
    await openAskTyler(running)
    const box = running.page.getByLabel("Tell Tyler what you'd like the mod to do")
    await box.fill(newReq.text)
    await running.page.getByRole('button', { name: 'Send to Tyler' }).click()
    await expect(running.page.getByText('Sent. Tyler will get an email.')).toBeVisible()
    await expect(running.page.getByText(newReq.text)).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'sent')
  } finally {
    await running.close()
  }
})

test('shot: ready-card', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'requests:folder': { kind: 'set', path: MOD_FOLDER },
      'requests:list': [READY_REQUEST]
    })
    await openAskTyler(running)
    await expect(running.page.getByText('Tyler made you a mod: Outfit Reactions')).toBeVisible()
    await expect(running.page.getByText('This mod needs script mods turned on in Game Options.')).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Install', exact: true })).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'ready-card')
  } finally {
    await running.close()
  }
})

test('shot: installed', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'requests:folder': { kind: 'set', path: MOD_FOLDER },
      'requests:list': [READY_REQUEST],
      'requests:install': {
        status: 'done',
        entry: sampleJournalEntry({
          id: '20261126-143500-ab12',
          action: 'install-mod',
          summary: 'Installed Outfit Reactions',
          groupId: `request:${READY_REQUEST.id}`,
          groupLabel: 'Outfit Reactions',
          hasScript: true
        })
      }
    })
    await openAskTyler(running)
    await expect(running.page.getByRole('button', { name: 'Install', exact: true })).toBeVisible()

    // Switch requests:list stub to return installed after the click.
    await running.app.evaluate(
      ({ ipcMain }, updated) => {
        ipcMain.removeHandler('requests:list')
        ipcMain.handle('requests:list', async () => updated)
      },
      [{ ...READY_REQUEST, status: 'installed' as const }]
    )

    await running.page.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(running.page.getByRole('heading', { name: 'Installed Outfit Reactions' })).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'View in History' })).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'installed')
  } finally {
    await running.close()
  }
})

test('shot: list-statuses', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'requests:folder': { kind: 'set', path: MOD_FOLDER },
      'requests:list': [READY_REQUEST, SENT_REQUEST, INSTALLED_REQUEST, BROKEN_REQUEST]
    })
    await openAskTyler(running)
    const listHeading = running.page.getByRole('heading', { name: 'Your requests', exact: true })
    await expect(listHeading).toBeVisible()
    await listHeading.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await expect(running.page.getByText("This one didn't arrive properly. Tyler has been told.")).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'list-statuses')
  } finally {
    await running.close()
  }
})

test('shot: broken-delivery', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'requests:folder': { kind: 'set', path: MOD_FOLDER },
      'requests:list': [BROKEN_REQUEST]
    })
    await openAskTyler(running)
    const brokenMsg = running.page.getByText("This one didn't arrive properly. Tyler has been told.")
    await expect(brokenMsg).toBeVisible()
    await brokenMsg.scrollIntoViewIfNeeded()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'broken-delivery')
  } finally {
    await running.close()
  }
})
