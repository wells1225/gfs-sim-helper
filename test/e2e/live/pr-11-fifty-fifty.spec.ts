import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { writeDbpf } from '../../../scripts/fixtures/dbpf.ts'
import { CACHE_NAMES } from '../../../src/main/ports.ts'
import { launchApp } from '../support/app.ts'

interface FileSnapshot {
  relPath: string
  bytes: number
  sha256: string
}

interface TreeSnapshot {
  dirs: string[]
  files: FileSnapshot[]
}

const MOD_COUNT = 64
const BAD_MOD = 'Mod_42'
/** One control round with every group set aside, then 64 → 32 → 16 → 8 → 4 → 2 → 1. */
const EXPECTED_ANSWERS = 7
/** Older than the fixture's thumbnail cache (2026-11-20), so no stale-cache finding fires. */
const MOD_TIME = new Date('2026-11-15T12:00:00.000Z')

/** The top-level names `clearCaches` removes. Clearing them cannot be undone, so the byte check leaves them out. */
const CLEARED = new Set(CACHE_NAMES.map((name) => name.replace(/\/$/, '').toLowerCase()))

function isCleared(relPath: string): boolean {
  const top = relPath.split('/')[0]!
  return CLEARED.has(top.toLowerCase())
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

/** The tree without the caches `beginRound` clears on purpose. Everything else must come back byte for byte. */
function withoutCaches(tree: TreeSnapshot): TreeSnapshot {
  return {
    dirs: tree.dirs.filter((d) => !isCleared(d)),
    files: tree.files.filter((f) => !isCleared(f.relPath))
  }
}

/** The part of the tree her saves, households, mods and settings live in. */
function herFiles(tree: TreeSnapshot): TreeSnapshot {
  const hers = (rel: string) => rel === 'Options.ini' || /^(Mods|saves|Tray)(\/|$)/.test(rel)
  return { dirs: tree.dirs.filter(hers), files: tree.files.filter((f) => hers(f.relPath)) }
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

function modName(i: number): string {
  return `Mod_${String(i).padStart(2, '0')}`
}

/**
 * Replaces `clean`'s sample mods with 64 top-level folders, one valid package each, so the inventory makes exactly
 * 64 folder groups. Every package has its own resource key, so the bytes differ and no duplicate finding fires.
 */
async function makeSixtyFourMods(simsDir: string): Promise<void> {
  const modsDir = join(simsDir, 'Mods')
  for (const entry of await readdir(modsDir, { withFileTypes: true })) {
    if (entry.name === 'Resource.cfg') continue
    await rm(join(modsDir, entry.name), { recursive: true, force: true })
  }
  for (let i = 1; i <= MOD_COUNT; i += 1) {
    const name = modName(i)
    const folder = join(modsDir, name)
    await mkdir(folder)
    const file = join(folder, `${name}.package`)
    const data = writeDbpf({
      keys: [{ type: 0x319e4f1d, group: 0, instance: 0x0001_0000_0000_0000n + BigInt(i) }],
      seed: 5000 + i
    })
    await writeFile(file, data)
    await utimes(file, MOD_TIME, MOD_TIME)
  }
}

async function runCheckUp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Welcome to Sims Helper' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: "Let's take a look" }).click()
  await expect(page.getByRole('heading', { name: 'What happened?' })).toBeVisible()
  await page.getByRole('button', { name: /just check everything/i }).click()
  // 64 valid, distinct packages and no crash logs: the check-up finds nothing, so no fix can touch the folder.
  await expect(page.getByRole('heading', { name: /Your mods folder looks healthy/ })).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText('64 mod files checked')).toBeVisible()
}

test.describe('live 50/50 test on Windows', () => {
  test.skip(process.platform !== 'win32', 'Live write-gate 50/50 tests run on Windows')

  test('live: 64 mod groups, the bad one is named in 7 answers, and put-back restores the tree byte for byte', async () => {
    test.setTimeout(180_000)
    const running = await launchApp({ fixture: 'clean' })
    try {
      const simsDir = await findSimsFolder(running.fixtureRoot!)
      await makeSixtyFourMods(simsDir)
      const badFile = join(simsDir, 'Mods', BAD_MOD, `${BAD_MOD}.package`)

      const fullBefore = await snapshotTree(simsDir)
      const before = withoutCaches(fullBefore)
      // The cache filter must never hide any of her files: they are all in the byte-for-byte check.
      const hersBefore = herFiles(fullBefore)
      expect(herFiles(before)).toEqual(hersBefore)
      expect(hersBefore.files.filter((f) => f.relPath.startsWith('Mods/') && f.relPath.endsWith('.package'))).toHaveLength(
        MOD_COUNT
      )
      expect(hersBefore.files.some((f) => f.relPath === 'Options.ini')).toBe(true)
      expect(hersBefore.files.some((f) => f.relPath.startsWith('saves/'))).toBe(true)
      expect(hersBefore.files.some((f) => f.relPath.startsWith('Tray/'))).toBe(true)

      const { page } = running
      await runCheckUp(page)
      await page.locator('main').getByRole('button', { name: /Try the 50\/50 test|Find it with the 50\/50 test/ }).click()

      // The intro counts the groups the scan made: this is the proof there are exactly 64.
      await expect(page.getByText(/You have 64 mod groups, so this takes about 7 rounds\./)).toBeVisible()
      await page.getByRole('button', { name: 'Start the 50/50 test' }).click()
      await expect(page.getByRole('heading', { name: 'First, close CurseForge' })).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: 'CurseForge is closed' }).click()

      const tested = page.getByRole('button', { name: "I've tested it" })
      const found = page.getByRole('heading', { name: 'We found the most likely cause' })
      // The screen's own notice (a refusal, a half-done move) sits directly in <main>, above the step card.
      const notice = page.locator('main > [role="alert"]')
      const answers: ('crashed' | 'worked')[] = []

      for (let guard = 0; guard <= EXPECTED_ANSWERS; guard += 1) {
        await expect(tested.or(found).or(notice).first()).toBeVisible({ timeout: 30_000 })
        if (await found.isVisible()) break
        if (!(await tested.isVisible())) {
          throw new Error(`The 50/50 test stopped with a notice: ${await notice.first().innerText()}`)
        }
        if (answers.length >= EXPECTED_ANSWERS) {
          throw new Error(`Still testing after ${answers.length} answers`)
        }

        const crashed = existsSync(badFile)
        await tested.click()
        await page.getByRole('button', { name: crashed ? 'It still crashed' : 'No crash, it worked!' }).click()
        answers.push(crashed ? 'crashed' : 'worked')
      }

      await expect(found).toBeVisible({ timeout: 30_000 })
      expect(answers).toHaveLength(EXPECTED_ANSWERS)
      // The control round runs with every mod set aside, so the game "worked"; the splits need both answers.
      expect(answers[0]).toBe('worked')
      expect(answers.slice(1)).toContain('crashed')
      expect(answers.slice(1)).toContain('worked')

      await expect(page.locator('main').getByText(BAD_MOD, { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: `Keep ${BAD_MOD} set aside` })).toBeVisible()
      // When found, only the culprit is set aside, so she can play right away.
      expect(existsSync(badFile)).toBe(false)

      await page.getByRole('button', { name: 'Put everything back' }).click()
      await expect(page.getByRole('heading', { name: 'All done' })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('All your mods are back in place.')).toBeVisible({ timeout: 15_000 })

      const fullAfter = await snapshotTree(simsDir)
      expect(withoutCaches(fullAfter)).toEqual(before)
      expect(herFiles(fullAfter)).toEqual(hersBefore)
      expect(running.consoleErrors).toEqual([])
    } finally {
      await running.close()
    }
  })
})
