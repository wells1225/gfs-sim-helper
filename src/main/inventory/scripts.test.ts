// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { listScriptEntries } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(THIS_DIR, '../../..')
const SPECS_DIR = join(REPO_ROOT, 'scripts/fixtures/specs')
const EXCEPTIONS_MODS = join(
  REPO_ROOT,
  'test/fixtures/exceptions/Users/Player/Documents/Electronic Arts/The Sims 4/Mods'
)

describe('listScriptEntries', () => {
  it('lists the exact entries of every .ts4script in the exceptions fixture', async () => {
    const spec = await loadSpec(join(SPECS_DIR, 'exceptions.json'))
    const scripts = spec.userFolders[0]?.scripts ?? []
    expect(scripts.length).toBe(2)

    for (const script of scripts) {
      const result = await listScriptEntries(join(EXCEPTIONS_MODS, script.relPath))
      expect(result, script.relPath).toEqual({
        status: 'ok',
        entries: script.entries
      })
    }
  })

  it('reports a cut zip as broken', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-scripts-test-'))
    try {
      const validBytes = await readFile(join(EXCEPTIONS_MODS, 'MCCC/mc_cmd_center.ts4script'))
      const cutPath = join(dir, 'cut.ts4script')
      await writeFile(cutPath, validBytes.subarray(0, Math.floor(validBytes.length / 2)))

      const cutResult = await listScriptEntries(cutPath)
      expect(cutResult.status).toBe('broken')

      const garbagePath = join(dir, 'not-a-zip.ts4script')
      await writeFile(garbagePath, Buffer.from('not a zip file at all'))
      const garbageResult = await listScriptEntries(garbagePath)
      expect(garbageResult.status).toBe('broken')

      const emptyPath = join(dir, 'empty.ts4script')
      await writeFile(emptyPath, Buffer.alloc(0))
      const emptyResult = await listScriptEntries(emptyPath)
      expect(emptyResult.status).toBe('broken')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns unreadable when the script file cannot be opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sims-scripts-missing-'))
    try {
      const result = await listScriptEntries(join(dir, 'missing.ts4script'))
      expect(result.status).toBe('unreadable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
