// @vitest-environment node
// Its own file because it mocks share/links.ts: pins services.ts's wiring of ctx.openWeb to safeWebLink.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appPaths } from './app-paths.ts'
import type { Host } from './locate/host.ts'
import { createContext } from './services.ts'
import { safeWebLink } from './share/links.ts'

vi.mock('./share/links.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./share/links.ts')>()
  return { ...actual, safeWebLink: vi.fn(actual.safeWebLink) }
})

const check = vi.mocked(safeWebLink)

const host: Host = {
  documentsDir: '/fake/Documents',
  env: { USERNAME: 'Lila' },
  async readRegistry() {
    return undefined
  },
  async listProcesses() {
    return []
  },
  async fileVersion() {
    return undefined
  }
}

function makeContext(openExternal: (url: string) => Promise<void>) {
  return createContext({
    host,
    paths: appPaths({ localAppData: '/fake/LocalAppData', appData: '/fake/Roaming', desktopDir: '/fake/Desktop', env: {} }),
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (text) => Buffer.from(text, 'utf8'),
      decryptString: (data) => Buffer.from(data).toString('utf8')
    },
    emit: () => {},
    reveal: () => {},
    openExternal
  })
}

describe('ctx.openWeb wiring (services.ts)', () => {
  beforeEach(() => {
    check.mockReset()
  })

  it('runs the exact text through safeWebLink and opens only the url it gives back', async () => {
    const opened: string[] = []
    const ctx = makeContext(async (url) => {
      opened.push(url)
    })
    const text = 'https://www.curseforge.com/projects/1?from=her-list#top'
    check.mockReturnValueOnce({ url: 'https://www.curseforge.com/projects/1', host: 'www.curseforge.com' })

    expect(await ctx.openWeb(text)).toBe('opened')
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith(text)
    expect(opened).toEqual(['https://www.curseforge.com/projects/1'])
  })

  it('opens nothing when safeWebLink refuses or throws', async () => {
    const opened: string[] = []
    const ctx = makeContext(async (url) => {
      opened.push(url)
    })
    check.mockReturnValueOnce(null)
    expect(await ctx.openWeb('https://www.curseforge.com/projects/1')).toBe('refused')
    check.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(await ctx.openWeb('https://www.curseforge.com/projects/2')).toBe('refused')
    expect(check).toHaveBeenCalledTimes(2)
    expect(opened).toEqual([])
  })
})
