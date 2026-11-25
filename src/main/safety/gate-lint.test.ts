// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(THIS_DIR, '../..')

// Read-only fs functions allowed outside gate.ts and fs-read.ts (contracts.md, section 1).
const ALLOWED_FS_NAMES = new Set(['readdir', 'readFile', 'realpath', 'stat', 'lstat', 'readlink', 'statfs'])
const FS_READ_EXTRA_NAMES = new Set(['open', 'createReadStream'])
const FS_MODULE = /^(node:)?fs(\/promises)?$/
const CHILD_PROCESS_MODULE = /^(node:)?child_process$/
const FORBIDDEN_FS_PACKAGES = new Set(['fs-extra', 'graceful-fs', 'rimraf', 'mkdirp', 'mv', 'trash', 'del'])

const ELECTRON_ALLOWED_FILES = new Set([
  'main/index.ts',
  'main/app-host.ts',
  'main/ipc.ts',
  'preload/index.ts'
])

export interface ModuleUse {
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

/** Returns why a file under src/ may not load a module this way, or undefined when it may. */
export function moduleUseProblem(relFile: string, use: ModuleUse): string | undefined {
  const file = relFile.replaceAll('\\', '/')

  if (CHILD_PROCESS_MODULE.test(use.specifier)) {
    return `${file} may not load ${use.specifier} (stays in src/main/locate/host.ts)`
  }

  if (FORBIDDEN_FS_PACKAGES.has(use.specifier)) {
    return `${file} may not load ${use.specifier}`
  }

  if (use.specifier === 'electron' && !ELECTRON_ALLOWED_FILES.has(file)) {
    return `${file} may not load electron`
  }

  if (FS_MODULE.test(use.specifier)) {
    if (file === 'main/safety/gate.ts') return undefined

    const named = use.clause?.match(/^(?:type\s+)?\{([^}]*)\}$/)
    if (!named) return `${file} must load ${use.specifier} with named imports only`

    for (const part of named[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')
      if (name === '') continue
      if (ALLOWED_FS_NAMES.has(name)) continue
      if (file === 'main/fs-read.ts' && FS_READ_EXTRA_NAMES.has(name)) continue
      return `${file} imports forbidden fs function ${name}`
    }
    return undefined
  }

  return undefined
}

async function collectCheckedFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(SRC_ROOT, full).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (rel === 'main/locate' || rel === 'shared/testing' || rel === 'renderer/testing') {
        continue
      }
      found.push(...(await collectCheckedFiles(full)))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    if (rel === 'renderer/test-setup.ts') continue
    found.push(rel)
  }
  return found.sort()
}

describe('read and write gate lint', () => {
  it('shipped files under src/ obey the read and write rule', async () => {
    const files = await collectCheckedFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(0)

    for (const rel of files) {
      const source = await readFile(join(SRC_ROOT, rel), 'utf8')
      for (const use of findModuleUses(source)) {
        expect(moduleUseProblem(rel, use), `${rel}: ${use.specifier}`).toBeUndefined()
      }
      expect(source, `${rel} reaches a built-in module without an import`).not.toMatch(
        /process\.binding|getBuiltinModule|\beval\s*\(|new\s+Function\s*\(/
      )
    }
  })

  it('refuses write imports, re-exports, whole-module fs imports, child_process and stray electron', () => {
    const problem = (file: string, line: string): string | undefined => {
      const uses = findModuleUses(line)
      expect(uses, line).toHaveLength(1)
      return moduleUseProblem(file, uses[0]!)
    }

    expect(problem('main/inventory/index.ts', "import { readdir, stat, lstat, readlink, statfs } from 'node:fs/promises'")).toBeUndefined()
    expect(problem('main/fs-read.ts', "import { open } from 'node:fs/promises'")).toBeUndefined()
    expect(problem('main/fs-read.ts', "import { createReadStream } from 'node:fs'")).toBeUndefined()
    expect(problem('main/safety/gate.ts', "import { writeFile, rename, rm } from 'node:fs/promises'")).toBeUndefined()
    expect(problem('main/index.ts', "import { app, BrowserWindow } from 'electron'")).toBeUndefined()

    for (const line of [
      "import { writeFile } from 'node:fs/promises'",
      "import { lutimes } from 'node:fs/promises'",
      "import { stat, rm as remove } from 'fs'",
      "import { open } from 'node:fs/promises'",
      "import { createReadStream } from 'node:fs'",
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
      "import 'node:fs'"
    ]) {
      expect(problem('main/inventory/index.ts', line), line).toBeTypeOf('string')
    }
  })
})
