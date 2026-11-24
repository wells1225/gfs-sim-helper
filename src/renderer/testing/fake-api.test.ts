import { describe, expect, it } from 'vitest'
import { fakeApi } from './fake-api.ts'

describe('fakeApi', () => {
  it('answers the update checks with off unless a test says otherwise', async () => {
    const api = fakeApi()
    expect(await api.invoke('update:get')).toEqual({ state: 'off', why: 'switched-off' })
    expect(await api.invoke('update:check', { by: 'start' })).toEqual({ state: 'off', why: 'switched-off' })
    await expect(api.invoke('update:download')).rejects.toThrow('no answer configured')
  })

  it('lets a test replace the update answers', async () => {
    const api = fakeApi({ 'update:get': { state: 'available', current: '0.2.0', next: '0.3.0' } })
    expect(await api.invoke('update:get')).toEqual({ state: 'available', current: '0.2.0', next: '0.3.0' })
  })
})
