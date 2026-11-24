import { expect, test } from '@playwright/test'
import type { DisabledGroup, JournalEntry } from '../../../src/shared/model.ts'
import { SAMPLE_SHA_A, SAMPLE_SHA_B, sampleJournalEntry } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc } from '../support/app.ts'

const PR_SLUG = 'pr-10-fixes'

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
      'journal:list': [interrupted]
    })

    await expect(running.page.getByText('A previous change stopped partway through')).toBeVisible()
    expect(running.consoleErrors).toEqual([])
    await shoot(running.page, PR_SLUG, 'recovery-notice')
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

// After-main shots (need PR 7's Check-up screen to host FindingActions and populate session scan)
test.fixme('after-main shot: finding-with-fix', async () => {})
test.fixme('after-main shot: fix-backing-up', async () => {})
test.fixme('after-main shot: fix-done', async () => {})
test.fixme('after-main shot: fix-game-running', async () => {})
test.fixme('after-main shot: mods-list', async () => {})
