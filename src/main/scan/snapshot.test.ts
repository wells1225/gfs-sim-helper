// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameInstall, Inventory, ModFile, ModGroup, Scan } from '../../shared/model.ts'
import { sampleFinding, sampleScan } from '../../shared/testing/sample.ts'
import { appPaths } from '../app-paths.ts'
import type { Host } from '../locate/host.ts'
import type { AppContext, Gate, WriteRequest } from '../ports.ts'
import { makeRedactor } from '../redact.ts'
import { scanHandlers } from './handlers.ts'
import {
  buildScanSnapshot,
  diffScanSnapshots,
  folderFingerprint,
  groupFingerprint,
  MAX_SNAPSHOT_BYTES,
  readScanSnapshot,
  recordScanSnapshot,
  sanitizeSnapshotLabel,
  snapshotPathFor
} from './snapshot.ts'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

function makeModGroup(opts: {
  id: string
  label: string
  hasScript?: boolean
  files?: Array<{ relPath: string; bytes: number; modifiedAt: string }>
  curseForge?: ModGroup['curseForge']
}): { group: ModGroup; files: ModFile[] } {
  const hasScript = opts.hasScript ?? false
  const rawFiles = opts.files ?? [
    {
      relPath: hasScript ? `${opts.label}/mod.ts4script` : `${opts.label}/item.package`,
      bytes: 1024,
      modifiedAt: '2026-11-20T10:00:00.000Z'
    }
  ]

  const files: ModFile[] = rawFiles.map((f) => {
    const isScript = f.relPath.toLowerCase().endsWith('.ts4script')
    const base = {
      relPath: f.relPath,
      bytes: f.bytes,
      modifiedAt: f.modifiedAt,
      hash: { status: 'not-needed' as const },
      groupId: opts.id,
      depth: f.relPath.split('/').length - 1
    }
    if (isScript) {
      return { ...base, kind: 'script', script: { status: 'ok', entries: ['mod.pyc'] } }
    }
    return { ...base, kind: 'package', dbpf: { status: 'ok', keyCount: 4 } }
  })

  const group: ModGroup = {
    id: opts.id,
    label: opts.label,
    source: opts.curseForge ? 'curseforge' : 'folder',
    files: files.map((f) => f.relPath),
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    hasScript,
    curseForge: opts.curseForge ?? null
  }

  return { group, files }
}

function makeInventory(
  modsDir: string,
  entries: Array<{ group: ModGroup; files: ModFile[] }>
): Inventory {
  const base = sampleScan().inventory
  return {
    ...base,
    modsDir,
    files: entries.flatMap((e) => e.files).sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)),
    groups: entries.map((e) => e.group)
  }
}

async function makeEnv() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sims-helper-snapshot-')))
  tempDirs.push(root)

  const userDir = join(root, 'Users', 'Lila')
  const documentsDir = join(userDir, 'Documents')
  const simsDir = join(documentsDir, 'Electronic Arts', 'The Sims 4')
  const modsDir = join(simsDir, 'Mods')
  const desktopDir = join(userDir, 'Desktop')
  const localAppData = join(userDir, 'AppData', 'Local')
  const appData = join(userDir, 'AppData', 'Roaming')

  await Promise.all([
    mkdir(modsDir, { recursive: true }),
    mkdir(desktopDir, { recursive: true }),
    mkdir(localAppData, { recursive: true })
  ])
  await writeFile(join(simsDir, 'Options.ini'), '[options]\nmodsdisabled = 0\n', 'utf8')

  const paths = appPaths({ localAppData, appData, desktopDir })
  const gateRequests: WriteRequest[] = []

  const defaultGateRun: Gate['run'] = async (request) => {
    gateRequests.push(request)
    for (const op of request.ops) {
      if (op.op === 'mkdir') {
        await mkdir(op.path, { recursive: true })
      } else if (op.op === 'write') {
        await writeFile(op.path, op.data)
      }
    }
    return { status: 'done' }
  }

  let now = new Date('2026-11-20T12:00:00.000Z')
  let currentInventory = sampleScan({
    folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-20T11:00:00.000Z') }
  }).inventory
  let currentGame: GameInstall | null = {
    path: join(root, 'Program Files', 'EA Games', 'The Sims 4'),
    version: '1.128.10.1030',
    packs: ['EP01']
  }

  const host: Host = {
    documentsDir,
    env: { USERNAME: 'Lila', USERPROFILE: userDir },
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

  // Put a GameVersion.txt so locate() or game info can be overridden cleanly via scan setup
  const gameVersionPath = join(simsDir, 'GameVersion.txt')
  await writeFile(gameVersionPath, '1.128.10.1030', 'utf8')

  const base = sampleScan()
  const clock = { now: () => now }

  const ctx: AppContext = {
    host,
    clock,
    paths,
    newId: () => '20261120-120000-1122',
    redact: makeRedactor(host.env),
    gameState: async () => 'not-running',
    scan: {
      buildInventory: async () => currentInventory,
      readLogs: async () => [],
      readFolderFacts: async () => base.facts,
      runRules: () => [sampleFinding()],
      clock,
      newId: () => '20261120-120000-1122',
      paths
    },
    gate: { run: defaultGateRun },
    safety: {} as AppContext['safety'],
    fixes: {} as AppContext['fixes'],
    keyStore: {} as AppContext['keyStore'],
    updater: {} as AppContext['updater'],
    share: {} as AppContext['share'],
    pickFolder: async () => null,
    openWeb: async () => 'refused',
    startupRecovery: async () => ({ status: 'finished', touched: [] }),
    busy: () => false,
    session: { scan: null },
    emit: () => {},
    reveal: () => {}
  }

  return {
    root,
    userDir,
    simsDir,
    modsDir,
    stateDir: paths.stateDir,
    ctx,
    gateRequests,
    defaultGateRun,
    setNow: (iso: string) => {
      now = new Date(iso)
    },
    setInventory: (inv: Inventory) => {
      currentInventory = inv
    },
    setGame: (game: GameInstall | null) => {
      currentGame = game
    },
    getGame: () => currentGame
  }
}

describe('scan snapshot persistence and diff', () => {
  it('first scan returns changes: null and writes a compact non-PII snapshot through gate.run', async () => {
    const { root, simsDir, modsDir, stateDir, ctx, gateRequests } = await makeEnv()
    const handlers = scanHandlers(ctx)

    const result = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(result.status).toBe('done')
    if (result.status !== 'done') return

    expect(result.scan.changes).toBeNull()
    expect(ctx.session.scan?.changes).toBeNull()

    expect(gateRequests).toHaveLength(1)
    expect(gateRequests[0]?.reason).toBe('state')
    expect(gateRequests[0]?.folderPath).toBeNull()

    const expectedHash = folderFingerprint(simsDir)
    const expectedPath = snapshotPathFor(stateDir, expectedHash)
    expect(expectedPath).toBe(join(stateDir, `last-scan-${expectedHash.slice(0, 16)}.json`))

    const raw = await readFile(expectedPath, 'utf8')
    // Must never contain raw OS paths, modsDir, game path, or usernames
    expect(raw).not.toContain(simsDir)
    expect(raw).not.toContain(modsDir)
    expect(raw).not.toContain(root)
    expect(raw).not.toContain('Lila')
    expect(raw).not.toContain('Users')
    expect(raw).not.toContain('Documents')

    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['format']).toBe(1)
    expect(parsed['folderHash']).toBe(expectedHash)
    expect(parsed['at']).toBe(result.scan.at)
    expect(Array.isArray(parsed['groups'])).toBe(true)
  })

  it('detects game version update, added, updated (bytes/mtime/fileId/filesDigest), and removed mods sorted script-first', () => {
    const simsDir = 'C:\\Users\\Lila\\Documents\\Electronic Arts\\The Sims 4'
    const modsDir = `${simsDir}\\Mods`

    const gKeep = makeModGroup({ id: 'dir:keep', label: 'Keep Me' })
    const gUpdateBytes = makeModGroup({
      id: 'dir:zebra-bytes',
      label: 'Zebra Bytes',
      files: [{ relPath: 'Zebra/a.package', bytes: 1000, modifiedAt: '2026-11-10T00:00:00.000Z' }]
    })
    const gUpdateMtime = makeModGroup({
      id: 'dir:alpha-mtime',
      label: 'Alpha Mtime',
      files: [{ relPath: 'Alpha/a.package', bytes: 1000, modifiedAt: '2026-11-10T00:00:00.000Z' }]
    })
    const gUpdateFileId = makeModGroup({
      id: 'cf:100',
      label: 'Curse Script',
      hasScript: true,
      files: [{ relPath: 'CurseScript/a.ts4script', bytes: 500, modifiedAt: '2026-11-10T00:00:00.000Z' }],
      curseForge: { addonId: 100, fileId: 1001, fileDate: '2026-11-10T00:00:00.000Z' }
    })
    const gUpdateDigest = makeModGroup({
      id: 'dir:digest',
      label: 'Digest Split',
      files: [
        { relPath: 'Digest/a.package', bytes: 500, modifiedAt: '2026-11-10T00:00:00.000Z' },
        { relPath: 'Digest/b.package', bytes: 500, modifiedAt: '2026-11-10T00:00:00.000Z' }
      ]
    })
    const gRemovedCc = makeModGroup({ id: 'dir:removed-cc', label: 'Aardvark Hair' })
    const gRemovedScript = makeModGroup({ id: 'dir:removed-script', label: 'Zed Script', hasScript: true })

    const scan1: Scan = sampleScan({
      at: '2026-11-20T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-20T11:00:00.000Z') },
      game: { path: 'C:\\Program Files\\EA Games\\The Sims 4', version: '1.128.10.1030', packs: [] },
      inventory: makeInventory(modsDir, [
        gKeep,
        gUpdateBytes,
        gUpdateMtime,
        gUpdateFileId,
        gUpdateDigest,
        gRemovedCc,
        gRemovedScript
      ])
    })

    const gUpdateBytes2 = makeModGroup({
      id: 'dir:zebra-bytes',
      label: 'Zebra Bytes',
      files: [{ relPath: 'Zebra/a.package', bytes: 2048, modifiedAt: '2026-11-10T00:00:00.000Z' }]
    })
    const gUpdateMtime2 = makeModGroup({
      id: 'dir:alpha-mtime',
      label: 'Alpha Mtime',
      files: [{ relPath: 'Alpha/a.package', bytes: 1000, modifiedAt: '2026-11-21T00:00:00.000Z' }]
    })
    const gUpdateFileId2 = makeModGroup({
      id: 'cf:100',
      label: 'Curse Script',
      hasScript: true,
      files: [{ relPath: 'CurseScript/a.ts4script', bytes: 500, modifiedAt: '2026-11-10T00:00:00.000Z' }],
      curseForge: { addonId: 100, fileId: 1002, fileDate: '2026-11-10T00:00:00.000Z' }
    })
    // Same fileCount (2), same total bytes (1000), same latestModifiedAt, null fileId/fileDate,
    // but internal file split changed -> caught by filesDigest!
    const gUpdateDigest2 = makeModGroup({
      id: 'dir:digest',
      label: 'Digest Split',
      files: [
        { relPath: 'Digest/a.package', bytes: 400, modifiedAt: '2026-11-10T00:00:00.000Z' },
        { relPath: 'Digest/b.package', bytes: 600, modifiedAt: '2026-11-10T00:00:00.000Z' }
      ]
    })
    const gAddedCc = makeModGroup({ id: 'dir:added-cc', label: 'Aardvark Shoes' })
    const gAddedScript = makeModGroup({ id: 'dir:added-script', label: 'Zed Helper', hasScript: true })
    const gAddedSameLabelB = makeModGroup({ id: 'dir:same-b', label: 'Same Name' })
    const gAddedSameLabelA = makeModGroup({ id: 'dir:same-a', label: 'same name' })

    const scan2: Scan = sampleScan({
      at: '2026-11-24T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-24T11:00:00.000Z') },
      game: { path: 'C:\\Program Files\\EA Games\\The Sims 4', version: '1.129.39.1030', packs: [] },
      inventory: makeInventory(modsDir, [
        gKeep,
        gUpdateBytes2,
        gUpdateMtime2,
        gUpdateFileId2,
        gUpdateDigest2,
        gAddedCc,
        gAddedScript,
        gAddedSameLabelB,
        gAddedSameLabelA
      ])
    })

    const prev = buildScanSnapshot(scan1)
    const next = buildScanSnapshot(scan2)
    const changes = diffScanSnapshots(prev, next, scan2.inventory.groups)

    expect(changes.sinceAt).toBe('2026-11-20T12:00:00.000Z')
    expect(changes.gameVersion).toEqual({ from: '1.128.10.1030', to: '1.129.39.1030' })

    // Script mods first, then label.toLowerCase(), then groupId
    expect(changes.added).toEqual([
      { groupId: 'dir:added-script', label: 'Zed Helper', hasScript: true },
      { groupId: 'dir:added-cc', label: 'Aardvark Shoes', hasScript: false },
      { groupId: 'dir:same-a', label: 'same name', hasScript: false },
      { groupId: 'dir:same-b', label: 'Same Name', hasScript: false }
    ])
    expect(changes.updated).toEqual([
      { groupId: 'cf:100', label: 'Curse Script', hasScript: true },
      { groupId: 'dir:alpha-mtime', label: 'Alpha Mtime', hasScript: false },
      { groupId: 'dir:digest', label: 'Digest Split', hasScript: false },
      { groupId: 'dir:zebra-bytes', label: 'Zebra Bytes', hasScript: false }
    ])
    expect(changes.removed).toEqual([
      { groupId: `removed:${groupFingerprint('dir:removed-script').slice(0, 16)}`, label: 'Zed Script', hasScript: true },
      { groupId: `removed:${groupFingerprint('dir:removed-cc').slice(0, 16)}`, label: 'Aardvark Hair', hasScript: false }
    ])
  })

  it('second scan with no changes returns changes with sinceAt and empty arrays', async () => {
    const { simsDir, ctx, setNow } = await makeEnv()
    const handlers = scanHandlers(ctx)

    setNow('2026-11-20T12:00:00.000Z')
    const first = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(first.status).toBe('done')
    if (first.status !== 'done') return
    expect(first.scan.changes).toBeNull()

    setNow('2026-11-22T15:30:00.000Z')
    const second = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(second.status).toBe('done')
    if (second.status !== 'done') return

    expect(second.scan.changes).toEqual({
      sinceAt: '2026-11-20T12:00:00.000Z',
      gameVersion: null,
      added: [],
      updated: [],
      removed: []
    })
  })

  it('falls back cleanly to null on corrupt JSON, wrong format, mismatched folderHash, symlinked file, symlinked stateDir, and >2MB file', async () => {
    const { root, simsDir, stateDir } = await makeEnv()
    const expectedHash = folderFingerprint(simsDir)
    const snapPath = snapshotPathFor(stateDir, expectedHash)
    await mkdir(stateDir, { recursive: true })

    // 1. Corrupt JSON
    await writeFile(snapPath, '{not valid json', 'utf8')
    expect(await readScanSnapshot(stateDir, expectedHash)).toBeNull()

    // 2. Wrong format
    const validSnap = buildScanSnapshot(
      sampleScan({ folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-20T11:00:00.000Z') } })
    )
    await writeFile(snapPath, JSON.stringify({ ...validSnap, format: 2 }), 'utf8')
    expect(await readScanSnapshot(stateDir, expectedHash)).toBeNull()

    // 3. Mismatched folderHash
    await writeFile(snapPath, JSON.stringify({ ...validSnap, folderHash: '0'.repeat(64) }), 'utf8')
    expect(await readScanSnapshot(stateDir, expectedHash)).toBeNull()

    // 4. >2 MB snapshot file
    const huge = `${JSON.stringify(validSnap)}${' '.repeat(2 * 1024 * 1024 + 64)}`
    await writeFile(snapPath, huge, 'utf8')
    expect(await readScanSnapshot(stateDir, expectedHash)).toBeNull()

    // 5. Symlinked snapshot file
    const outsideFile = join(root, 'outside-snap.json')
    await writeFile(outsideFile, JSON.stringify(validSnap), 'utf8')
    await rm(snapPath, { force: true })
    await symlink(outsideFile, snapPath)
    expect(await readScanSnapshot(stateDir, expectedHash)).toBeNull()

    // 6. Symlinked stateDir
    const realElsewhere = join(root, 'elsewhere-state')
    await mkdir(realElsewhere, { recursive: true })
    await writeFile(snapshotPathFor(realElsewhere, expectedHash), JSON.stringify(validSnap), 'utf8')
    const symlinkedStateDir = join(root, 'symlinked-state')
    await symlink(realElsewhere, symlinkedStateDir)
    expect(await readScanSnapshot(symlinkedStateDir, expectedHash)).toBeNull()
  })

  it('still returns status done when gate.run refuses or fails snapshot write', async () => {
    const { simsDir, ctx } = await makeEnv()
    ctx.gate = {
      async run() {
        return { status: 'refused', refusal: { reason: 'check-failed', path: '' } }
      }
    }
    const handlers = scanHandlers(ctx)
    const refusedRes = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(refusedRes.status).toBe('done')
    if (refusedRes.status === 'done') {
      expect(refusedRes.scan.changes).toBeNull()
    }

    ctx.gate = {
      async run() {
        return { status: 'failed', opsDone: 0, detail: 'ENOSPC' }
      }
    }
    const failedRes = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(failedRes.status).toBe('done')
    if (failedRes.status === 'done') {
      expect(failedRes.scan.changes).toBeNull()
    }
  })

  it('serializes concurrent back-to-back scans for the same folder so a scan never diffs against itself', async () => {
    const { simsDir, modsDir, ctx, defaultGateRun, setInventory, setNow } = await makeEnv()

    const g1 = makeModGroup({ id: 'dir:first', label: 'First Mod' })
    const g2 = makeModGroup({ id: 'dir:second', label: 'Second Mod' })

    let gateCall = 0
    let releaseFirstWrite!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => {
      ctx.gate = {
        async run(request) {
          gateCall += 1
          if (gateCall === 1) {
            resolve()
            await new Promise<void>((r) => {
              releaseFirstWrite = r
            })
          }
          return defaultGateRun(request)
        }
      }
    })

    const handlers = scanHandlers(ctx)

    // Start first scan with [g1]
    setNow('2026-11-20T12:00:00.000Z')
    setInventory(makeInventory(modsDir, [g1]))
    const p1 = handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })

    // Wait until scan 1 has read (none) and is mid-write inside gate.run
    await firstWriteStarted

    // Start second scan with [g1, g2] while scan 1 is still writing
    setNow('2026-11-20T12:05:00.000Z')
    setInventory(makeInventory(modsDir, [g1, g2]))
    const p2 = handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })

    // Let scan 2 finish runScan and queue behind scan 1's snapshot lock
    await new Promise((r) => setTimeout(r, 20))
    releaseFirstWrite()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('done')
    expect(r2.status).toBe('done')
    if (r1.status !== 'done' || r2.status !== 'done') return

    expect(r1.scan.changes).toBeNull()
    expect(r2.scan.changes).toEqual({
      sinceAt: '2026-11-20T12:00:00.000Z',
      gameVersion: null,
      added: [{ groupId: 'dir:second', label: 'Second Mod', hasScript: false }],
      updated: [],
      removed: []
    })
  })

  it('skips writing and returns null when recording a scan older than the persisted snapshot', async () => {
    const { simsDir, modsDir, stateDir, ctx, gateRequests } = await makeEnv()
    const expectedHash = folderFingerprint(simsDir)

    const gNew = makeModGroup({ id: 'dir:newer', label: 'Newer Mod' })
    const gOld = makeModGroup({ id: 'dir:older', label: 'Older Mod' })

    const newerScan = sampleScan({
      at: '2026-11-24T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-24T11:00:00.000Z') },
      inventory: makeInventory(modsDir, [gNew])
    })
    const olderScan = sampleScan({
      at: '2026-11-20T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-20T11:00:00.000Z') },
      inventory: makeInventory(modsDir, [gOld])
    })

    expect(await recordScanSnapshot(ctx.gate, stateDir, newerScan)).toBeNull()
    expect(gateRequests).toHaveLength(1)
    gateRequests.length = 0

    const staleChanges = await recordScanSnapshot(ctx.gate, stateDir, olderScan)
    expect(staleChanges).toBeNull()
    expect(gateRequests).toHaveLength(0)

    const persisted = await readScanSnapshot(stateDir, expectedHash)
    expect(persisted?.at).toBe('2026-11-24T12:00:00.000Z')
    expect(persisted?.groups).toHaveLength(1)
  })

  it('skips writing a snapshot over 2 MB while still returning changes and keeping the prior baseline intact', async () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024)
    const { simsDir, modsDir, stateDir, ctx, gateRequests } = await makeEnv()
    const expectedHash = folderFingerprint(simsDir)

    const gBase = makeModGroup({ id: 'dir:base', label: 'Base Mod' })
    const scan1 = sampleScan({
      at: '2026-11-20T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-20T11:00:00.000Z') },
      inventory: makeInventory(modsDir, [gBase])
    })

    expect(await recordScanSnapshot(ctx.gate, stateDir, scan1)).toBeNull()
    expect(gateRequests).toHaveLength(1)
    gateRequests.length = 0

    // Construct a snapshot whose serialized UTF-8 byte length exceeds 2 MiB
    const longLabel = 'M'.repeat(450)
    const hugeEntries = [gBase]
    for (let i = 0; i < 4_500; i += 1) {
      hugeEntries.push(makeModGroup({ id: `dir:bulk-${i}`, label: `${longLabel}-${i}` }))
    }
    const scan2 = sampleScan({
      at: '2026-11-21T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-21T11:00:00.000Z') },
      inventory: makeInventory(modsDir, hugeEntries)
    })

    const changes = await recordScanSnapshot(ctx.gate, stateDir, scan2)
    expect(gateRequests).toHaveLength(0)
    expect(changes).not.toBeNull()
    expect(changes?.sinceAt).toBe('2026-11-20T12:00:00.000Z')
    expect(changes?.added).toHaveLength(4_500)
    expect(changes?.removed).toEqual([])

    const persisted = await readScanSnapshot(stateDir, expectedHash)
    expect(persisted?.at).toBe('2026-11-20T12:00:00.000Z')
    expect(persisted?.groups).toHaveLength(1)

    // Also verify custom maxBytes cap skips writing while preserving baseline
    const gSmall = makeModGroup({ id: 'dir:small-added', label: 'Small Added' })
    const scan3 = sampleScan({
      at: '2026-11-22T12:00:00.000Z',
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-22T11:00:00.000Z') },
      inventory: makeInventory(modsDir, [gBase, gSmall])
    })
    const cappedChanges = await recordScanSnapshot(ctx.gate, stateDir, scan3, { maxBytes: 100 })
    expect(gateRequests).toHaveLength(0)
    expect(cappedChanges?.added).toEqual([{ groupId: 'dir:small-added', label: 'Small Added', hasScript: false }])
    expect((await readScanSnapshot(stateDir, expectedHash))?.at).toBe('2026-11-20T12:00:00.000Z')
  })

  it('sanitizeSnapshotLabel preserves normal mod names while redacting usernames and emails', () => {
    const redact = makeRedactor({ USERNAME: 'Lila', USERPROFILE: 'C:\\Users\\Lila' })
    expect(sanitizeSnapshotLabel('Wicked Wardrobe', redact)).toBe('Wicked Wardrobe')
    expect(sanitizeSnapshotLabel('MCCC', redact)).toBe('MCCC')
    expect(sanitizeSnapshotLabel('Cozy Hair', redact)).toBe('Cozy Hair')
    expect(sanitizeSnapshotLabel('Lilac Hair', redact)).toBe('Lilac Hair')
    expect(sanitizeSnapshotLabel('(Lila)', redact)).toBe('(<user>)')
    expect(sanitizeSnapshotLabel("Lila's Backup", redact)).toBe("<user>'s Backup")
    expect(sanitizeSnapshotLabel('Lila_CC_Pack', redact)).toBe('<user>_CC_Pack')
    expect(sanitizeSnapshotLabel('foo.Lila', redact)).toBe('foo.<user>')
    expect(sanitizeSnapshotLabel('Custom by Lila (lila.sims@example.com)', redact)).toBe('Custom by <user> (<email>)')
    expect(sanitizeSnapshotLabel('user@sub.example.co.uk', redact)).toBe('<email>')
    expect(sanitizeSnapshotLabel('user@example.com...more', redact)).toBe('<email>...more')
    expect(sanitizeSnapshotLabel('Pack@user@example.com', redact)).toBe('Pack@<email>')
    expect(sanitizeSnapshotLabel('a@b@c@user@example.com', redact)).toBe('a@b@c@<email>')
    expect(sanitizeSnapshotLabel('Mod@2', redact)).toBe('Mod@2')
    expect(sanitizeSnapshotLabel('Mod@2.0', redact)).toBe('Mod@2.0')
    expect(sanitizeSnapshotLabel('Mod@1.2.3', redact)).toBe('Mod@1.2.3')
  })

  it('sanitizeSnapshotLabel scans emails and redacts punctuation-heavy labels in linear time', () => {
    const longNoAt = 'a'.repeat(50_000)
    const longTrailingAt = `${'a'.repeat(50_000)}@`
    const repeatedAt = 'a@'.repeat(25_000)

    const start = performance.now()
    expect(sanitizeSnapshotLabel(longNoAt)).toBe(longNoAt)
    expect(sanitizeSnapshotLabel(longTrailingAt)).toBe(longTrailingAt)
    expect(sanitizeSnapshotLabel(repeatedAt)).toBe(repeatedAt)
    const elapsedMs = performance.now() - start
    expect(elapsedMs).toBeLessThan(50)

    const redact = makeRedactor({ USERNAME: 'Lila' })
    const longParens = `${'('.repeat(50_000)}Lila`
    const longPunct = `${'-!'.repeat(25_000)}Lila`

    const dotRedact = makeRedactor({ USERNAME: 'lila.smith' })
    const longPunctDot = `${'-!'.repeat(25_000)}lila.smith`

    const redactStart = performance.now()
    expect(sanitizeSnapshotLabel(longParens, redact)).toBe(`${'('.repeat(50_000)}<user>`)
    expect(sanitizeSnapshotLabel(longPunct, redact)).toBe(`${'-!'.repeat(25_000)}<user>`)
    expect(sanitizeSnapshotLabel(longPunctDot, dotRedact)).toBe(`${'-!'.repeat(25_000)}<user>`)
    const redactElapsedMs = performance.now() - redactStart
    expect(redactElapsedMs).toBeLessThan(50)
  })

  it('redacts usernames with leading punctuation, dots, and Unicode email addresses in persisted snapshot labels', () => {
    const redact = makeRedactor({ USERNAME: '_Lila', USERPROFILE: 'C:\\Users\\_Lila' })
    expect(sanitizeSnapshotLabel('_Lila Mods', redact)).toBe('<user> Mods')
    expect(sanitizeSnapshotLabel('(_Lila)', redact)).toBe('(<user>)')
    expect(sanitizeSnapshotLabel('李@example.com', redact)).toBe('<email>')
    expect(sanitizeSnapshotLabel('Custom by 李@example.com', redact)).toBe('Custom by <email>')

    const dotRedact = makeRedactor({ USERNAME: 'lila.smith' })
    expect(sanitizeSnapshotLabel('lila.smith Mods', dotRedact)).toBe('<user> Mods')
    expect(sanitizeSnapshotLabel('(lila.smith)', dotRedact)).toBe('(<user>)')
    expect(sanitizeSnapshotLabel('-!lila.smith', dotRedact)).toBe('-!<user>')
    expect(sanitizeSnapshotLabel('foo-lila.smith', dotRedact)).toBe('foo-<user>')

    const shortRedact = makeRedactor({ USERNAME: 'Ann' })
    expect(sanitizeSnapshotLabel('Annabelle', shortRedact)).toBe('Annabelle')
    expect(sanitizeSnapshotLabel('_Ann Mods', shortRedact)).toBe('_<user> Mods')

    const simsDir = 'C:\\Users\\_Lila\\Documents\\Electronic Arts\\The Sims 4'
    const modsDir = `${simsDir}\\Mods`
    const punctUserMod = makeModGroup({ id: 'dir:_lila mods', label: '_Lila Mods' })
    const unicodeEmailMod = makeModGroup({ id: 'dir:unicode-email', label: 'Pack (李@example.com)' })
    const scan = sampleScan({
      folder: { path: simsDir, inOneDrive: false, newestFileAt: new Date('2026-11-20T11:00:00.000Z') },
      inventory: makeInventory(modsDir, [punctUserMod, unicodeEmailMod])
    })

    const snapshot = buildScanSnapshot(scan, redact)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('_Lila')
    expect(serialized).not.toContain('李@example.com')
    expect(snapshot.groups.map((g) => g.label).sort()).toEqual(['<user> Mods', 'Pack (<email>)'])
  })

  it('hashes group IDs and strips usernames and emails from persisted snapshots while diffing cleanly', async () => {
    const { simsDir, modsDir, stateDir, ctx, setInventory, setNow } = await makeEnv()
    const handlers = scanHandlers(ctx)

    const normalMod = makeModGroup({ id: 'dir:wicked wardrobe', label: 'Wicked Wardrobe' })
    const personalDirMod = makeModGroup({
      id: 'dir:lila mods (lila.sims@example.com)',
      label: 'Lila Mods (lila.sims@example.com)',
      files: [{ relPath: 'Lila Mods/hair.package', bytes: 1024, modifiedAt: '2026-11-20T10:00:00.000Z' }]
    })
    const personalFileMod = makeModGroup({
      id: 'file:custom by lila - lila.sims@example.com.package',
      label: 'Custom by Lila - lila.sims@example.com',
      files: [{ relPath: 'Custom by Lila - lila.sims@example.com.package', bytes: 512, modifiedAt: '2026-11-20T10:00:00.000Z' }]
    })

    setNow('2026-11-20T12:00:00.000Z')
    setInventory(makeInventory(modsDir, [normalMod, personalDirMod, personalFileMod]))
    const first = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(first.status).toBe('done')

    const snapPath = snapshotPathFor(stateDir, folderFingerprint(simsDir))
    const raw = await readFile(snapPath, 'utf8')
    expect(raw.toLowerCase()).not.toContain('lila')
    expect(raw).not.toContain('lila.sims@example.com')
    expect(raw).not.toContain('dir:')
    expect(raw).not.toContain('file:')
    expect(raw).toContain('Wicked Wardrobe')
    expect(raw).toContain('<user>')
    expect(raw).toContain('<email>')

    const parsed = JSON.parse(raw) as { groups: Array<Record<string, unknown>> }
    for (const g of parsed.groups) {
      expect(typeof g['idHash']).toBe('string')
      expect(g['idHash']).toMatch(/^[0-9a-f]{64}$/)
      expect(g['id']).toBeUndefined()
    }

    // Second scan: update personalDirMod, remove personalFileMod, add Cozy Hair
    const personalDirModUpdated = makeModGroup({
      id: 'dir:lila mods (lila.sims@example.com)',
      label: 'Lila Mods (lila.sims@example.com)',
      files: [{ relPath: 'Lila Mods/hair.package', bytes: 2048, modifiedAt: '2026-11-21T10:00:00.000Z' }]
    })
    const addedMod = makeModGroup({ id: 'dir:cozy hair', label: 'Cozy Hair' })

    setNow('2026-11-21T12:00:00.000Z')
    setInventory(makeInventory(modsDir, [normalMod, personalDirModUpdated, addedMod]))
    const second = await handlers['scan:run']({ folderPath: simsDir, symptom: 'closes' })
    expect(second.status).toBe('done')
    if (second.status !== 'done') return

    const removedHash = createHash('sha256')
      .update('file:custom by lila - lila.sims@example.com.package')
      .digest('hex')
    expect(second.scan.changes).toEqual({
      sinceAt: '2026-11-20T12:00:00.000Z',
      gameVersion: null,
      added: [{ groupId: 'dir:cozy hair', label: 'Cozy Hair', hasScript: false }],
      updated: [
        {
          groupId: 'dir:lila mods (lila.sims@example.com)',
          label: 'Lila Mods (lila.sims@example.com)',
          hasScript: false
        }
      ],
      removed: [
        {
          groupId: `removed:${removedHash.slice(0, 16)}`,
          label: 'Custom by <user> - <email>',
          hasScript: false
        }
      ]
    })
  })
})
