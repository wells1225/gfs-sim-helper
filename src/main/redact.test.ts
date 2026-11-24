// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeRedactor } from './redact.ts'

describe('makeRedactor', () => {
  it('replaces USERNAME and USERPROFILE leaf as whole path segments regardless of case', () => {
    const redact = makeRedactor({
      USERNAME: 'Lila',
      USERPROFILE: 'C:\\Users\\LilaHome\\'
    })

    expect(redact('C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4')).toBe(
      'C:\\Users\\<user>\\Documents\\Electronic Arts\\The Sims 4'
    )
    expect(redact('c:/users/LILA/x')).toBe('c:/users/<user>/x')
    expect(redact('C:\\Users\\lilahome\\Desktop\\report.zip')).toBe('C:\\Users\\<user>\\Desktop\\report.zip')
    expect(redact('{"home":"C:\\\\Users\\\\Lila"}')).toBe('{"home":"C:\\\\Users\\\\<user>"}')
  })

  it('never replaces inside a longer word', () => {
    const redact = makeRedactor({ USERNAME: 'Lila' })

    expect(redact('Mods/Lilac.package')).toBe('Mods/Lilac.package')
    expect(redact('C:\\Users\\Lilac\\Documents')).toBe('C:\\Users\\Lilac\\Documents')
  })

  it('returns text unchanged when no user name is known', () => {
    const redact = makeRedactor({})

    const sample = 'C:\\Users\\Lila\\Documents'
    expect(redact(sample)).toBe(sample)
  })
})
