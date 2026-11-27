import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { badName, caseDuplicates } from '../names.mjs'

describe('badName', () => {
  for (const ok of ['MyMod.package', 'Outfit Reactions v2.ts4script', 'console.package', 'comet.package', 'COM10.package', 'lpt.package']) {
    it(`accepts ${ok}`, () => assert.equal(badName(ok), null))
  }
  for (const bad of [
    'CON.package',
    'con.package',
    'NUL.ts4script',
    'aux.v2.package',
    'COM1.package',
    'LPT9.ts4script',
    'PRN.package',
    'a<b.package',
    'a>b.package',
    'a:b.package',
    'a/b.package',
    'a\\b.package',
    'a..b.package',
    '.hidden.package',
    'trailing.package ',
    'readme.txt',
    'mod.Package',
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => assert.notEqual(badName(bad), null))
  }
})

describe('caseDuplicates', () => {
  it('finds names that differ only in case', () => {
    assert.deepEqual(caseDuplicates(['MyMod.package', 'mymod.package', 'Other.package']), [['MyMod.package', 'mymod.package']])
  })
  it('finds nothing in distinct names', () => {
    assert.deepEqual(caseDuplicates(['A.package', 'B.package']), [])
  })
})
