// @vitest-environment node
// release.yml can only really run on a v* tag, which only Tyler pushes, so its safety rules are pinned here as text.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

let text = ''
let build = ''
let publish = ''

beforeAll(async () => {
  text = (await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')).replaceAll('\r\n', '\n')
  const publishAt = text.indexOf('\n  publish:\n')
  build = text.slice(text.indexOf('\n  build:\n'), publishAt)
  publish = text.slice(publishAt)
})

// Lines that run or name something, with comments dropped.
const code = (section: string) =>
  section
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

describe('release.yml', () => {
  it('runs only on a v* tag push', () => {
    expect(text).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n\n/m)
    expect(text).not.toMatch(/pull_request|workflow_dispatch|workflow_run|schedule:/)
  })

  it('grants nothing at the top, read to the build, and write only to the publish job', () => {
    expect(text).toMatch(/^permissions: \{\}$/m)
    expect(build).toMatch(/permissions:\n {6}contents: read\n/)
    expect(publish).toMatch(/permissions:\n {6}contents: write\n/)
    expect(code(text).match(/: write/g)).toEqual([': write'])
    expect(text.indexOf('contents: write')).toBeGreaterThan(text.indexOf('\n  publish:\n'))
  })

  it('the publish job runs no repo code and no npm', () => {
    const steps = code(publish)
    for (const banned of ['actions/checkout', 'npm', 'npx', 'node ', 'scripts/', 'actions/setup-node']) {
      expect(steps).not.toContain(banned)
    }
    expect(publish).toContain('needs: build')
  })

  it('uses no stored secret, only the built-in token', () => {
    expect(text).not.toContain('secrets.')
    expect(text.match(/GH_TOKEN: \$\{\{ (.+?) \}\}/g)?.every((line) => line.endsWith('${{ github.token }}'))).toBe(true)
  })

  it('leaves a draft and never publishes', () => {
    const creates = code(text).match(/gh release create[^\n]*/g) ?? []
    expect(creates).toHaveLength(1)
    expect(creates[0]).toContain('--draft')
    expect(creates[0]).toContain('--verify-tag')
    expect(code(text)).not.toMatch(/gh release edit|--draft=false|--latest|gh api[^\n]*releases/)
  })

  it('stages the installer under the name latest.yml gives before uploading it', () => {
    expect(build).toContain('node scripts/release/stage.ts --dist dist --out staged --version')
    expect(build.indexOf('scripts/release/stage.ts')).toBeLessThan(build.indexOf('name: staged'))
  })

  it('pins the actions the write job uses to a commit', () => {
    for (const uses of publish.match(/uses: \S+/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40}$/)
  })
})

describe('release.yml, the proof', () => {
  it('skips the update proof only when GitHub says there is no release, never on another error', () => {
    expect(build).toContain("grep -q 'release not found' err.txt")
    expect(build).not.toMatch(/gh release view[^\n]*\|\| true/)
  })
})
