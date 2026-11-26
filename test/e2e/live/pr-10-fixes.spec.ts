import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from '../support/app.ts'

const execFileAsync = promisify(execFile)

interface FileSnapshot {
  relPath: string
  bytes: number
  sha256: string
}

interface TreeSnapshot {
  dirs: string[]
  files: FileSnapshot[]
}

async function snapshotTree(rootDir: string): Promise<TreeSnapshot> {
  const dirs: string[] = []
  const files: FileSnapshot[] = []

  async function walk(current: string, relPrefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        dirs.push(rel)
        await walk(full, rel)
      } else if (entry.isFile()) {
        const data = await readFile(full)
        files.push({
          relPath: rel,
          bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex')
        })
      }
    }
  }

  await walk(rootDir, '')
  dirs.sort()
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { dirs, files }
}

async function findSimsFolder(fixtureRoot: string): Promise<string> {
  const eaDir = join(fixtureRoot, 'Users', 'Player', 'Documents', 'Electronic Arts')
  const entries = await readdir(eaDir, { withFileTypes: true })
  const folder = entries.find((entry) => entry.isDirectory())
  if (!folder) {
    throw new Error(`No Sims 4 folder found under ${eaDir}`)
  }
  return join(eaDir, folder.name)
}

async function runCheckUp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Welcome to Sims Helper' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: "Let's take a look" }).click()
  await expect(page.getByRole('heading', { name: 'What happened?' })).toBeVisible()
  await page.getByRole('button', { name: /just check everything/i }).click()
  await expect(page.locator('main section').first()).toBeVisible({ timeout: 25_000 })
}

async function undoAllInHistory(page: Page, expectedCount: number): Promise<void> {
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible()

  const mainUndoButtons = page.locator('main').getByRole('button', { name: 'Undo' })
  await expect(mainUndoButtons).toHaveCount(expectedCount, { timeout: 15_000 })

  for (let remaining = expectedCount; remaining > 0; remaining -= 1) {
    await mainUndoButtons.first().click()
    await expect(mainUndoButtons).toHaveCount(remaining - 1, { timeout: 30_000 })
  }

  await expect(page.locator('main').getByText('Undone', { exact: true })).toHaveCount(expectedCount)
}

async function waitForDummyProcessInTasklist(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (proc.pid === undefined) {
    throw new Error('Dummy TS4_x64.exe spawned without a PID')
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Dummy TS4_x64.exe exited early with code ${proc.exitCode}`)
    }
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/fi', `PID eq ${proc.pid}`, '/fo', 'csv', '/nh'],
      { windowsHide: true }
    )
    if (stdout.toLowerCase().includes('"ts4_x64.exe"')) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Timed out waiting for dummy TS4_x64.exe to appear in tasklist')
}

test.describe('live fixes with undo on Windows', () => {
  test.skip(process.platform !== 'win32', 'Live write-gate fix tests run on Windows')

  test('live: patch-day turn mods back on and undo restores tree byte for byte', async () => {
    test.setTimeout(90_000)
    const running = await launchApp({ fixture: 'patch-day' })
    try {
      const simsDir = await findSimsFolder(running.fixtureRoot!)
      const before = await snapshotTree(simsDir)

      await runCheckUp(running.page)

      await running.page.getByRole('button', { name: 'Turn mods back on' }).click()
      await expect(
        running.page.locator('main').getByText('Turned mods and script mods back on', { exact: true })
      ).toBeVisible({ timeout: 30_000 })

      const editedIni = await readFile(join(simsDir, 'Options.ini'), 'utf8')
      expect(editedIni).toContain('modsdisabled=0')
      expect(editedIni).toContain('scriptmodsenabled=1')
      expect(await snapshotTree(simsDir)).not.toEqual(before)

      await undoAllInHistory(running.page, 1)

      expect(await snapshotTree(simsDir)).toEqual(before)
      expect(running.consoleErrors).toEqual([])
    } finally {
      await running.close()
    }
  })

  test('live: nested-scripts move script up and undo restores tree byte for byte', async () => {
    test.setTimeout(90_000)
    const running = await launchApp({ fixture: 'nested-scripts' })
    try {
      const simsDir = await findSimsFolder(running.fixtureRoot!)
      const before = await snapshotTree(simsDir)

      await runCheckUp(running.page)

      await running.page.getByRole('button', { name: 'Move it up a folder' }).click()
      await expect(
        running.page.locator('main').getByText('Moved 2 script mods up a folder', { exact: true })
      ).toBeVisible({ timeout: 30_000 })

      const afterFix = await snapshotTree(simsDir)
      const relPaths = afterFix.files.map((f) => f.relPath)
      expect(relPaths).toContain('Mods/Gameplay/deep_mod.ts4script')
      expect(relPaths).toContain('Mods/ScriptMods/cool_mod.ts4script')
      expect(relPaths).not.toContain('Mods/Gameplay/Tweaks/DeepMod/deep_mod.ts4script')
      expect(relPaths).not.toContain('Mods/ScriptMods/CoolMod/cool_mod.ts4script')

      await undoAllInHistory(running.page, 1)

      expect(await snapshotTree(simsDir)).toEqual(before)
      expect(running.consoleErrors).toEqual([])
    } finally {
      await running.close()
    }
  })

  test('live: broken-packages set aside and undo restores tree byte for byte', async () => {
    test.setTimeout(90_000)
    const running = await launchApp({ fixture: 'broken-packages' })
    try {
      const simsDir = await findSimsFolder(running.fixtureRoot!)
      const before = await snapshotTree(simsDir)

      await runCheckUp(running.page)

      const setAsideButtons = running.page.locator('main').getByRole('button', { name: 'Set aside' })
      const doneUndoButtons = running.page.locator('main').getByRole('button', { name: 'Undo' })
      await expect(setAsideButtons).toHaveCount(3)

      for (let completed = 1; completed <= 3; completed += 1) {
        await setAsideButtons.first().click()
        await expect(doneUndoButtons).toHaveCount(completed, { timeout: 30_000 })
      }
      await expect(
        running.page.locator('main').getByText('Set aside 2 zipped files from Mods', { exact: true })
      ).toBeVisible()
      await expect(
        running.page.locator('main').getByText('Set aside 3 broken files from Mods', { exact: true })
      ).toBeVisible()
      await expect(
        running.page.locator('main').getByText('Set aside 1 wrong-game package from Mods', { exact: true })
      ).toBeVisible()

      const afterFix = await snapshotTree(simsDir)
      const relPaths = afterFix.files.map((f) => f.relPath)
      expect(relPaths).toContain('Mods/good_plain.package')
      expect(relPaths).toContain('Mods/good_constant_flags.package')
      expect(relPaths).toContain('Mods/good_constant_instance_high.package')
      expect(relPaths).not.toContain('Mods/Unextracted_CC_Bundle.zip')
      expect(relPaths).not.toContain('Mods/Downloads/ZippedScriptMod.zip')
      expect(relPaths).not.toContain('Mods/corrupt_bad_magic.package')
      expect(relPaths).not.toContain('Mods/corrupt_short_header.package')
      expect(relPaths).not.toContain('Mods/corrupt_truncated_index.package')
      expect(relPaths).not.toContain('Mods/wrong_game_sims3.package')

      await undoAllInHistory(running.page, 3)

      expect(await snapshotTree(simsDir)).toEqual(before)
      expect(running.consoleErrors).toEqual([])
    } finally {
      await running.close()
    }
  })

  test('live: duplicates set aside and undo restores tree byte for byte', async () => {
    test.setTimeout(90_000)
    const running = await launchApp({ fixture: 'duplicates' })
    try {
      const simsDir = await findSimsFolder(running.fixtureRoot!)
      const before = await snapshotTree(simsDir)

      await runCheckUp(running.page)

      await running.page.locator('main').getByRole('button', { name: 'Set aside' }).click()
      await expect(
        running.page.locator('main').getByText('Set aside 2 files from Mods', { exact: true })
      ).toBeVisible({ timeout: 30_000 })

      const afterFix = await snapshotTree(simsDir)
      const relPaths = afterFix.files.map((f) => f.relPath)
      expect(relPaths).toContain('Mods/CurseForge/sample_hair_01.package')
      expect(relPaths).toContain('Mods/HelperMod/helper_mod.ts4script')
      expect(relPaths).not.toContain('Mods/CAS/Hair/sample_hair_01.package')
      expect(relPaths).not.toContain('Mods/BackupCopy/helper_mod.ts4script')

      await undoAllInHistory(running.page, 1)

      expect(await snapshotTree(simsDir)).toEqual(before)
      expect(running.consoleErrors).toEqual([])
    } finally {
      await running.close()
    }
  })

  test('live: dummy TS4_x64.exe refuses fix with nothing changed', async () => {
    test.setTimeout(90_000)
    const dummyDir = await mkdtemp(join(tmpdir(), 'sims-helper-dummy-ts4-'))
    const fakeExe = join(dummyDir, 'TS4_x64.exe')
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
    let proc: ChildProcess | null = null

    try {
      await copyFile(join(systemRoot, 'System32', 'cmd.exe'), fakeExe)
      proc = spawn(fakeExe, ['/c', 'ping', '-n', '300', '127.0.0.1'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      await waitForDummyProcessInTasklist(proc)

      const running = await launchApp({ fixture: 'patch-day' })
      try {
        const simsDir = await findSimsFolder(running.fixtureRoot!)
        const before = await snapshotTree(simsDir)

        await runCheckUp(running.page)
        await expect(
          running.page.getByText('The Sims 4 is open right now. Looking is completely safe.')
        ).toBeVisible()

        await running.page.getByRole('button', { name: 'Turn mods back on' }).click()
        await expect(
          running.page.getByText('The Sims 4 is still open. Save and close the game, then try again.')
        ).toBeVisible({ timeout: 20_000 })

        expect(await snapshotTree(simsDir)).toEqual(before)
        expect(running.consoleErrors).toEqual([])
      } finally {
        await running.close()
      }
    } finally {
      if (proc && proc.pid !== undefined && proc.exitCode === null) {
        await execFileAsync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }).catch(() => {})
      }
      await rm(dummyDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
