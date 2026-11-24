// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const WRITE_CALLS =
  /\b(writeFile|appendFile|rename|mkdir|mkdtemp|rm|rmdir|unlink|copyFile|cp|createWriteStream|symlink|link|truncate|utimes|chmod|chown|open)(Sync)?\b/

describe('locate is read-only', () => {
  it('no shipped locate file imports an fs write function', async () => {
    const files = (await readdir(THIS_DIR)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = await readFile(join(THIS_DIR, file), 'utf8')
      const fsImports = [...source.matchAll(/import\s+([^;]*?)\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/g)]
      for (const [, clause] of fsImports) {
        // Only named imports are allowed, so every fs function used here is listed and checked.
        expect(clause, `${file} imports fs as a default or namespace`).toMatch(/^(type\s+)?\{[^}]*\}$/)
        expect(clause, `${file} imports an fs write function`).not.toMatch(WRITE_CALLS)
      }
      expect(source, `${file} loads fs with require or import()`).not.toMatch(
        /(require|import)\s*\(\s*['"](?:node:)?fs/
      )
    }
  })
})
