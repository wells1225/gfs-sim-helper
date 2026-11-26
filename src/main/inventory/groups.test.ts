// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assignGroups } from './groups.ts'
import type { UngroupedModFile } from './groups.ts'

function loose(relPath: string, bytes: number): UngroupedModFile {
  return { relPath, bytes, modifiedAt: '2026-11-20T18:00:00.000Z', hash: { status: 'not-needed' }, depth: 0, kind: 'other' }
}

describe('assignGroups', () => {
  it('keeps both loose files whose names differ only in letter case in one group', () => {
    const { files, groups } = assignGroups([loose('Foo.txt', 3), loose('foo.txt', 5)], { status: 'not-found' })
    expect(files.map((f) => f.groupId)).toEqual(['file:foo.txt', 'file:foo.txt'])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'file:foo.txt', files: ['Foo.txt', 'foo.txt'], bytes: 8 })
  })
})
