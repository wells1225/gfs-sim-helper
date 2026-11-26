import { expect, test } from '@playwright/test'
import type { DisabledGroup, JournalEntry, StartupRecovery } from '../../../src/shared/model.ts'
import { SAMPLE_SHA_A, SAMPLE_SHA_B, sampleJournalEntry, sampleScan } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc, type StubIpcMap } from '../support/app.ts'

const PR_SLUG = 'pr-10-fixes'

const NOTHING_RECOVERED: StartupRecovery = { status: 'finished', touched: [] }

const NO_TRANSITIONS = `(() => {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  const attach = () => {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  };
  if (document.head) attach();
  else window.addEventListener('DOMContentLoaded', attach, { once: true });
})();`

async function openCheckUp(extraStubs: StubIpcMap = {}) {
  const scan = sampleScan()
  const running = await launchApp()
  try {
    await running.page.addInitScript({ content: NO_TRANSITIONS })
    await stubIpc(running.app, {
      'journal:recovery': NOTHING_RECOVERED,
      'journal:list': [],
      'groups:disabled': [],
      'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
      'scan:run': { status: 'done', scan },
      ...extraStubs
    })
    await running.page.getByRole('button', { name: /closes by itself/i }).click()
    await expect(running.page.getByRole('heading', { name: 'Do this first', exact: true })).toBeVisible()
    return { running, scan }
  } catch (err) {
    await running.close()
    throw err
  }
}

function buildHistoryEntries(): JournalEntry[] {
  const folderPath = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'
  const modsDir = `${folderPath}\\Mods`
  const holdingRoot = 'C:\\Users\\Lila\\AppData\\Local\\SimsHelper\\holding'

  return [
    sampleJournalEntry({
      id: '20261124-122000-aa01',
      at: '2026-11-24T12:20:00.000Z',
      action: 'set-aside-files',
      summary: 'Set aside 3 zip files from Mods',
      steps: [
        {
          kind: 'move',
          from: `${modsDir}\\bundle_1.zip`,
          to: `${holdingRoot}\\20261124-122000-aa01\\Mods\\bundle_1.zip`,
          bytes: 51_200,
          sha256: SAMPLE_SHA_A,
          state: 'applied'
        },
        {
          kind: 'move',
          from: `${modsDir}\\bundle_2.zip`,
          to: `${holdingRoot}\\20261124-122000-aa01\\Mods\\bundle_2.zip`,
          bytes: 32_400,
          sha256: SAMPLE_SHA_B,
          state: 'applied'
        },
        {
          kind: 'move',
          from: `${modsDir}\\Downloads\\pack.zip`,
          to: `${holdingRoot}\\20261124-122000-aa01\\Mods\\Downloads\\pack.zip`,
          bytes: 84_100,
          sha256: SAMPLE_SHA_A,
          state: 'applied'
        }
      ],
      status: 'done',
      undo: 'can-undo'
    }),
    sampleJournalEntry({
      id: '20261124-121500-aa02',
      at: '2026-11-24T12:15:00.000Z',
      action: 'turn-mods-on',
      summary: 'Turned mods and script mods back on',
      steps: [
        {
          kind: 'edit',
          path: `${folderPath}\\Options.ini`,
          savedCopy: `${holdingRoot}\\20261124-121500-aa02\\edits\\Options.ini`,
          beforeSha256: SAMPLE_SHA_A,
          afterSha256: SAMPLE_SHA_B,
          state: 'applied'
        }
      ],
      status: 'done',
      undo: 'can-undo'
    }),
    sampleJournalEntry({
      id: '20261124-121000-aa03',
      at: '2026-11-24T12:10:00.000Z',
      action: 'clear-caches',
      summary: 'Cleared 2 temporary cache items',
      steps: [
        { kind: 'remove-cache', path: `${folderPath}\\localthumbcache.package`, state: 'applied' },
        { kind: 'remove-cache', path: `${folderPath}\\cachestr`, state: 'applied' }
      ],
      status: 'done',
      undo: 'cannot-undo'
    }),
    sampleJournalEntry({
      id: '20261124-120500-aa04',
      at: '2026-11-24T12:05:00.000Z',
      action: 'disable-group',
      summary: 'Set aside Wicked Wardrobe',
      origin: { by: 'fifty-fifty', sessionId: 'ff-session-1', round: 2 },
      groupId: 'cf:901234',
      groupLabel: 'Wicked Wardrobe',
      status: 'undone',
      undoneAt: '2026-11-24T12:08:00.000Z'
    }),
    sampleJournalEntry({
      id: '20261124-120200-aa05',
      at: '2026-11-24T12:02:00.000Z',
      action: 'disable-group',
      summary: 'Set aside BuildBuy',
      origin: { by: 'fifty-fifty', sessionId: 'ff-session-1', round: 1 },
      groupId: 'dir:buildbuy',
      groupLabel: 'BuildBuy',
      status: 'undone',
      undoneAt: '2026-11-24T12:08:00.000Z'
    })
  ]
}

test('branch shot: history', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'journal:recovery': NOTHING_RECOVERED,
      'journal:list': buildHistoryEntries()
    })

    await running.page.getByRole('button', { name: 'History' }).click()
    await expect(running.page.getByText('Set aside 3 zip files from Mods')).toBeVisible()
    await expect(running.page.getByText("Can't be undone")).toBeVisible()
    await expect(running.page.getByText('50/50 test')).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'history')
  } finally {
    await running.close()
  }
})

test('branch shot: history-safety-copies', async () => {
  const running = await launchApp()
  try {
    await running.page.addInitScript({ content: NO_TRANSITIONS })
    await stubIpc(running.app, {
      'journal:recovery': NOTHING_RECOVERED,
      'journal:list': buildHistoryEntries(),
      'backup:summary': {
        status: {
          state: 'verified',
          backupId: '20261124-122000-bk04',
          at: '2026-11-24T12:20:00.000Z'
        },
        verifiedCount: 4,
        totalBytes: Math.round(128.4 * 1024 * 1024),
        reclaimableBytes: Math.round(45.2 * 1024 * 1024),
        reclaimableBackups: 2,
        canPrune: true
      }
    })

    await running.page.getByRole('button', { name: 'History' }).click()
    await expect(running.page.getByText('Safety copies', { exact: true })).toBeVisible()
    await expect(running.page.getByText('Free 45.2 MB from 2 older safety copies')).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Clear old safety copies' })).toBeVisible()
    await expect(running.page.getByText('Set aside 3 zip files from Mods')).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'history-safety-copies')
  } finally {
    await running.close()
  }
})

test('branch shot: history-undone', async () => {
  const running = await launchApp()
  try {
    const entries = buildHistoryEntries()
    const target = entries[0]!
    const undoneTarget: JournalEntry = {
      ...target,
      status: 'undone',
      undoneAt: '2026-11-24T12:25:00.000Z'
    }

    await stubIpc(running.app, {
      'journal:recovery': NOTHING_RECOVERED,
      'journal:list': [target, entries[2]!],
      'journal:undo': { status: 'done', entry: undoneTarget }
    })

    await running.page.getByRole('button', { name: 'History' }).click()
    await expect(running.page.getByText('Set aside 3 zip files from Mods')).toBeVisible()

    await running.page.getByRole('button', { name: 'Undo' }).click()
    await expect(running.page.getByText('Undone', { exact: true }).first()).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'history-undone')
  } finally {
    await running.close()
  }
})

test('branch shot: recovery-notice', async () => {
  const running = await launchApp()
  try {
    const interrupted = sampleJournalEntry({
      id: '20261124-120100-rec1',
      action: 'disable-group',
      summary: 'Set aside Wicked Wardrobe',
      groupId: 'cf:901234',
      groupLabel: 'Wicked Wardrobe',
      hasScript: true,
      status: 'needs-attention'
    })

    await stubIpc(running.app, {
      'journal:recovery': NOTHING_RECOVERED,
      'journal:list': [interrupted]
    })

    await expect(running.page.getByText('A change was cut off before it finished')).toBeVisible()
    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'recovery-notice')
  } finally {
    await running.close()
  }
})

test('branch shot: recovery-put-back', async () => {
  const running = await launchApp()
  try {
    const putBack = sampleJournalEntry({
      id: '20261124-120100-rec2',
      action: 'disable-group',
      summary: 'Set aside Wicked Wardrobe',
      groupId: 'cf:901234',
      groupLabel: 'Wicked Wardrobe',
      status: 'undone',
      undo: 'can-undo',
      undoneAt: '2026-11-24T12:20:00.000Z'
    })

    await stubIpc(running.app, {
      'journal:recovery': { status: 'finished', touched: [putBack] },
      'journal:list': [putBack]
    })

    await expect(running.page.getByText('A change was cut off, so we put things back as they were.')).toBeVisible()
    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'recovery-put-back')
  } finally {
    await running.close()
  }
})

test('branch shot: recovery-failed', async () => {
  const running = await launchApp()
  try {
    await stubIpc(running.app, {
      'journal:recovery': { status: 'failed' },
      'journal:list': []
    })

    await expect(running.page.getByText('We could not check for a cut-off change')).toBeVisible()
    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'recovery-failed')
  } finally {
    await running.close()
  }
})

test('branch shot: mods-no-check-up', async () => {
  const running = await launchApp()
  try {
    const disabled: DisabledGroup[] = [
      {
        groupId: 'cf:901234',
        label: 'Wicked Wardrobe',
        entryId: '20261124-120500-d1',
        at: '2026-11-24T12:05:00.000Z',
        origin: 'fix'
      },
      {
        groupId: 'dir:buildbuy',
        label: 'BuildBuy',
        entryId: '20261124-114000-d2',
        at: '2026-11-24T11:40:00.000Z',
        origin: 'fifty-fifty'
      }
    ]

    await stubIpc(running.app, {
      'journal:recovery': NOTHING_RECOVERED,
      'journal:list': [],
      'groups:disabled': disabled
    })

    await running.page.getByRole('button', { name: 'Your mods' }).click()
    await expect(running.page.getByText('Run a check-up to see all your mods')).toBeVisible()
    await expect(running.page.getByText('Wicked Wardrobe')).toBeVisible()
    await expect(running.page.getByText('BuildBuy')).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'mods-no-check-up')
  } finally {
    await running.close()
  }
})

test('after-main shot: finding-with-fix', async () => {
  const { running } = await openCheckUp()
  try {
    await expect(running.page.getByRole('button', { name: 'Turn mods back on' })).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Move it up a folder' })).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'finding-with-fix')
  } finally {
    await running.close()
  }
})

test('after-main shot: fix-backing-up', async () => {
  const { running } = await openCheckUp()
  try {
    await running.app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('fix:apply')
      ipcMain.handle('fix:apply', () => {
        setTimeout(() => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win && !win.isDestroyed()) {
            win.webContents.send('progress', {
              task: 'backup',
              stage: 'copying',
              done: 1240,
              total: 5300
            })
          }
        }, 50)
        return new Promise(() => {
          // Held open so the screenshot captures the backup progress state
        })
      })
    })

    await running.page.getByRole('button', { name: 'Turn mods back on' }).click()
    await expect(running.page.getByText('Making a safety copy first…')).toBeVisible()
    await expect(running.page.getByText('Copying 1,240 of 5,300 files')).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'fix-backing-up')
  } finally {
    await running.close()
  }
})

test('after-main shot: fix-done', async () => {
  const doneEntry = sampleJournalEntry({
    id: '20261124-121500-fx01',
    at: '2026-11-24T12:15:00.000Z',
    action: 'turn-mods-on',
    summary: 'Turned mods and script mods back on',
    status: 'done',
    undo: 'can-undo'
  })

  const { running } = await openCheckUp({
    'fix:apply': { status: 'done', entry: doneEntry }
  })
  try {
    await running.page.getByRole('button', { name: 'Turn mods back on' }).click()
    await expect(
      running.page.locator('main').getByText('Turned mods and script mods back on', { exact: true })
    ).toBeVisible()
    await expect(running.page.locator('main').getByRole('button', { name: 'Undo' })).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'fix-done')
  } finally {
    await running.close()
  }
})

test('after-main shot: fix-game-running', async () => {
  const { running } = await openCheckUp({
    'fix:apply': { status: 'refused', refusal: { why: 'gate', refusal: { reason: 'game-running' } } }
  })
  try {
    await running.page.getByRole('button', { name: 'Turn mods back on' }).click()
    await expect(
      running.page.getByText('The Sims 4 is still open. Save and close the game, then try again.')
    ).toBeVisible()
    await expect(running.page.getByRole('button', { name: 'Try again' })).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'fix-game-running')
  } finally {
    await running.close()
  }
})

test('after-main shot: mods-list', async () => {
  const disabled: DisabledGroup[] = [
    {
      groupId: 'dir:buildbuy',
      label: 'BuildBuy',
      entryId: '20261124-114000-d2',
      at: '2026-11-24T11:40:00.000Z',
      origin: 'fix'
    }
  ]

  const { running } = await openCheckUp({
    'groups:disabled': disabled,
    'journal:list': [
      sampleJournalEntry({
        id: '20261124-114000-d2',
        at: '2026-11-24T11:40:00.000Z',
        action: 'disable-group',
        summary: 'Set aside BuildBuy',
        groupId: 'dir:buildbuy',
        groupLabel: 'BuildBuy',
        hasScript: false,
        status: 'done',
        undo: 'can-undo'
      })
    ]
  })
  try {
    await running.page.getByRole('button', { name: 'Your mods' }).click()
    await expect(running.page.getByRole('searchbox', { name: 'Search your mods' })).toBeVisible()
    await expect(running.page.getByText('Wicked Wardrobe')).toBeVisible()
    await expect(running.page.getByText('Hair')).toBeVisible()
    await expect(running.page.getByText('BuildBuy')).toBeVisible()
    await expect(running.page.getByText('2 active')).toBeVisible()
    await expect(running.page.getByText('1 set aside')).toBeVisible()

    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'mods-list')
  } finally {
    await running.close()
  }
})
