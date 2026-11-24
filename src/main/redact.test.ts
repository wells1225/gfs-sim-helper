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

  it('replaces the name when it is the last segment followed by punctuation or whitespace', () => {
    const redact = makeRedactor({ USERNAME: 'Ann' })

    const delimiters = ['<', '>', ')', ']', ',', '.', ';', '"', "'", ' ', '\t', '\r', '\n', ':', '!', '?', '}', '|', '-']
    for (const d of delimiters) {
      expect(redact(`C:\\Users\\Ann${d}rest`)).toBe(`C:\\Users\\<user>${d}rest`)
      expect(redact(`C:/Users/Ann${d}rest`)).toBe(`C:/Users/<user>${d}rest`)
      expect(redact(`C:\\\\Users\\\\Ann${d}rest`)).toBe(`C:\\\\Users\\\\<user>${d}rest`)
    }

    expect(redact('<path>C:\\Users\\Ann</path>')).toBe('<path>C:\\Users\\<user></path>')
    expect(redact('(C:\\Users\\Ann)')).toBe('(C:\\Users\\<user>)')
    expect(redact('Folder is C:\\Users\\Ann.')).toBe('Folder is C:\\Users\\<user>.')
    expect(redact('C:\\Users\\Ann, then more')).toBe('C:\\Users\\<user>, then more')
    expect(redact('[C:/Users/Ann]')).toBe('[C:/Users/<user>]')
    expect(redact("'C:\\Users\\Ann'")).toBe("'C:\\Users\\<user>'")
    expect(redact('{"home":"C:\\\\Users\\\\Ann"}')).toBe('{"home":"C:\\\\Users\\\\<user>"}')
    expect(redact('Ann\\Documents')).toBe('<user>\\Documents')
    expect(redact('Ann')).toBe('<user>')
  })

  it('still leaves longer words alone after any separator', () => {
    const redact = makeRedactor({ USERNAME: 'Ann' })

    for (const word of ['Annabelle', 'Annual', 'Ann_2', 'Ann2', 'Annë', 'Anné']) {
      expect(redact(`C:\\Users\\${word}\\x`)).toBe(`C:\\Users\\${word}\\x`)
      expect(redact(`C:/Users/${word}.`)).toBe(`C:/Users/${word}.`)
      expect(redact(`C:\\\\Users\\\\${word}"`)).toBe(`C:\\\\Users\\\\${word}"`)
    }
    expect(redact('Hannah and Ann went out')).toBe('Hannah and Ann went out')
    expect(redact('Mods/JoAnn.package')).toBe('Mods/JoAnn.package')
  })

  it('returns text unchanged when no user name is known', () => {
    const redact = makeRedactor({})

    const sample = 'C:\\Users\\Lila\\Documents'
    expect(redact(sample)).toBe(sample)
  })
})
