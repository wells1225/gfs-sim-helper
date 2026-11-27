import { describe, expect, it } from 'vitest'
import { fakeApi } from './fake-api.ts'

describe('fakeApi', () => {
  it('answers the update checks with off unless a test says otherwise', async () => {
    const api = fakeApi()
    expect(await api.invoke('update:get')).toEqual({ state: 'off', why: 'switched-off', current: '0.2.0' })
    expect(await api.invoke('update:check', { by: 'start' })).toEqual({ state: 'off', why: 'switched-off', current: '0.2.0' })
    await expect(api.invoke('update:download')).rejects.toThrow('no answer configured')
  })

  it('lets a test replace the update answers', async () => {
    const api = fakeApi({ 'update:get': { state: 'available', current: '0.2.0', next: '0.3.0' } })
    expect(await api.invoke('update:get')).toEqual({ state: 'available', current: '0.2.0', next: '0.3.0' })
  })

  it('answers the start-up recovery as finished with nothing touched', async () => {
    expect(await fakeApi().invoke('journal:recovery')).toEqual({ status: 'finished', touched: [] })
  })

  it('answers Share saves as not set up yet, with empty lists', async () => {
    const api = fakeApi()
    expect(await api.invoke('share:get')).toEqual({
      link: { state: 'no-role' },
      settings: { role: null, folderLabel: null, keepOld: 5, keepInDrive: 3 },
      saves: [],
      aiFind: 'hide'
    })
    expect(await api.invoke('share:local-saves')).toEqual([])
    expect(await api.invoke('share:old-saves')).toEqual([])
  })

  it('answers save copies, patch day and Ask Tyler as nothing yet', async () => {
    const api = fakeApi()
    expect(await api.invoke('savecopies:list')).toEqual([])
    expect(await api.invoke('patchguard:watch')).toEqual({ current: null, lastSeen: null, changed: false, seenAt: null })
    expect(await api.invoke('patchguard:waiting')).toEqual([])
    expect(await api.invoke('requests:folder')).toEqual({ kind: 'not-set' })
    expect(await api.invoke('requests:list')).toEqual([])
    await expect(api.invoke('patchguard:play', { ignoreUpdate: false })).rejects.toThrow('no answer configured')
  })
})
