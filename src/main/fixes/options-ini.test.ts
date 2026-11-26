// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { editOptionsIni } from './options-ini.ts'

describe('editOptionsIni keeps every other byte', () => {
  const cases: { name: string; before: string; after: string }[] = [
    {
      name: 'a byte order mark before [options]',
      before: '﻿[options]\r\nmodsdisabled=1\r\nscriptmodsenabled=0\r\n',
      after: '﻿[options]\r\nmodsdisabled=0\r\nscriptmodsenabled=1\r\n'
    },
    {
      name: 'no [options] section: one is added at the end with the file line ending',
      before: '[graphics]\r\nedge=2',
      after: '[graphics]\r\nedge=2\r\n[options]\r\nmodsdisabled=0\r\nscriptmodsenabled=1\r\n'
    },
    {
      name: 'duplicate keys and a duplicate [options] section are all set',
      before: '[options]\nmodsdisabled=1\nmodsdisabled=1\nscriptmodsenabled=0\n[x]\na=1\n[Options]\nmodsdisabled=1\n',
      after: '[options]\nmodsdisabled=0\nmodsdisabled=0\nscriptmodsenabled=1\n[x]\na=1\n[Options]\nmodsdisabled=0\n'
    },
    {
      name: 'no trailing line ending: a missing key is added without inventing one at the end',
      before: '[options]\r\nmodsdisabled=1',
      after: '[options]\r\nmodsdisabled=0\r\nscriptmodsenabled=1'
    },
    {
      name: 'a key outside [options] is left alone',
      before: 'modsdisabled=1\r\n[options]\r\nmodsdisabled=1\r\nscriptmodsenabled=0\r\n',
      after: 'modsdisabled=1\r\n[options]\r\nmodsdisabled=0\r\nscriptmodsenabled=1\r\n'
    },
    {
      name: 'spaces around = and the key letter case stay',
      before: '[options]\r\n  ModsDisabled = 1\r\nscriptmodsenabled =0\r\n',
      after: '[options]\r\n  ModsDisabled = 0\r\nscriptmodsenabled =1\r\n'
    }
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(editOptionsIni(c.before)).toBe(c.after)
    })
  }

  it('changes nothing when both keys are already on', () => {
    const text = '[options]\r\nmodsdisabled = 0\r\nscriptmodsenabled = 1\r\nother=x\r\n'
    expect(editOptionsIni(text)).toBe(text)
  })
})
