// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appPaths } from './app-paths.ts'

describe('appPaths', () => {
  it('places all app-data paths under <localAppData>/SimsHelper', () => {
    const localAppData = join('/fake', 'LocalAppData')
    const appData = join('/fake', 'Roaming')
    const desktopDir = join('/fake', 'Desktop')

    const paths = appPaths({
      localAppData,
      appData,
      desktopDir,
      env: {
        OneDrive: '/fake/OneDrive',
        OneDriveConsumer: '/fake/OneDrive',
        OneDriveCommercial: '/fake/OneDrive - Work'
      }
    })

    const expectedRoot = join(localAppData, 'SimsHelper')
    expect(paths.dataDir).toBe(expectedRoot)
    expect(paths.backupsDir).toBe(join(expectedRoot, 'backups'))
    expect(paths.holdingDir).toBe(join(expectedRoot, 'holding'))
    expect(paths.journalDir).toBe(join(expectedRoot, 'journal'))
    expect(paths.stateDir).toBe(join(expectedRoot, 'state'))
    expect(paths.keyFile).toBe(join(expectedRoot, 'assist', 'key.bin'))
    expect(paths.desktopDir).toBe(desktopDir)
    expect(paths.oneDriveRoots).toEqual(['/fake/OneDrive', '/fake/OneDrive - Work'])
    expect(paths.curseForgeInstanceFile).toBe(
      join(appData, 'CurseForge', 'agent', 'GameInstances', 'AddonGameInstance.json')
    )
  })

  it('sets curseForgeInstanceFile to null when appData is missing', () => {
    const paths = appPaths({
      localAppData: '/fake/LocalAppData',
      appData: null,
      desktopDir: '/fake/Desktop',
      env: {}
    })

    expect(paths.curseForgeInstanceFile).toBeNull()
    expect(paths.oneDriveRoots).toEqual([])
  })
})
