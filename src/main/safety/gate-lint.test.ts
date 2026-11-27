// @vitest-environment node
// The read and write rule (contracts.md, section 1): no shipped file under src/ except gate.ts can reach a write.
// An allow-list, like PR 3's guard: a module nobody listed is refused, so a new way to write fails here first.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(THIS_DIR, '../..')

const GATE = 'main/safety/gate.ts'
const FS_MODULE = /^(node:)?fs(\/promises)?$/
// The fs functions that only read. gate.ts may use any; fs-read.ts also gets the two below it.
const READ_ONLY_FS_NAMES = new Set(['readdir', 'readFile', 'realpath', 'stat', 'lstat', 'readlink', 'statfs'])
const FS_READ_EXTRA_NAMES = new Set(['open', 'createReadStream'])

// Built-in modules that cannot change the disk, load code or start a program. With or without 'node:'.
const HARMLESS_BUILTINS = new Set([
  'assert',
  'assert/strict',
  'buffer',
  'crypto',
  'events',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'util/types',
  'zlib'
])
// The bundled packages (ownership.md), and the files that may load them. A sub-path of a listed package counts.
const ALLOWED_PACKAGES: Record<string, 'any' | readonly string[]> = {
  react: 'any',
  'react-dom': 'any',
  'radix-ui': 'any',
  'class-variance-authority': 'any',
  clsx: 'any',
  'tailwind-merge': 'any',
  'lucide-react': 'any',
  sonner: 'any',
  'tw-animate-css': 'any',
  '@fontsource-variable/plus-jakarta-sans': 'any',
  fflate: 'any',
  '@anthropic-ai/sdk': ['main/assist/key-store.ts'],
  'electron-updater': ['main/update/updater.ts'],
  electron: ['main/index.ts', 'main/app-host.ts', 'main/ipc.ts', 'preload/index.ts', 'main/locate/host.ts']
}
const BUILTINS_FOR_ONE_FILE: Record<string, readonly string[]> = {
  child_process: ['main/locate/host.ts']
}

// Text that reaches a built-in module, or runs made-up code, without an import the check can read.
const FORBIDDEN_TEXT: [RegExp, string][] = [
  [/\brequire\b/, 'uses require'],
  [/\b(binding|_linkedBinding|dlopen|getBuiltinModule|createRequire|mainModule)\b/, 'reaches a built-in module without an import'],
  [/\b(writeReport|writeHeapSnapshot)\b/, 'writes a diagnostic file'],
  [/\beval\b|\bFunction\b/, 'runs made-up code'],
  [/\bimport\s*\(\s*(?!(?:'[^'`"\\]*'|"[^'`"\\]*")\s*\))/, 'loads a module whose name is not one plain string']
]
// A module name that can write, start a program or open a network socket may not appear as a string outside an import.
const DANGEROUS_NAME =
  /(['"`])(?:(?:node:)?(?:fs|fs\/promises|original-fs|child_process|module|vm|worker_threads|v8|sqlite|inspector|cluster|repl|wasi)|node:(?:net|http|https|http2|tls|dgram))\1/g

// Files under src/ that are not code and are never loaded as code.
const PLAIN_FILE = /\.(css|html|json|svg|png|ico|woff2|md|txt|snap)$/
const CODE_FILE = /\.(ts|tsx)$/
const isTestFile = (rel: string): boolean => /\.test\.tsx?$/.test(rel) || rel === 'renderer/test-setup.ts'

/** Replaces comments with spaces (preserving newlines and character offsets), while respecting strings and templates. */
function stripComments(source: string): string {
  const out: string[] = []
  let quote: "'" | '"' | null = null
  const templateDepths: number[] = []
  let braceDepth = 0
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    const inTemplateText = templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth
    if (quote !== null) {
      out.push(ch)
      if (ch === '\\' && next !== undefined) {
        out.push(next)
        i += 2
        continue
      }
      if (ch === quote || ch === '\n') quote = null
      i += 1
      continue
    }
    if (inTemplateText) {
      out.push(ch)
      if (ch === '\\' && next !== undefined) {
        out.push(next)
        i += 2
        continue
      }
      if (ch === '`') {
        templateDepths.pop()
      } else if (ch === '$' && next === '{') {
        out.push(next)
        braceDepth += 1
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      out.push(' ', ' ')
      i += 2
      while (i < source.length && source[i] !== '\n') {
        out.push(' ')
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out.push(' ', ' ')
      i += 2
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out.push(' ', ' ')
          i += 2
          break
        }
        out.push(source[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '`') {
      templateDepths.push(braceDepth)
    } else if (ch === '{') {
      braceDepth += 1
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1
    }
    out.push(ch)
    i += 1
  }
  return out.join('')
}

export interface ModuleUse {
  specifier: string
  /** The text between `import`/`export` and `from`. Undefined for import(), a bare import, or a clause the check cannot read. */
  clause: string | undefined
  /** Where the specifier's opening quote sits in the source. */
  at: number
}

export function findModuleUses(source: string): ModuleUse[] {
  const uses: ModuleUse[] = []
  const seen = new Set<number>()
  const add = (specifier: string, clause: string | undefined, at: number): void => {
    if (seen.has(at)) return
    seen.add(at)
    uses.push({ specifier, clause, at })
  }
  // import <clause> from '<x>' and export <clause> from '<x>'. The clause holds no quote and no second keyword.
  const withClause = /\b(import|export)\b\s*((?:(?!\b(?:import|export)\b)[^'"`;])*?)\s*\bfrom\s*(['"])([^'"`]*)\3/g
  for (const match of source.matchAll(withClause)) {
    const at = match.index + match[0].lastIndexOf(match[3]! + match[4]! + match[3]!)
    add(match[4]!, `${match[1] === 'export' ? 'export ' : ''}${match[2]!}`, at)
  }
  // Any other `from '<x>'`: an import whose clause the pattern above could not read (a comment with a quote in it).
  for (const match of source.matchAll(/\bfrom\s*(['"])([^'"`]*)\1/g)) {
    add(match[2]!, undefined, match.index + match[0].indexOf(match[1]!))
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*(['"])([^'"`]*)\1/g)) {
    add(match[2]!, undefined, match.index + match[0].indexOf(match[1]!))
  }
  for (const match of source.matchAll(/\bimport\s*(['"])([^'"`]*)\1/g)) {
    add(match[2]!, undefined, match.index + match[0].indexOf(match[1]!))
  }
  return uses
}

/** Where a relative or '@/' specifier points, as a path under src/. Null when it leaves src/. */
function resolveInSrc(relFile: string, specifier: string): string | null {
  const bare = specifier.replace(/[?#].*$/, '')
  const target = bare.startsWith('@/') ? posix.join('renderer', bare.slice(2)) : posix.join(posix.dirname(relFile), bare)
  return target.startsWith('..') || posix.isAbsolute(target) ? null : target
}

const NAMED_FS_ITEM = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/

/** Returns why a file under src/ may not load a module this way, or undefined when it may. */
export function moduleUseProblem(relFile: string, use: ModuleUse, files: ReadonlySet<string>): string | undefined {
  const file = relFile.replaceAll('\\', '/')
  const { specifier } = use

  if (specifier.startsWith('.') || specifier.startsWith('@/')) {
    const target = resolveInSrc(file, specifier)
    if (target === null) return `${file} loads ${specifier}, which is outside src/`
    const found = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find((name) =>
      files.has(name)
    )
    if (found === undefined) return `${file} loads ${specifier}, which is not a file under src/`
    if (isTestFile(found)) return `${file} loads the test file ${found}`
    return undefined
  }

  if (FS_MODULE.test(specifier)) {
    if (file === GATE) return undefined
    const named = use.clause?.match(/^(?:type\s+)?\{([^}]*)\}$/)
    if (!named) return `${file} must load ${specifier} with named imports only`
    for (const part of named[1]!.split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const parsed = trimmed.match(NAMED_FS_ITEM)
      if (!parsed) return `${file} has an unreadable fs import specifier: ${trimmed}`
      const name = parsed[1]!
      if (READ_ONLY_FS_NAMES.has(name)) continue
      if (file === 'main/fs-read.ts' && FS_READ_EXTRA_NAMES.has(name)) {
        if (/\bas\b/.test(trimmed)) return `${file} must not rename ${name}`
        continue
      }
      return `${file} imports the fs function ${name}, which is not on the read-only list`
    }
    return undefined
  }

  const builtin = specifier.replace(/^node:/, '')
  if (HARMLESS_BUILTINS.has(builtin)) return undefined
  if (BUILTINS_FOR_ONE_FILE[builtin]?.includes(file)) return undefined

  const packageName = Object.keys(ALLOWED_PACKAGES).find((name) => specifier === name || specifier.startsWith(`${name}/`))
  const allowed = packageName === undefined ? undefined : ALLOWED_PACKAGES[packageName]
  if (allowed === 'any' || allowed?.includes(file)) return undefined
  return `${file} may not load ${specifier}`
}

const FS_READ_WRITE_HANDLE =
  /(?:\.\s*|\[['"`])(write|writeFile|writev|appendFile|truncate|chmod|chown|utimes|datasync|sync)\b/

/** Splits the top-level comma-separated arguments of a call starting at `openParen`, or null if malformed. */
function callArgs(source: string, openParen: number): string[] | null {
  if (source[openParen] !== '(') return null
  const args: string[] = []
  let depth = 0
  let start = openParen + 1
  let quote: string | null = null
  for (let i = openParen + 1; i < source.length; i += 1) {
    const ch = source[i]!
    if (quote !== null) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth += 1
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (ch === ')' && depth === 0) {
        const tail = source.slice(start, i).trim()
        if (tail !== '' || args.length > 0) args.push(tail)
        return args
      }
      if (depth === 0) return null
      depth -= 1
    } else if (ch === ',' && depth === 0) {
      args.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  return null
}

/** fs-read.ts may import open and createReadStream only to open files read-only ('r'). */
export function fsReadProblems(source: string): string[] {
  const problems: string[] = []
  if (FS_READ_WRITE_HANDLE.test(source)) {
    problems.push('main/fs-read.ts calls a write-capable FileHandle method')
  }
  const withoutImports = source.replace(/\bimport\b\s*(?:type\s+)?\{[^}]*\}\s*from\s*(['"])[^'"`]*\1/g, (m) =>
    ' '.repeat(m.length)
  )
  for (const match of withoutImports.matchAll(/\b(open|createReadStream)\b/g)) {
    const fn = match[1]!
    const afterName = match.index + fn.length
    const ws = withoutImports.slice(afterName).match(/^\s*/)![0]!.length
    const args = callArgs(withoutImports, afterName + ws)
    if (fn === 'open') {
      if (args === null || args.length !== 2 || !/^(['"])r\1$/.test(args[1]!)) {
        problems.push("main/fs-read.ts must call open with the literal 'r' flag only")
      }
    } else {
      if (args === null || args.length !== 2 || !/^\{\s*flags\s*:\s*(['"])r\1\s*,?\s*\}$/.test(args[1]!)) {
        problems.push("main/fs-read.ts must call createReadStream with { flags: 'r' } only")
      }
    }
  }
  return problems
}

/** Every reason a shipped file breaks the read and write rule. `files` is every file under src/. */
export function sourceProblems(relFile: string, source: string, files: ReadonlySet<string>): string[] {
  const file = relFile.replaceAll('\\', '/')
  const clean = stripComments(source)
  const problems: string[] = []
  const uses = findModuleUses(clean)
  for (const use of uses) {
    const problem = moduleUseProblem(file, use, files)
    if (problem !== undefined) problems.push(problem)
  }
  for (const [pattern, what] of FORBIDDEN_TEXT) {
    if (pattern.test(source)) problems.push(`${file} ${what}`)
  }
  const importedAt = new Set(uses.map((use) => use.at))
  for (const match of source.matchAll(DANGEROUS_NAME)) {
    if (!importedAt.has(match.index)) problems.push(`${file} names the module ${match[0]} outside an import`)
  }
  if (file === 'main/fs-read.ts') problems.push(...fsReadProblems(clean))
  return problems
}

/** gate.ts may export runGate, the pure path check and types. Anything else could hand a write to another file. */
export function gateExportProblems(source: string): string[] {
  const clean = stripComments(source)
  const problems: string[] = []
  const allowed = /^export (async function runGate\b|function sortPath\b|(interface|type) \w+)/
  for (const match of clean.matchAll(/\bexport\b/g)) {
    const lineEnd = clean.indexOf('\n', match.index)
    const rest = clean.slice(match.index, lineEnd === -1 ? clean.length : lineEnd)
    const atLineStart = match.index === 0 || clean[match.index - 1] === '\n'
    if (!atLineStart || !allowed.test(rest)) problems.push(`gate.ts may not export: ${rest.trim()}`)
  }
  return problems
}

// The one write into saves/ (briefs/pr-15.md, round 7): only these files may name its reason. ports.ts declares it
// once, in WriteRequest.reason; this file names it to check it.
const PUT_BACK_REASON = 'save-put-back'
const PUT_BACK_NAMED_IN: Readonly<Record<string, number>> = {
  'main/safety/gate.ts': Infinity,
  'main/safety/gate.test.ts': Infinity,
  'main/safety/gate-lint.test.ts': Infinity,
  'main/savecopies/put-back.ts': Infinity,
  'main/ports.ts': 1
}

/** Every file under src/ that names the put-back reason where it may not, or more often than it may. */
export function putBackReasonProblems(texts: ReadonlyMap<string, string>): string[] {
  const problems: string[] = []
  for (const [rel, text] of texts) {
    const file = rel.replaceAll('\\', '/')
    const count = text.split(PUT_BACK_REASON).length - 1
    if (count > (PUT_BACK_NAMED_IN[file] ?? 0)) problems.push(`${file} names ${PUT_BACK_REASON}`)
  }
  return problems
}

async function readTree(root: string): Promise<Map<string, string>> {
  const texts = new Map<string, string>()
  for (const rel of await listFiles(root)) texts.set(rel, await readFile(join(root, rel), 'utf8'))
  return texts
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await listFiles(root, relPath)))
    else found.push(relPath)
  }
  return found.sort()
}

/** Checks every file under a src/ folder. No folder is skipped; only test files are. */
export async function lintTree(srcRoot: string): Promise<string[]> {
  const problems: string[] = []
  const all = await listFiles(srcRoot)
  const files = new Set(all)
  for (const rel of all) {
    if (PLAIN_FILE.test(rel) || isTestFile(rel)) continue
    if (!CODE_FILE.test(rel)) {
      problems.push(`${rel} is a kind of file this check does not know`)
      continue
    }
    const source = await readFile(join(srcRoot, rel), 'utf8')
    problems.push(...sourceProblems(rel, source, files))
    if (rel === GATE) problems.push(...gateExportProblems(source))
  }
  return problems
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

  it('checks every folder under src/: a planted write is found wherever it hides', async () => {
    const planted: Record<string, string> = {
      'main/safety/gate.ts': "import { rm } from 'node:fs/promises'\nexport async function runGate() {}\nexport const remove = rm\n",
      'main/inventory/index.ts': "import { readFile } from 'node:fs/promises'\nexport const read = readFile\n",
      'main/inventory/index.test.ts': "import { writeFile } from 'node:fs/promises'\n",
      'main/inventory/deep/down/save.ts': "import { writeFile } from 'node:fs/promises'\n",
      'main/locate/extra/run.ts': "import { execFile } from 'node:child_process'\n",
      'shared/testing/helper.ts': "import { rm } from 'node:fs/promises'\n",
      'renderer/testing/helper.ts': "import { helper } from '../../main/inventory/index.test.ts'\n",
      'renderer/test-setup.ts': "import { rm } from 'node:fs/promises'\n",
      'renderer/styles.css': 'body { color: red }\n',
      'main/tool.js': "require('fs').rmSync('x')\n",
      'main/tool.mjs': "import { rm } from 'node:fs/promises'\n",
      'main/tool.mts': "import { rm } from 'node:fs/promises'\n",
      'main/tool.cts': "import { rm } from 'node:fs/promises'\n",
      'main/addon.node': 'binary',
      'preload/run.cjs': "require('fs')\n"
    }
    const root = await mkdtemp(join(tmpdir(), 'sims-helper-gate-lint-test-'))
    try {
      for (const [rel, text] of Object.entries(planted)) {
        await mkdir(dirname(join(root, rel)), { recursive: true })
        await writeFile(join(root, rel), text)
      }
      const problems = await lintTree(root)
      const flagged = [...new Set(problems.map((problem) => problem.split(' ')[0]))].sort()
      expect(flagged, problems.join('\n')).toEqual([
        'gate.ts', // the extra export
        'main/addon.node',
        'main/inventory/deep/down/save.ts',
        'main/locate/extra/run.ts',
        'main/tool.cts',
        'main/tool.js',
        'main/tool.mjs',
        'main/tool.mts',
        'preload/run.cjs',
        'renderer/testing/helper.ts',
        'shared/testing/helper.ts'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the put-back reason only in the gate, its tests, put-back.ts, and once in ports.ts', async () => {
    expect(putBackReasonProblems(await readTree(SRC_ROOT))).toEqual([])
    const reason = PUT_BACK_REASON
    const planted = new Map<string, string>([
      ['main/safety/gate.ts', `'${reason}' '${reason}'`],
      ['main/savecopies/put-back.ts', `reason: '${reason}'`],
      ['main/ports.ts', `| '${reason}'`],
      ['main/savecopies/index.ts', `reason: '${reason}'`],
      ['main/savecopies/index.test.ts', `'${reason}'`],
      ['main/share/receive.ts', `const why = "${reason}"`],
      ['renderer/savecopies/SaveCopiesScreen.tsx', `// ${reason}`],
      ['main/fixes/notes.md', reason],
      ['main/safety/actions.ts', `\`${reason}\``]
    ])
    expect(putBackReasonProblems(planted).sort()).toEqual(
      [
        'main/fixes/notes.md',
        'main/safety/actions.ts',
        'main/savecopies/index.test.ts',
        'main/savecopies/index.ts',
        'main/share/receive.ts',
        'renderer/savecopies/SaveCopiesScreen.tsx'
      ].map((file) => `${file} names ${reason}`)
    )
    expect(putBackReasonProblems(new Map([['main/ports.ts', `'${reason}' | '${reason}'`]]))).toEqual([
      `main/ports.ts names ${reason}`
    ])
  })

  it('gate.ts exports runGate, the pure path check and types, and nothing else', async () => {
    expect(gateExportProblems(await readFile(join(SRC_ROOT, 'main/safety/gate.ts'), 'utf8'))).toEqual([])
    for (const line of [
      "export { writeFile } from 'node:fs/promises'",
      "export * from 'node:fs'",
      'export const save = writeFile',
      'export async function writeAnything(file: string): Promise<void> {}',
      'export default runGate',
      'const a = 1; export { rename }',
      "export type Zone = string; export { rm } from 'node:fs/promises'",
      'export function sortPath() {}; export const leak = rename'
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
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, 'r')"],
      ['main/fs-read.ts', "import { createReadStream } from 'node:fs'\ncreateReadStream(file, { flags: 'r' })"],
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

  it('electron-updater loads in main/update/updater.ts and nowhere else', () => {
    const line = "import { autoUpdater } from 'electron-updater'"
    expect(sourceProblems('main/update/updater.ts', line, SAMPLE_FILES)).toEqual([])
    const elsewhere = ['main/update/handlers.ts', 'main/index.ts', 'main/ipc.ts', 'main/safety/gate.ts', 'renderer/App.tsx']
    for (const file of elsewhere) {
      expect(sourceProblems(file, line, SAMPLE_FILES), file).not.toEqual([])
      expect(sourceProblems(file, "const updater = await import('electron-updater')", SAMPLE_FILES), file).not.toEqual([])
    }
    const subPath = "import { NsisUpdater } from 'electron-updater/out/NsisUpdater'"
    expect(sourceProblems('main/update/updater.ts', subPath, SAMPLE_FILES)).toEqual([])
    expect(sourceProblems('main/update/handlers.ts', subPath, SAMPLE_FILES)).not.toEqual([])
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
      ['main/inventory/index.ts', "import { writeFile /*\nimport { readFile as */ } from 'node:fs/promises'"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, /* 'r' */ 'w')"],
      // open and createReadStream belong to fs-read.ts alone, and only with read-only flags
      ['main/inventory/index.ts', "import { open } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "import { createReadStream } from 'node:fs'"],
      ['main/fs-read.ts', "import { createWriteStream } from 'node:fs'"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, 'w')"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, 'r+')"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, 'a')"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, flags)"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file)"],
      ['main/fs-read.ts', "import { open as o } from 'node:fs/promises'\nconst h = await o(file, 'w')"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst fn = open\nawait fn(file, 'w')"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nexport { open }"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, 'r')\nawait h.writeFile('x')"],
      ['main/fs-read.ts', "import { open } from 'node:fs/promises'\nconst h = await open(file, 'r')\nawait h.truncate(0)"],
      ['main/fs-read.ts', "import { createReadStream } from 'node:fs'\ncreateReadStream(file, { flags: 'w' })"],
      ['main/fs-read.ts', "import { createReadStream } from 'node:fs'\ncreateReadStream(file, { flags: 'r+' })"],
      ['main/fs-read.ts', "import { createReadStream } from 'node:fs'\ncreateReadStream(file, opts)"],
      ['main/fs-read.ts', "import { createReadStream } from 'node:fs'\ncreateReadStream(file)"],
      ['main/fs-read.ts', "import { createReadStream as crs } from 'node:fs'\ncrs(file, { flags: 'w' })"],
      // re-exports
      ['main/inventory/index.ts', "export { writeFile } from 'node:fs/promises'"],
      ['main/inventory/index.ts', "export * from 'node:fs'"],
      ['main/inventory/index.ts', "export * as disk from 'node:fs'"],
      // require and dynamic import
      ['main/inventory/index.ts', "const fs = require('fs')"],
      ['main/inventory/index.ts', "const fs = module.require('fs')"],
      ['main/inventory/index.ts', "import fs = require('node:fs')"],
      ['main/inventory/index.ts', 'const load = require'],
      ['main/inventory/index.ts', "const fs = await import('node:fs/promises')"],
      ['main/inventory/index.ts', 'const fs = await import(name)'],
      ['main/inventory/index.ts', 'const fs = await import(`node:fs`)'],
      ['main/inventory/index.ts', 'const path = await import(`node:path`)'],
      ['main/inventory/index.ts', "const fs = await import('node:' + 'fs')"],
      ['main/inventory/index.ts', "const name = 'node:fs'"],
      ['main/inventory/index.ts', 'const name = "child_process"'],
      ['main/inventory/index.ts', "const name = 'node:https'"],
      ['main/inventory/index.ts', "const name = 'node:net'"],
      // built-in modules reached without an import
      ['main/inventory/index.ts', "const fs = process.binding('fs')"],
      ['main/inventory/index.ts', "const fs = process['binding']('fs')"],
      ['main/inventory/index.ts', "const fs = process.getBuiltinModule('node:fs')"],
      ['main/inventory/index.ts', "const fs = globalThis.process['getBuiltinModule']('fs')"],
      ['main/inventory/index.ts', 'process.dlopen(module, file)'],
      ['main/inventory/index.ts', 'process.report.writeReport(file)'],
      ['main/inventory/index.ts', "eval('1')"],
      ['main/inventory/index.ts', "const run = new Function('return 1')"],
      ['main/inventory/index.ts', "const run = globalThis['Function']('return 1')"],
      // built-in modules that can write, load code, open the network or start a program
      ['main/inventory/index.ts', "import { createRequire } from 'node:module'"],
      ['main/inventory/index.ts', "import Module from 'module'"],
      ['main/inventory/index.ts', "import { Worker } from 'node:worker_threads'"],
      ['main/inventory/index.ts', "import net from 'node:net'"],
      ['main/inventory/index.ts', "import { createConnection } from 'net'"],
      ['main/inventory/index.ts', "import http from 'node:http'"],
      ['main/inventory/index.ts', "import { get } from 'http'"],
      ['main/inventory/index.ts', "import https from 'node:https'"],
      ['main/inventory/index.ts', "import { request } from 'https'"],
      ['main/inventory/index.ts', "import http2 from 'node:http2'"],
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
      // electron and the AI package stay in their own files (including subpaths)
      ['main/scan/index.ts', "import { shell } from 'electron'"],
      ['main/scan/index.ts', "import { app } from 'electron/main'"],
      ['main/scan/index.ts', "import { clipboard } from 'electron/common'"],
      ['renderer/App.tsx', "import { ipcRenderer } from 'electron/renderer'"],
      ['main/assist/index.ts', "import Anthropic from '@anthropic-ai/sdk'"],
      ['main/assist/index.ts', "import { Messages } from '@anthropic-ai/sdk/resources'"],
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
