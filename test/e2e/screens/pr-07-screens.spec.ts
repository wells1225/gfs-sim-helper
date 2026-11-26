import { expect, test } from '@playwright/test'
import { sampleScan } from '../../../src/shared/testing/sample.ts'
import { launchApp, shoot, stubIpc } from '../support/app.ts'

const SLUG = 'pr-07-screens'

test('captures light and dark screenshots of all PR 7 read-only screens', async () => {
  const scan = sampleScan()
  const otherFolderPath = 'C:\\Users\\Lila\\OneDrive\\Documents\\Electronic Arts\\The Sims 4'

  const running = await launchApp()
  try {
    const { app, page } = running
    // Disable CSS transitions in screenshot mode so shoot()'s instant light->dark switch
    // never captures Button's transition-colors mid-flight.
    await page.addInitScript({
      content: `(() => {
        const style = document.createElement('style');
        style.textContent = '*, *::before, *::after { transition: none !important; }';
        const attach = () => {
          if (!style.isConnected) {
            (document.head || document.documentElement).appendChild(style);
          }
        };
        if (document.head) attach();
        else window.addEventListener('DOMContentLoaded', attach, { once: true });
      })();`
    })

    // 1. Welcome
    await stubIpc(app, {
      'settings:get': { welcome: 'not-seen', folderPath: null }
    })
    await expect(
      page.getByText("Hi Lila! Tyler made this so your game can stop crashing. Let's take a look at your mods.")
    ).toBeVisible()
    await shoot(page, SLUG, 'welcome')

    // 2. Pick folder
    await stubIpc(app, {
      'settings:get': { welcome: 'seen', folderPath: null },
      'locate:run': {
        folders: [
          scan.folder,
          {
            path: otherFolderPath,
            inOneDrive: true,
            newestFileAt: new Date('2026-09-12T14:00:00.000Z')
          }
        ],
        game: scan.game,
        gameRunning: 'not-running'
      }
    })
    await expect(page.getByText('Which Sims 4 folder do you play in?')).toBeVisible()
    await expect(page.getByText('Most recently used')).toBeVisible()
    await shoot(page, SLUG, 'pick-folder')

    // 3. What happened?
    await stubIpc(app, {
      'settings:get': { welcome: 'seen', folderPath: scan.folder.path }
    })
    await expect(page.getByRole('heading', { name: 'What happened?' })).toBeVisible()
    await shoot(page, SLUG, 'what-happened')

    // 4. Check-up (scanning)
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('scan:run')
      ipcMain.handle('scan:run', () => {
        setTimeout(() => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win && !win.isDestroyed()) {
            win.webContents.send('progress', {
              task: 'scan',
              stage: 'mods',
              done: 1420,
              total: 5300
            })
          }
        }, 50)
        return new Promise(() => {
          // Held open so the screenshot captures the scanning state
        })
      })
    })
    await page.getByRole('button', { name: /closes by itself/i }).click()
    await expect(page.getByText('Checking mod 1,420 of 5,300')).toBeVisible()
    await shoot(page, SLUG, 'check-up-scanning')

    // 5. Check-up (findings)
    await stubIpc(app, {
      'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
      'scan:run': { status: 'done', scan: sampleScan({ gameRunning: 'running' }) },
      'report:build': {
        status: 'saved',
        fileName: 'Sims Helper report 20261124-120000.zip',
        entries: [
          'lastException_63887259912.txt',
          'Options.ini',
          'GameVersion.txt',
          'scan.json',
          'AddonGameInstance.json'
        ]
      },
      'report:reveal': undefined
    })
    await page.getByRole('button', { name: /closes by itself/i }).click()
    await expect(page.getByRole('heading', { name: 'Do this first', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Worth fixing', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Good to know', exact: true })).toBeVisible()
    await shoot(page, SLUG, 'check-up-findings')

    // 6. Send to Tyler (after saving so the file name and Show on Desktop show)
    await page.getByRole('button', { name: 'Send to Tyler' }).click()
    await expect(page.getByRole('heading', { name: 'Send a report to Tyler' })).toBeVisible()
    await page.getByRole('button', { name: /create report zip/i }).click()
    await expect(page.getByText('Sims Helper report 20261124-120000.zip')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show on Desktop' })).toBeVisible()
    await shoot(page, SLUG, 'send-to-tyler')

    // 7. Check-up (all clear)
    await stubIpc(app, {
      'settings:get': { welcome: 'seen', folderPath: scan.folder.path },
      'scan:run': { status: 'done', scan: sampleScan({ findings: [] }) }
    })
    await page.getByRole('button', { name: /closes by itself/i }).click()
    await expect(page.getByText(/mods folder looks healthy/i)).toBeVisible()
    await shoot(page, SLUG, 'check-up-all-clear')

    // 8. About
    await page.getByRole('button', { name: 'About' }).click()
    await expect(page.getByText('Built by Tyler, for Lila.')).toBeVisible()
    await expect(
      page.getByText(
        'Independent helper tool for The Sims 4. Not affiliated with or endorsed by Electronic Arts or Maxis.'
      )
    ).toBeVisible()
    await shoot(page, SLUG, 'about')

    expect(running.consoleErrors).toEqual([])
  } finally {
    await running.close()
  }
})
