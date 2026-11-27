// @vitest-environment node
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModFolderState, ModRequest } from '../../shared/model.ts'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import type { AppContext } from '../ports.ts'
import { createContext } from '../services.ts'
import { buildInventory } from '../inventory/index.ts'
import { scriptTooDeep } from '../rules/rules.ts'
import { requestsHandlers } from './handlers.ts'
import { modFolderRoot, resetModFolderRoot } from './mod-folder.ts'
import { safeModFolderName } from './names.ts'

function sha256Of(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

interface TestWorld {
  root: string
  simsFolder: string
  modFolder: string
  dataDir: string
  stateDir: string
  holdingDir: string
  ctx: AppContext
  handlers: ReturnType<typeof requestsHandlers>
  picked: string | null
  cleanup(): Promise<void>
}

async function makeWorld(opts?: {
  now?: Date
  username?: string
  gameRunning?: boolean
  withModFolder?: boolean
}): Promise<TestWorld> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-p17-')))
  const username = opts?.username ?? 'LilaSecretUser'
  const userHome = join(root, 'Users', username)
  const documentsDir = join(userHome, 'Documents')
  const simsFolder = join(documentsDir, 'Electronic Arts', 'The Sims 4')
  const localAppData = join(userHome, 'AppData', 'Local')
  const desktopDir = join(userHome, 'Desktop')
  const modFolder = join(root, 'GDrive', 'My Drive', 'Sims Helper Mods')

  await mkdir(join(simsFolder, 'Mods'), { recursive: true })
  await mkdir(join(simsFolder, 'saves'), { recursive: true })
  await mkdir(join(simsFolder, 'Tray'), { recursive: true })
  await mkdir(localAppData, { recursive: true })
  await mkdir(desktopDir, { recursive: true })
  await writeFile(join(simsFolder, 'Options.ini'), '[options]\nmodsdisabled = 0\nscriptmodsenabled = 1\n')
  await writeFile(join(simsFolder, 'saves', 'Slot_00000002.save'), 'precious save data')
  await writeFile(join(simsFolder, 'Mods', 'existing.package'), 'DBPF-existing')

  if (opts?.withModFolder !== false) {
    await mkdir(modFolder, { recursive: true })
  }

  const paths = appPaths({
    localAppData,
    appData: join(userHome, 'AppData', 'Roaming'),
    desktopDir,
    env: {}
  })

  const host: Host = {
    documentsDir,
    env: {
      USERNAME: username,
      USERPROFILE: userHome
    },
    async readRegistry() {
      return undefined
    },
    async listProcesses() {
      return opts?.gameRunning ? ['TS4_x64.exe'] : []
    },
    async fileVersion() {
      return undefined
    }
  }

  const clockNow = opts?.now ?? new Date('2026-11-26T14:30:00.000Z')
  let idSeq = 0

  const world: TestWorld = {
    root,
    simsFolder,
    modFolder,
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    holdingDir: paths.holdingDir,
    ctx: null as unknown as AppContext,
    handlers: null as unknown as ReturnType<typeof requestsHandlers>,
    picked: null,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    }
  }

  world.ctx = createContext({
    host,
    paths,
    clock: { now: () => clockNow },
    newId: () => `20261126-143000-${String(++idSeq).padStart(4, '0')}`,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    },
    emit: () => {},
    reveal: () => {},
    pickFolder: async () => world.picked
  })

  world.handlers = requestsHandlers(world.ctx)
  return world
}

async function saveModFolderState(w: TestWorld, folderPath: string): Promise<void> {
  await mkdir(w.stateDir, { recursive: true })
  await writeFile(join(w.stateDir, 'mod-folder.json'), JSON.stringify({ path: folderPath }, null, 2))
}

async function writeRequestFile(
  modFolder: string,
  id: string,
  overrides: Partial<{ at: string; text: string }> = {}
): Promise<void> {
  await mkdir(join(modFolder, 'requests'), { recursive: true })
  const payload = {
    format: 1,
    id,
    at: overrides.at ?? '2026-11-26T14:30:00.000Z',
    text: overrides.text ?? 'Please make a cozy slippers mod',
    game: { version: '1.129.39.1030', packs: ['EP01'] },
    mods: ['MCCC']
  }
  await writeFile(join(modFolder, 'requests', `${id}.json`), JSON.stringify(payload, null, 2))
}

async function writeGoodDelivery(
  modFolder: string,
  requestId: string,
  opts: {
    title?: string
    note?: string
    hasScript?: boolean
    files?: { name: string; content: string }[]
  } = {}
): Promise<{ files: { name: string; bytes: number; sha256: string }[] }> {
  const dir = join(modFolder, 'from-tyler', requestId)
  const filesDir = join(dir, 'files')
  await mkdir(filesDir, { recursive: true })
  const inputFiles = opts.files ?? [{ name: 'cozy_slippers.package', content: 'DBPF-cozy-slippers-bytes' }]
  const manifestFiles: { name: string; bytes: number; sha256: string }[] = []
  for (const f of inputFiles) {
    await writeFile(join(filesDir, f.name), f.content)
    manifestFiles.push({
      name: f.name,
      bytes: Buffer.byteLength(f.content),
      sha256: sha256Of(f.content)
    })
  }
  const hasScript = opts.hasScript ?? manifestFiles.some((f) => f.name.toLowerCase().endsWith('.ts4script'))
  const ready = {
    format: 1,
    requestId,
    title: opts.title ?? 'Cozy Slippers',
    note: opts.note ?? 'Adds cozy slippers in Everyday footwear.',
    files: manifestFiles,
    hasScript
  }
  await writeFile(join(dir, 'ready.json'), JSON.stringify(ready, null, 2))
  return { files: manifestFiles }
}

const cleanups: (() => Promise<void>)[] = []

beforeEach(() => {
  resetModFolderRoot()
})

afterEach(async () => {
  resetModFolderRoot()
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function createWorld(opts?: Parameters<typeof makeWorld>[0]): Promise<TestWorld> {
  const w = await makeWorld(opts)
  cleanups.push(() => w.cleanup())
  return w
}

describe('mod folder setup and validation (requests:folder & requests:pick-folder)', () => {
  it('returns not-set before any folder is saved', async () => {
    const w = await createWorld()
    expect(await w.handlers['requests:folder']()).toEqual({ kind: 'not-set' })
    expect(modFolderRoot()).toBeNull()
  })

  it('picks and persists a valid Sims Helper Mods folder, and reloads it after an app restart', async () => {
    const w = await createWorld()
    w.picked = w.modFolder
    const picked = await w.handlers['requests:pick-folder']()
    expect(picked).toEqual({ kind: 'set', path: w.modFolder })
    expect(modFolderRoot()).toBe(w.modFolder)

    // Simulate app restart: clear in-memory root, then call requests:folder
    resetModFolderRoot()
    expect(modFolderRoot()).toBeNull()
    expect(await w.handlers['requests:folder']()).toEqual({ kind: 'set', path: w.modFolder })
    expect(modFolderRoot()).toBe(w.modFolder)
  })

  it('keeps existing state when folder picker is cancelled', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    w.picked = null
    expect(await w.handlers['requests:pick-folder']()).toEqual({ kind: 'set', path: w.modFolder })
  })

  it('reports missing when the saved folder disappears on disk', async () => {
    const w = await createWorld({ withModFolder: false })
    await saveModFolderState(w, w.modFolder)
    const state = await w.handlers['requests:folder']()
    expect(state).toEqual({ kind: 'missing', path: w.modFolder })
    expect(modFolderRoot()).toBeNull()
  })

  it('refuses wrong folder name, wrong on-disk casing, symlink, dataDir, and system folders', async () => {
    const w = await createWorld()
    const wrongName = join(w.root, 'GDrive', 'My Drive', 'Mods')
    await mkdir(wrongName, { recursive: true })
    w.picked = wrongName
    expect(await w.handlers['requests:pick-folder']()).toEqual({ kind: 'wrong-name', path: wrongName })
    expect(modFolderRoot()).toBeNull()

    // Wrong casing on disk
    const lowerDir = join(w.root, 'GDrive', 'Lower', 'sims helper mods')
    await mkdir(lowerDir, { recursive: true })
    w.picked = join(w.root, 'GDrive', 'Lower', 'Sims Helper Mods')
    const caseRes = await w.handlers['requests:pick-folder']()
    expect(caseRes.kind === 'wrong-name' || caseRes.kind === 'missing').toBe(true)

    // Symlink to valid folder
    const linkParent = join(w.root, 'LinkParent')
    await mkdir(linkParent, { recursive: true })
    const linked = join(linkParent, 'Sims Helper Mods')
    await symlink(w.modFolder, linked, 'dir')
    w.picked = linked
    const linkRes = await w.handlers['requests:pick-folder']()
    expect(linkRes.kind).not.toBe('set')

    // Inside dataDir
    const inData = join(w.dataDir, 'Sims Helper Mods')
    await mkdir(inData, { recursive: true })
    w.picked = inData
    expect((await w.handlers['requests:pick-folder']()).kind).not.toBe('set')

    // Inside Windows system folder
    const inWin = join(w.root, 'Windows', 'Sims Helper Mods')
    await mkdir(inWin, { recursive: true })
    w.picked = inWin
    expect((await w.handlers['requests:pick-folder']()).kind).not.toBe('set')
  })

  it('accepts a Google Drive for desktop shortcut and saves its real target, so send and install work through the gate', async () => {
    const w = await createWorld({ withModFolder: false })
    // DriveFS shows "Add shortcut to Drive" in My Drive as a junction to G:\.shortcut-targets-by-id\<id>\<name>.
    const target = join(w.root, 'GDrive', '.shortcut-targets-by-id', '1AbC-dEf_9xYz', 'Sims Helper Mods')
    await mkdir(target, { recursive: true })
    await mkdir(join(w.root, 'GDrive', 'My Drive'), { recursive: true })
    await symlink(target, w.modFolder, 'junction')

    w.picked = w.modFolder
    expect(await w.handlers['requests:pick-folder']()).toEqual({ kind: 'set', path: target })
    expect(modFolderRoot()).toBe(target)
    expect(JSON.parse(await readFile(join(w.stateDir, 'mod-folder.json'), 'utf8'))).toEqual({ path: target })

    // After a restart it is still set.
    resetModFolderRoot()
    expect(await w.handlers['requests:folder']()).toEqual({ kind: 'set', path: target })

    const sent = await w.handlers['requests:send']({ text: 'Cozy rugs please' })
    expect(sent.kind).toBe('sent')
    expect(await readdir(join(target, 'requests'))).toHaveLength(1)

    const id = 'r-20261126-143000-gd01'
    await writeRequestFile(target, id)
    await writeGoodDelivery(target, id, { title: 'Cozy Rugs' })
    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('done')
    expect(await exists(join(w.simsFolder, 'Mods', 'From Tyler - Cozy Rugs', 'cozy_slippers.package'))).toBe(true)
  })

  it('still refuses a link to a Sims Helper Mods folder that is not a Google Drive shortcut target', async () => {
    const w = await createWorld({ withModFolder: false })
    const cases = [
      join(w.root, 'elsewhere', 'Sims Helper Mods'),
      join(w.root, 'GDrive', '.shortcut-targets-by-id', 'Sims Helper Mods'),
      join(w.root, 'GDrive', '.shortcut-targets-by-id', 'id1', 'deeper', 'Sims Helper Mods'),
      join(w.root, 'GDrive', '.shortcut-targets-by-id', 'id2', 'Other Folder')
    ]
    await mkdir(join(w.root, 'GDrive', 'My Drive'), { recursive: true })
    for (const target of cases) {
      await mkdir(target, { recursive: true })
      await rm(w.modFolder, { force: true, recursive: false }).catch(() => {})
      await symlink(target, w.modFolder, 'junction')
      w.picked = w.modFolder
      const state = await w.handlers['requests:pick-folder']()
      expect(state.kind).not.toBe('set')
      expect(modFolderRoot()).toBeNull()
      expect(await exists(join(w.stateDir, 'mod-folder.json'))).toBe(false)
    }
  })

  it('refuses a folder inside the Sims folder or any folder holding Options.ini', async () => {
    const w = await createWorld()
    const insideSims = join(w.simsFolder, 'Sims Helper Mods')
    await mkdir(insideSims, { recursive: true })
    w.picked = insideSims
    expect(await w.handlers['requests:pick-folder']()).toEqual({ kind: 'in-sims-folder', path: insideSims })

    const customSims = join(w.root, 'CustomGame')
    const underCustom = join(customSims, 'Sub', 'Sims Helper Mods')
    await mkdir(underCustom, { recursive: true })
    await writeFile(join(customSims, 'Options.ini'), '[options]\n')
    w.picked = underCustom
    expect(await w.handlers['requests:pick-folder']()).toEqual({ kind: 'in-sims-folder', path: underCustom })
  })
})

describe('requests:send privacy and validation', () => {
  it('writes one request file with no path, no Windows username, and no email address, even after app restart', async () => {
    const w = await createWorld({ username: 'LilaSecretUser', gameRunning: true })
    await saveModFolderState(w, w.modFolder)
    // Hydrate only via requests:send itself (simulate fresh restart)
    resetModFolderRoot()

    w.ctx.session.scan = {
      id: 'scan-1',
      at: '2026-11-26T14:00:00.000Z',
      tookMs: 50,
      symptom: 'not-sure',
      folder: { path: w.simsFolder, inOneDrive: false, newestFileAt: new Date('2026-11-26T14:00:00.000Z') },
      otherFolders: [],
      game: { path: join(w.root, 'Program Files', 'EA Games', 'The Sims 4'), version: '1.129.39.1030', packs: ['EP01', 'GP02'] },
      gameRunning: 'running',
      facts: { options: { status: 'ok', mods: 'on', scriptMods: 'on' }, gameUpdatedAt: null, thumbCacheAt: null },
      inventory: {
        modsDir: join(w.simsFolder, 'Mods'),
        modsDirState: 'present',
        files: [],
        groups: [
          {
            id: 'cf:1',
            label: 'Wicked Wardrobe',
            source: 'curseforge',
            files: ['ww.package'],
            bytes: 100,
            hasScript: false,
            curseForge: null
          },
          {
            id: 'dir:leaky',
            label: `C:\\Users\\LilaSecretUser\\Mods\\lila@example.com`,
            source: 'folder',
            files: ['a.package'],
            bytes: 100,
            hasScript: false,
            curseForge: null
          }
        ],
        resourceCfg: { status: 'ok', maxPackageDepth: 5 },
        curseForge: { status: 'not-found' },
        skipped: []
      },
      logs: [],
      findings: []
    }

    const res = await w.handlers['requests:send']({
      text: '  Make Sims react happily to new outfits!\r\nPlease include a swatch.  '
    })
    expect(res.kind).toBe('sent')
    if (res.kind !== 'sent') throw new Error('expected sent')

    expect(res.request.id).toMatch(/^r-20261126-143000-[a-z0-9]{4}$/)
    expect(res.request.status).toBe('sent')
    expect(res.request.delivery).toBeNull()
    expect(res.request.text).toBe('Make Sims react happily to new outfits!\nPlease include a swatch.')

    const files = await readdir(join(w.modFolder, 'requests'))
    expect(files).toEqual([`${res.request.id}.json`])

    const raw = await readFile(join(w.modFolder, 'requests', `${res.request.id}.json`), 'utf8')
    expect(raw).not.toContain('LilaSecretUser')
    expect(raw).not.toContain(w.simsFolder)
    expect(raw).not.toContain(w.modFolder)
    expect(raw).not.toContain(w.dataDir)
    expect(raw).not.toContain('lila@example.com')
    expect(raw).not.toContain('C:\\Users\\')

    const parsed = JSON.parse(raw) as {
      format: number
      id: string
      at: string
      text: string
      game: { version: string | null; packs: string[] }
      mods: string[]
    }
    expect(parsed.format).toBe(1)
    expect(parsed.id).toBe(res.request.id)
    expect(parsed.at).toBe('2026-11-26T14:30:00.000Z')
    expect(parsed.game).toEqual({ version: '1.129.39.1030', packs: ['EP01', 'GP02'] })
    expect(parsed.mods).toContain('Wicked Wardrobe')
  })

  it('refuses empty, over 2000 characters, and missing folder', async () => {
    const w = await createWorld()
    expect(await w.handlers['requests:send']({ text: 'Hello' })).toEqual({ kind: 'refused', why: 'no-folder' })

    await saveModFolderState(w, w.modFolder)
    expect(await w.handlers['requests:send']({ text: '   \n\t  ' })).toEqual({ kind: 'refused', why: 'empty' })
    expect(await w.handlers['requests:send']({ text: 'a'.repeat(2001) })).toEqual({ kind: 'refused', why: 'too-long' })

    // Exactly 2000 characters passes
    const ok = await w.handlers['requests:send']({ text: 'a'.repeat(2000) })
    expect(ok.kind).toBe('sent')
  })

  it('truncates emoji-heavy mod and pack labels by UTF-16 length without splitting surrogate pairs', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const emojiLabel = '😀'.repeat(150) // 150 code points, 300 UTF-16 code units (> 200)
    const emojiPack = '🎉'.repeat(50) // 50 code points, 100 UTF-16 code units (> 80)

    w.ctx.session.scan = {
      id: 'scan-emoji',
      at: '2026-11-26T14:00:00.000Z',
      tookMs: 10,
      symptom: 'not-sure',
      folder: { path: w.simsFolder, inOneDrive: false, newestFileAt: new Date('2026-11-26T14:00:00.000Z') },
      otherFolders: [],
      game: { path: join(w.root, 'Game'), version: '1.129.39.1030', packs: [emojiPack as unknown as 'EP01'] },
      gameRunning: 'not-running',
      facts: { options: { status: 'ok', mods: 'on', scriptMods: 'on' }, gameUpdatedAt: null, thumbCacheAt: null },
      inventory: {
        modsDir: join(w.simsFolder, 'Mods'),
        modsDirState: 'present',
        files: [],
        groups: [
          {
            id: 'dir:emoji',
            label: emojiLabel,
            source: 'folder',
            files: ['a.package'],
            bytes: 10,
            hasScript: false,
            curseForge: null
          }
        ],
        resourceCfg: { status: 'ok', maxPackageDepth: 5 },
        curseForge: { status: 'not-found' },
        skipped: []
      },
      logs: [],
      findings: []
    }

    const res = await w.handlers['requests:send']({ text: 'Please add cozy lights' })
    expect(res.kind).toBe('sent')
    if (res.kind !== 'sent') throw new Error('expected sent')

    const raw = await readFile(join(w.modFolder, 'requests', `${res.request.id}.json`), 'utf8')
    const parsed = JSON.parse(raw) as { game: { packs: string[] }; mods: string[] }
    expect(parsed.mods).toHaveLength(1)
    expect(parsed.mods[0]!.length).toBeLessThanOrEqual(200)
    expect(Buffer.from(parsed.mods[0]!, 'utf8').toString('utf8')).toBe(parsed.mods[0]!)
    expect(parsed.game.packs).toHaveLength(1)
    expect(parsed.game.packs[0]!.length).toBeLessThanOrEqual(80)
    expect(Buffer.from(parsed.game.packs[0]!, 'utf8').toString('utf8')).toBe(parsed.game.packs[0]!)
  })

  it('redacts pasted file paths, Windows usernames, and email addresses from her typed request text', async () => {
    const w = await createWorld({ username: 'LilaSecretUser' })
    await saveModFolderState(w, w.modFolder)

    const res = await w.handlers['requests:send']({
      text: 'Please check C:\\Users\\LilaSecretUser\\Documents\\Electronic Arts\\The Sims 4\\Mods\\hair.package and email lila@example.com for LilaSecretUser!'
    })
    expect(res.kind).toBe('sent')
    if (res.kind !== 'sent') throw new Error('expected sent')

    const raw = await readFile(join(w.modFolder, 'requests', `${res.request.id}.json`), 'utf8')
    expect(raw).not.toContain('LilaSecretUser')
    expect(raw).not.toContain('C:\\Users\\')
    expect(raw).not.toContain('lila@example.com')
    expect(res.request.text).not.toContain('LilaSecretUser')
    expect(res.request.text).not.toContain('C:\\Users\\')
    expect(res.request.text).not.toContain('lila@example.com')
  })
})

describe('requests:list and broken ready.json cases', () => {
  it('treats a delivery folder without ready.json as still sent', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-ab12'
    await writeRequestFile(w.modFolder, id)
    await mkdir(join(w.modFolder, 'from-tyler', id, 'files'), { recursive: true })
    await writeFile(join(w.modFolder, 'from-tyler', id, 'files', 'wip.package'), 'partial')

    const list = await w.handlers['requests:list']()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, status: 'sent', delivery: null })
  })

  it('accepts uppercase .PACKAGE and .TS4SCRIPT extensions', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-cc01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, {
      title: 'Upper Mod',
      files: [
        { name: 'MY_MOD.PACKAGE', content: 'pkg' },
        { name: 'MY_SCRIPT.TS4SCRIPT', content: 'scr' }
      ]
    })

    const list = await w.handlers['requests:list']()
    expect(list[0]?.status).toBe('ready')
    expect(list[0]?.delivery?.hasScript).toBe(true)
  })

  const brokenCases: [string, (modFolder: string, id: string) => Promise<void>][] = [
    [
      'unparseable JSON',
      async (modFolder, id) => {
        await mkdir(join(modFolder, 'from-tyler', id, 'files'), { recursive: true })
        await writeFile(join(modFolder, 'from-tyler', id, 'ready.json'), '{not json')
      }
    ],
    [
      'wrong format',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.format = 2
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'wrong requestId',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.requestId = 'r-20261126-999999-zzzz'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'empty files array',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files = []
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'missing file on disk',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        await rm(join(modFolder, 'from-tyler', id, 'files', 'cozy_slippers.package'))
      }
    ],
    [
      'wrong extension (.exe)',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id, { files: [{ name: 'bad.exe', content: 'nope' }] })
      }
    ],
    [
      'slash in file name',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'sub/cozy.package'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'backslash in file name',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'sub\\cozy.package'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'dot-dot in file name',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'a..b.package'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'control character in file name',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'bad\u0007.package'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'Windows forbidden char in file name',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'bad:name.package'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'Windows reserved device name (CON.package)',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'CON.package'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'Windows reserved device name (LPT1.ts4script)',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].name = 'LPT1.ts4script'
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'case-insensitive duplicate names',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files.push({ ...data.files[0], name: 'COZY_SLIPPERS.package' })
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'size over decimal 200 MB (200_000_001 bytes)',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].bytes = 200_000_001
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'size mismatch with file on disk',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const p = join(modFolder, 'from-tyler', id, 'ready.json')
        const data = JSON.parse(await readFile(p, 'utf8'))
        data.files[0].bytes = data.files[0].bytes + 10
        await writeFile(p, JSON.stringify(data))
      }
    ],
    [
      'symlink inside files/',
      async (modFolder, id) => {
        await writeGoodDelivery(modFolder, id)
        const filePath = join(modFolder, 'from-tyler', id, 'files', 'cozy_slippers.package')
        const outside = join(modFolder, 'other.package')
        await writeFile(outside, 'DBPF-cozy-slippers-bytes')
        await rm(filePath)
        await symlink(outside, filePath, 'file')
      }
    ]
  ]

  it.each(brokenCases)('marks delivery broken and refuses install for: %s', async (_label, setup) => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-br01'
    await writeRequestFile(w.modFolder, id)
    await setup(w.modFolder, id)

    const list = await w.handlers['requests:list']()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, status: 'broken', delivery: null })

    const install = await w.handlers['requests:install']({ requestId: id })
    expect(install.status).toBe('refused')
    expect(await readdir(join(w.simsFolder, 'Mods'))).toEqual(['existing.package'])
  })
})

describe('requests:install and Undo', () => {
  it('installs a good delivery into Mods/From Tyler - <title>/ with backup + journal, and Undo removes it', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-ok01'
    await writeRequestFile(w.modFolder, id, { text: 'Make Sims react to outfits' })
    await writeGoodDelivery(w.modFolder, id, {
      title: 'Outfit Reactions',
      note: 'Sims now react to new outfits. Turn on script mods in Game Options.',
      files: [
        { name: 'outfit_reactions.package', content: 'DBPF-outfit-reactions' },
        { name: 'outfit_reactions.ts4script', content: 'PK-script-bytes' }
      ]
    })

    // Simulate restart before install
    resetModFolderRoot()

    const beforeList = await w.handlers['requests:list']()
    expect(beforeList[0]).toMatchObject({ id, status: 'ready' })
    expect(beforeList[0]?.delivery?.hasScript).toBe(true)

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')

    expect(outcome.entry.action).toBe('install-mod')
    expect(outcome.entry.status).toBe('done')
    expect(outcome.entry.undo).toBe('can-undo')
    expect(outcome.entry.hasScript).toBe(true)
    expect(outcome.entry.backupId).not.toBeNull()

    const destDir = join(w.simsFolder, 'Mods', 'From Tyler - Outfit Reactions')
    expect(await readFile(join(destDir, 'outfit_reactions.package'), 'utf8')).toBe('DBPF-outfit-reactions')
    expect(await readFile(join(destDir, 'outfit_reactions.ts4script'), 'utf8')).toBe('PK-script-bytes')
    // Source in shared folder stays untouched
    expect(await exists(join(w.modFolder, 'from-tyler', id, 'files', 'outfit_reactions.package'))).toBe(true)

    // requests:list now reports installed
    const afterInstall = await w.handlers['requests:list']()
    expect(afterInstall[0]?.status).toBe('installed')

    // Undo via safety.undo removes the files from Mods and returns request to ready
    const undone = await w.ctx.safety.undo(outcome.entry.id)
    expect(undone.status).toBe('done')
    expect(await exists(join(destDir, 'outfit_reactions.package'))).toBe(false)
    expect(await exists(join(destDir, 'outfit_reactions.ts4script'))).toBe(false)

    const afterUndo = await w.handlers['requests:list']()
    expect(afterUndo[0]?.status).toBe('ready')
  })

  it('refuses install on SHA-256 hash mismatch, installs nothing, and removes holding folder', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-hs01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, {
      title: 'Tampered Mod',
      files: [{ name: 'mod.package', content: 'original-bytes' }]
    })
    // Tamper file on disk with SAME byte length so size matches, but SHA-256 differs!
    await writeFile(join(w.modFolder, 'from-tyler', id, 'files', 'mod.package'), 'tampered-bytes')

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } })

    // Nothing touched in Mods
    expect(await readdir(join(w.simsFolder, 'Mods'))).toEqual(['existing.package'])
    // Holding cleaned up completely
    const holdingEntries = (await exists(w.holdingDir)) ? await readdir(w.holdingDir) : []
    expect(holdingEntries).toEqual([])
  })

  it('refuses install when target file already exists in Mods without overwriting and cleans holding', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-ex01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, {
      title: 'Cozy Slippers',
      files: [{ name: 'cozy_slippers.package', content: 'new-bytes' }]
    })
    const existingDest = join(w.simsFolder, 'Mods', 'From Tyler - Cozy Slippers', 'cozy_slippers.package')
    await mkdir(dirname(existingDest), { recursive: true })
    await writeFile(existingDest, 'her-existing-file')

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('refused')
    expect(await readFile(existingDest, 'utf8')).toBe('her-existing-file')
    const holdingEntries = (await exists(w.holdingDir)) ? await readdir(w.holdingDir) : []
    expect(holdingEntries).toEqual([])
  })

  it('refuses install while the game is running and cleans up holding', async () => {
    const w = await createWorld({ gameRunning: true })
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-gm01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id)

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'backup', reason: 'game-running' } })
    expect(await readdir(join(w.simsFolder, 'Mods'))).toEqual(['existing.package'])
    const holdingEntries = (await exists(w.holdingDir)) ? await readdir(w.holdingDir) : []
    expect(holdingEntries).toEqual([])
  })

  it('checks the game before copying anything from the shared folder into holding', async () => {
    const w = await createWorld({ gameRunning: true })
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-gm02'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id)

    const ops: string[] = []
    const realRun = w.ctx.gate.run.bind(w.ctx.gate)
    w.ctx.gate.run = async (req) => {
      for (const op of req.ops) ops.push(op.op)
      return realRun(req)
    }

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'backup', reason: 'game-running' } })
    expect(ops).toEqual([])
    expect(await exists(w.holdingDir)).toBe(false)
  })

  it('refuses when the new holding folder already exists and never removes it', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-hc01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id)

    // The id the install will get next already has a holding folder from an older entry.
    const older = join(w.holdingDir, '20261126-143000-0001', 'Mods', 'older.package')
    await mkdir(dirname(older), { recursive: true })
    await writeFile(older, 'older-entry-copy')

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('refused')
    expect(await readFile(older, 'utf8')).toBe('older-entry-copy')
    expect(await readdir(join(w.simsFolder, 'Mods'))).toEqual(['existing.package'])
  })

  it('refuses install while a 50/50 test is running', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    await writeFile(join(w.stateDir, 'fiftyfifty.json'), JSON.stringify({ phase: 'awaiting-answer' }))
    const id = 'r-20261126-143000-ff01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id)

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome).toEqual({ status: 'refused', refusal: { why: 'fifty-fifty-running' } })
  })

  it('sanitizes unsafe Windows characters and reserved names in the mod title', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-sn01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, {
      title: 'CON',
      files: [{ name: 'safe.package', content: 'safe-bytes' }]
    })

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('done')
    expect(await exists(join(w.simsFolder, 'Mods', `From Tyler - ${id}`, 'safe.package'))).toBe(true)
  })

  it('installs a script mod one folder deep so the game loads it and the scanner finds no script-too-deep', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-sd01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, {
      title: 'Outfit Reactions',
      files: [
        { name: 'outfit_reactions.package', content: 'DBPF-outfit-reactions' },
        { name: 'outfit_reactions.ts4script', content: 'PK-script-bytes' }
      ]
    })

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('done')

    const inventory = await buildInventory({
      modsDir: join(w.simsFolder, 'Mods'),
      curseForgeInstanceFile: null
    })
    const script = inventory.files.find((f) => f.relPath.endsWith('outfit_reactions.ts4script'))
    expect(script?.kind).toBe('script')
    expect(script?.depth).toBe(1)
    expect(scriptTooDeep({ inventory } as unknown as Parameters<typeof scriptTooDeep>[0])).toEqual([])
  })

  it('keeps the From Tyler folder name a safe Windows folder name even for a very long title', async () => {
    const title = `${'Very Long Mod Title '.repeat(20)}. `
    const name = safeModFolderName(title, 'r-20261126-143000-lt01')
    expect(name.startsWith('From Tyler - ')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(100)
    expect(name).not.toMatch(/[. ]$/)
    expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
    expect(safeModFolderName('CON', 'r-20261126-143000-lt01')).toBe('From Tyler - r-20261126-143000-lt01')
    expect(safeModFolderName('a/b:c', 'r-20261126-143000-lt01')).toBe('From Tyler - a b c')
  })

  it('keeps status installed even if the delivery folder is later broken or removed', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-kp01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, { title: 'Cozy Rugs' })

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('done')

    // Corrupt ready.json after install
    await writeFile(join(w.modFolder, 'from-tyler', id, 'ready.json'), '{broken json')
    const afterBreak = await w.handlers['requests:list']()
    expect(afterBreak[0]?.status).toBe('installed')

    // Remove delivery folder completely
    await rm(join(w.modFolder, 'from-tyler', id), { recursive: true, force: true })
    const afterRemove = await w.handlers['requests:list']()
    expect(afterRemove[0]?.status).toBe('installed')
  })

  it('does not attempt a fresh install when an existing install-mod journal entry needs attention', async () => {
    const w = await createWorld()
    await saveModFolderState(w, w.modFolder)
    const id = 'r-20261126-143000-na01'
    await writeRequestFile(w.modFolder, id)
    await writeGoodDelivery(w.modFolder, id, { title: 'Half Installed Mod' })

    await mkdir(w.ctx.paths.journalDir, { recursive: true })
    await writeFile(
      join(w.ctx.paths.journalDir, '20261126-143100-0001.json'),
      JSON.stringify({
        id: '20261126-143100-0001',
        at: '2026-11-26T14:31:00.000Z',
        action: 'install-mod',
        summary: 'Installed Half Installed Mod',
        origin: { by: 'fix' },
        folderPath: w.simsFolder,
        groupId: `request:${id}`,
        groupLabel: 'Half Installed Mod',
        hasScript: false,
        backupId: 'b1',
        steps: [],
        status: 'needs-attention',
        undo: 'can-undo',
        undoneAt: null
      })
    )

    const outcome = await w.handlers['requests:install']({ requestId: id })
    expect(outcome.status).toBe('stopped-part-way')
    if (outcome.status === 'stopped-part-way') {
      expect(outcome.detail).toMatch(/History/i)
    }
    expect(await readdir(join(w.simsFolder, 'Mods'))).toEqual(['existing.package'])
  })
})
