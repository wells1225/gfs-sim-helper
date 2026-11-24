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

/** Red step only: the first version's checks behind the new entry point. */
export function sourceProblems(relFile: string, source: string, _files: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const use of findModuleUses(source)) {
    const problem = moduleUseProblem(relFile, use)
    if (problem !== undefined) problems.push(problem)
  }
  if (/process\.binding|getBuiltinModule|\beval\s*\(|new\s+Function\s*\(/.test(source)) {
    problems.push(`${relFile} reaches a built-in module without an import`)
  }
  return problems
}

export function gateExportProblems(_source: string): string[] {
  return []
}

export async function lintTree(srcRoot: string): Promise<string[]> {
  const problems: string[] = []
  const files = await collectCheckedFilesUnder(srcRoot)
  const known = new Set(files)
  for (const rel of files) {
    problems.push(...sourceProblems(rel, await readFile(join(srcRoot, rel), 'utf8'), known))
  }
  return problems
}

async function collectCheckedFilesUnder(_srcRoot: string): Promise<string[]> {
  return await collectCheckedFiles(SRC_ROOT)
}

// A small made-up tree for the cases below.
const SAMPLE_FILES: ReadonlySet<string> = new Set([
  'main/index.ts',
  'main/app-host.ts',
  'main/ports.ts',
  'main/fs-read.ts',
  'main/inventory/index.ts',
  'main/inventory/index.test.ts',
  'main/scan/index.ts',
  'main/assist/index.ts',
  'main/assist/key-store.ts',
  'main/locate/host.ts',
  'main/safety/gate.ts',
  'shared/model.ts',
  'renderer/App.tsx',
  'renderer/About.tsx',
  'renderer/styles.css',
  'renderer/lib/utils.ts',
  'renderer/test-setup.ts'
])

describe('read and write gate lint', () => {
  it('shipped files under src/ obey the read and write rule', async () => {
    expect(await lintTree(SRC_ROOT)).toEqual([])
  })

  it('gate.ts exports runGate, the pure path check and types, and nothing else', async () => {
    expect(gateExportProblems(await readFile(join(SRC_ROOT, 'main/safety/gate.ts'), 'utf8'))).toEqual([])
    for (const line of [
      "export { writeFile } from 'node:fs/promises'",
      "export * from 'node:fs'",
      'export const save = writeFile',
      'export async function writeAnything(file: string): Promise<void> {}',
      'export default runGate',
      'const a = 1; export { rename }'
    ]) {
      expect(gateExportProblems(`export async function runGate() {}\n${line}\n`), line).not.toEqual([])
    }
    expect(
      gateExportProblems(
        'export interface GateRoots {}\nexport type Zone = string\nexport function sortPath() {}\nexport async function runGate() {}\n'
      )
    ).toEqual([])
  })

  it('allows what a shipped file may load', () => {
    const allowed: [string, string][] = [
      ['main/inventory/index.ts', "import { readdir, readFile, realpath, stat, lstat, readlink, statfs } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "import { readFile as read } from 'fs'"],
      ['main/inventory/index.ts', "import { join } from 'node:path'"],
      ['main/inventory/index.ts', "import { createHash } from 'node:crypto'"],
      ['main/inventory/index.ts', "import { unzipSync } from 'fflate'"],
      ['main/inventory/index.ts', "import type { Scan } from '../../shared/model.ts'"],
      ['main/inventory/index.ts', "import { sha256File } from '../fs-read.ts'"],
      ['main/inventory/index.ts', "export { readDbpfIndex } from './index.ts'"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'"],
      ['main/fs-read.ts', "import { createReadStream } from 'node:fs'"],
      ['main/safety/gate.ts', "import { mkdir, open, rename, rm, unlink, utimes } from 'node:fs/promises'"],
      ['main/safety/gate.ts', "import { sha256File } from '../fs-read.ts'"],
      ['main/index.ts', "import { app, BrowserWindow } from 'electron'"],
      ['main/locate/host.ts', "import { execFile } from 'node:child_process'"],
      ['main/locate/host.ts', "const { app } = await import('electron')"],
      ['main/assist/key-store.ts', "import Anthropic from '@anthropic-ai/sdk'"],
      ['main/ports.ts', "buildInventory: typeof import('./inventory/index.ts').buildInventory"],
      ['renderer/App.tsx', "import { useState } from 'react'"],
      ['renderer/App.tsx', "import { createRoot } from 'react-dom/client'"],
      ['renderer/App.tsx', "import { cn } from '@/lib/utils'"],
      ['renderer/App.tsx', "import { About } from './About'"],
      ['renderer/App.tsx', "import './styles.css'"],
      ['renderer/App.tsx', "import '@fontsource-variable/plus-jakarta-sans'"]
    ]
    for (const [file, line] of allowed) {
      expect(sourceProblems(file, line, SAMPLE_FILES), `${file}: ${line}`).toEqual([])
    }
  })

  it('refuses every way to reach a write from a shipped file', () => {
    const refused: [string, string][] = [
      // named, renamed, whole-module and bare imports
      ['main/inventory/index.ts', "import { writeFile } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "import{writeFile}from'node:fs/promises'"],
      ['main/inventory/index.ts', "import { lutimes } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "import { stat, rm as remove } from 'fs'"],
      ['main/inventory/index.ts', "import { readFile, writeFile as readText } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "import { promises } from 'node:fs'"],
      ['main/inventory/index.ts', "import { constants } from 'node:fs'"],
      ['main/inventory/index.ts', "import { type as readFile } from 'node:fs'"],
      ['main/inventory/index.ts', "import type, { writeFile } from 'node:fs'"],
      ['main/inventory/index.ts', "import * as fs from 'node:fs'"],
      ['main/inventory/index.ts', "import fs from 'fs'"],
      ['main/inventory/index.ts', "import fs, { readFile } from 'node:fs'"],
      ['main/inventory/index.ts', "import 'node:fs'"],
      ['main/inventory/index.ts', "import /* ' */ { writeFile } /* ' */ from 'node:fs/promises'"],
      // open and createReadStream belong to fs-read.ts alone
      ['main/inventory/index.ts', "import { open } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "import { createReadStream } from 'node:fs'"],
      ['main/fs-read.ts', "import { createWriteStream } from 'node:fs'"],
      // re-exports
      ['main/inventory/index.ts', "export { writeFile } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "export * from 'node:fs'"],
      ['main/inventory/index.ts', "export * as disk from 'node:fs'"],
      // require and dynamic import
      ['main/inventory/index.ts', "const fs = require('fs')"],
      ['main/inventory/index.ts', "import fs = require('node:fs')"],
      ['main/inventory/index.ts', 'const load = require'],
      ['main/inventory/index.ts', "const fs = await import('node:fs/promises')"],
      ['main/inventory/index.ts', 'const fs = await import(name)'],
      ['main/inventory/index.ts', 'const fs = await import(`node:fs`)'],
      ['main/inventory/index.ts', "const fs = await import('node:' + 'fs')"],
      ['main/inventory/index.ts', "const name = 'node:fs'"],
      ['main/inventory/index.ts', 'const name = "child_process"'],
      // built-in modules reached without an import
      ['main/inventory/index.ts', "const fs = process.binding('fs')"],
      ['main/inventory/index.ts', "const fs = process['binding']('fs')"],
      ['main/inventory/index.ts', "const fs = process.getBuiltinModule('node:fs')"],
      ['main/inventory/index.ts', "const fs = globalThis.process['getBuiltinModule']('fs')"],
      ['main/inventory/index.ts', 'process.dlopen(module, file)'],
      ['main/inventory/index.ts', 'process.report.writeReport(file)'],
      ['main/inventory/index.ts', "eval('1')"],
      ['main/inventory/index.ts', "const run = new Function('return 1')"],
      // built-in modules that can write, load code or start a program
      ['main/inventory/index.ts', "import { createRequire } from 'node:module'"],
      ['main/inventory/index.ts', "import { Worker } from 'node:worker_threads'"],
      ['main/inventory/index.ts', "import vm from 'node:vm'"],
      ['main/inventory/index.ts', "import { writeHeapSnapshot } from 'node:v8'"],
      ['main/inventory/index.ts', "import { DatabaseSync } from 'node:sqlite'"],
      ['main/inventory/index.ts', "import { execFile } from 'node:child_process'"],
      ['main/inventory/index.ts', "import { execSync } from 'child_process'"],
      ['main/app-host.ts', "import { spawn } from 'node:child_process'"],
      ['main/safety/gate.ts', "import { execFile } from 'node:child_process'"],
      // packages that write
      ['main/inventory/index.ts', "import { remove } from 'fs-extra'"],
      ['main/inventory/index.ts', "import { outputFile } from 'fs-extra/esm'"],
      ['main/inventory/index.ts', "import { writeFile } from 'original-fs'"],
      ['main/inventory/index.ts', "import writeFileAtomic from 'write-file-atomic'"],
      ['main/inventory/index.ts', "import { rimraf } from 'rimraf'"],
      ['main/inventory/index.ts', "import trash from 'trash'"],
      ['main/inventory/index.ts', "import { execa } from 'execa'"],
      ['main/inventory/index.ts', "import { something } from 'a-package-nobody-listed'"],
      // electron and the AI package stay in their own files
      ['main/scan/index.ts', "import { shell } from 'electron'"],
      ['main/assist/index.ts', "import Anthropic from '@anthropic-ai/sdk'"],
      // a relative import may not leave src/, reach a test file, or point at nothing
      ['main/inventory/index.ts', "import { generateFixture } from '../../../scripts/fixtures/make-fixture.ts'"],
      ['main/inventory/index.ts', "import { helper } from './index.test.ts'"],
      ['renderer/App.tsx', "import '../renderer/test-setup.ts'"],
      ['main/inventory/index.ts', "import { helper } from './missing.ts'"]
    ]
    for (const [file, line] of refused) {
      expect(sourceProblems(file, line, SAMPLE_FILES), `${file}: ${line}`).not.toEqual([])
    }
  })
})
