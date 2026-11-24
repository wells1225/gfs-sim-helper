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
      for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'node:fs(?:\/promises)?'/g)) {
        expect(match[1], `${file} imports an fs write function`).not.toMatch(WRITE_CALLS)
      }
      expect(source, `${file} imports fs as a namespace`).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+'(node:)?fs/)
      expect(source, `${file} imports bare 'fs'`).not.toMatch(/from\s+'fs(\/promises)?'/)
    }
  })
})
