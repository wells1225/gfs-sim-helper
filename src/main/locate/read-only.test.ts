// @vitest-environment node
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateFixture, loadSpec } from '../../../scripts/fixtures/make-fixture.ts'
import { createFixtureHost } from './fixture-host.ts'
import { locate } from './index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = join(THIS_DIR, '../../../scripts/fixtures/specs')

// Every fs function locate may use. All of them only read.
const ALLOWED_FS_NAMES = new Set(['readdir', 'readFile', 'realpath', 'stat'])
const FS_MODULE = /^(node:)?fs(\/promises)?$/
// Modules a locate file may load, and which files may load the ones that can change the PC.
const ALLOWED_MODULES: Record<string, 'any' | readonly string[]> = {
  'node:path': 'any',
  'node:os': 'any',
  'node:util': 'any',
  'node:child_process': ['host.ts'],
  electron: ['host.ts'],
  '../../shared/model.ts': 'any'
}

interface ModuleUse {
  specifier: string
  /** The text between `import`/`export` and `from`, or undefined for import(), require() and bare imports. */
  clause: string | undefined
}

export function findModuleUses(source: string): ModuleUse[] {
  const uses: ModuleUse[] = []
  for (const match of source.matchAll(/\b(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    uses.push({ specifier: match[2]!, clause: `${match[0].startsWith('export') ? 'export ' : ''}${match[1]!}` })
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) {
    uses.push({ specifier: match[1]!, clause: undefined })
  }
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    uses.push({ specifier: match[1]!, clause: undefined })
  }
  return uses
}

/** Returns why a locate file may not load a module this way, or undefined when it may. */
export function moduleUseProblem(file: string, use: ModuleUse): string | undefined {
  if (FS_MODULE.test(use.specifier)) {
    const named = use.clause?.match(/^(?:type\s+)?\{([^}]*)\}$/)
    if (!named) return `${file} must load ${use.specifier} with named imports only`
    for (const part of named[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')
      if (name !== '' && !ALLOWED_FS_NAMES.has(name)) return `${file} imports fs function ${name}`
    }
    return undefined
  }
  if (/^\.\/[^/]+\.ts$/.test(use.specifier)) return undefined
  const allowed = ALLOWED_MODULES[use.specifier]
  if (allowed === 'any' || allowed?.includes(file)) return undefined
  return `${file} may not load ${use.specifier}`
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  async function walk(dir: string, rel: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        snapshot.set(relPath, `link ${await readlink(full)}`)
      } else if (info.isDirectory()) {
        snapshot.set(relPath, `dir ${info.mtimeMs}`)
        await walk(full, relPath)
      } else {
        const hash = createHash('sha256')
          .update(await readFile(full))
          .digest('hex')
        snapshot.set(relPath, `file ${info.size} ${info.mtimeMs} ${hash}`)
      }
    }
  }
  await walk(root, '')
  return snapshot
}

describe('locate is read-only', () => {
  it('shipped locate files load only allowed modules and only fs functions that read', async () => {
    const files = (await readdir(THIS_DIR)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    // Every shipped file sits directly in this folder, so the list above is all of them.
    const subfolders = (await readdir(THIS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory())
    expect(subfolders.map((e) => e.name)).toEqual([])

    for (const file of files) {
      const source = await readFile(join(THIS_DIR, file), 'utf8')
      for (const use of findModuleUses(source)) {
        expect(moduleUseProblem(file, use), `${file}: ${use.specifier}`).toBeUndefined()
      }
      // Hidden ways to reach fs or run commands without an import.
      expect(source, `${file} reaches a built-in module without an import`).not.toMatch(
        /process\.binding|getBuiltinModule|\beval\s*\(|new\s+Function\s*\(/
      )
    }
  })

  it('the guard refuses write functions, re-exports, whole-module fs imports and stray command runners', () => {
    const problem = (file: string, line: string): string | undefined => {
      const uses = findModuleUses(line)
      expect(uses, line).toHaveLength(1)
      return moduleUseProblem(file, uses[0]!)
    }
    expect(problem('process.ts', "import { readdir, stat } from 'node:fs/promises'")).toBeUndefined()
    expect(problem('process.ts', "import type { Host } from './host.ts'")).toBeUndefined()
    expect(problem('host.ts', "import { execFile } from 'node:child_process'")).toBeUndefined()

    for (const line of [
      "import { writeFile } from 'node:fs/promises'",
      "import { lutimes } from 'node:fs/promises'",
      "import { stat, rm as remove } from 'fs'",
      "export { writeFile } from 'node:fs/promises'",
      "export * from 'node:fs'",
      "import * as fs from 'node:fs'",
      "import fs from 'fs'",
      "const fs = await import('node:fs/promises')",
      "const fs = require('fs')",
      "import { execFile } from 'node:child_process'",
      "import { execSync } from 'child_process'",
      "import { shell } from 'electron'",
      "import { remove } from 'fs-extra'",
      "import { helper } from '../backup/write.ts'",
      "import 'node:fs'"
    ]) {
      expect(problem('process.ts', line), line).toBeTypeOf('string')
    }
  })

  it('leaves every file, folder and date in a Sims folder tree exactly as it was', async () => {
    const workDir = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-read-only-test-')))
    try {
      for (const name of ['onedrive', 'exceptions']) {
        const root = join(workDir, name)
        await generateFixture(await loadSpec(join(SPECS_DIR, `${name}.json`)), root)
        const before = await snapshotTree(root)
        expect(before.size).toBeGreaterThan(20)

        const result = await locate(createFixtureHost(root))
        expect(result.userFolders.length).toBeGreaterThan(0)
        expect(result.gameInstall).not.toBeNull()

        expect(await snapshotTree(root), name).toEqual(before)
      }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
