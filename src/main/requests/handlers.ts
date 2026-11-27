import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handlers } from '../../shared/ipc.ts'
import type { FixOutcome, JournalEntry, ModRequest, ModRequestSent } from '../../shared/model.ts'
import { sha256File } from '../fs-read.ts'
import { locate } from '../locate/index.ts'
import type { ActionPlan, AppContext, WriteOp } from '../ports.ts'
import { oneAtATime } from '../safety/lock.ts'
import { exists } from '../safety/where.ts'
import { readDelivery } from './delivery.ts'
import { pickAndSaveModFolder, syncModFolder } from './folder.ts'
import {
  MAX_FILE_BYTES,
  MAX_MODS,
  MAX_MOD_CHARS,
  MAX_PACKS,
  MAX_PACK_CHARS,
  MAX_REQUEST_BYTES,
  MAX_TEXT_CHARS,
  MAX_VERSION_CHARS,
  REQUEST_FILE,
  REQUEST_ID,
  charCount,
  collectUserNames,
  hasControl,
  newRequestId,
  safeModFolderName,
  sanitizeMetadataLabel,
  sanitizeRequestText,
  truncateUtf16
} from './names.ts'

export type RequestsChannel =
  | 'requests:folder'
  | 'requests:pick-folder'
  | 'requests:send'
  | 'requests:list'
  | 'requests:install'

const REQUEST_GROUP_PREFIX = 'request:'

function requestGroupId(requestId: string): string {
  return `${REQUEST_GROUP_PREFIX}${requestId}`
}

async function isFiftyFiftyRunning(stateDir: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(join(stateDir, 'fiftyfifty.json'), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code !== 'ENOENT'
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return true
    const phase = (parsed as { phase?: unknown }).phase
    return phase !== 'found' && phase !== 'stopped'
  } catch {
    return true
  }
}

async function readSavedSimsFolder(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'folderPath' in parsed) {
      const value = (parsed as { folderPath?: unknown }).folderPath
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return null
  } catch {
    return null
  }
}

async function resolveSimsFolder(ctx: AppContext): Promise<string | null> {
  if (ctx.session.scan?.folder.path) {
    return ctx.session.scan.folder.path
  }
  const saved = await readSavedSimsFolder(ctx.paths.stateDir)
  if (saved && (await exists(join(saved, 'Options.ini')))) {
    return saved
  }
  try {
    const located = await locate(ctx.host)
    if (located.userFolders.length > 0) {
      return located.userFolders[0]!.path
    }
  } catch {
    // Fall through to null
  }
  return null
}

async function gatherRequestMetadata(ctx: AppContext): Promise<{
  game: { version: string | null; packs: string[] }
  mods: string[]
}> {
  const userNames = collectUserNames(ctx.host.env)

  let rawVersion: string | null = ctx.session.scan?.game?.version ?? null
  let rawPacks: string[] = ctx.session.scan?.game?.packs ? [...ctx.session.scan.game.packs] : []

  if (!ctx.session.scan?.game) {
    try {
      const located = await locate(ctx.host)
      if (located.gameInstall) {
        rawVersion = located.gameInstall.version
        rawPacks = [...located.gameInstall.packs]
      }
    } catch {
      // Leave null / empty
    }
  }

  let version: string | null = null
  if (typeof rawVersion === 'string') {
    const cleanVer = rawVersion.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
    if (cleanVer !== '' && !hasControl(cleanVer)) {
      version = truncateUtf16(cleanVer, MAX_VERSION_CHARS)
    }
  }

  const packsSet = new Set<string>()
  for (const p of rawPacks) {
    if (packsSet.size >= MAX_PACKS) break
    const cleanPack = sanitizeMetadataLabel(p, MAX_PACK_CHARS, ctx.redact, userNames)
    if (cleanPack) packsSet.add(cleanPack)
  }

  const modsSet = new Set<string>()
  const groups = ctx.session.scan?.inventory.groups ?? []
  for (const g of groups) {
    if (modsSet.size >= MAX_MODS) break
    const cleanMod = sanitizeMetadataLabel(g.label, MAX_MOD_CHARS, ctx.redact, userNames)
    if (cleanMod) modsSet.add(cleanMod)
  }

  return {
    game: { version, packs: [...packsSet].sort() },
    mods: [...modsSet]
  }
}

function serializeBoundedRequest(payload: {
  format: 1
  id: string
  at: string
  text: string
  game: { version: string | null; packs: string[] }
  mods: string[]
}): string {
  const mods = [...payload.mods]
  for (;;) {
    const json = `${JSON.stringify({ ...payload, mods }, null, 2)}\n`
    if (Buffer.byteLength(json, 'utf8') <= MAX_REQUEST_BYTES || mods.length === 0) {
      return json
    }
    mods.pop()
  }
}

interface StoredRequest {
  id: string
  at: string
  text: string
}

async function readStoredRequests(modFolder: string): Promise<StoredRequest[]> {
  const requestsDir = join(modFolder, 'requests')
  let names: string[]
  try {
    const dirInfo = await lstat(requestsDir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return []
    names = await readdir(requestsDir)
  } catch {
    return []
  }

  const results: StoredRequest[] = []
  for (const name of names) {
    if (!REQUEST_FILE.test(name)) continue
    const expectedId = name.slice(0, -'.json'.length)
    const filePath = join(requestsDir, name)
    try {
      const info = await lstat(filePath)
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_REQUEST_BYTES) continue
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const obj = parsed as Record<string, unknown>
      if (obj.format !== 1 || obj.id !== expectedId) continue
      if (typeof obj.at !== 'string' || typeof obj.text !== 'string') continue
      results.push({ id: expectedId, at: obj.at, text: obj.text })
    } catch {
      // Skip unreadable or malformed request file without breaking the list
    }
  }
  return results
}

function installedRequestIds(entries: readonly JournalEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.action !== 'install-mod' || entry.status !== 'done') continue
    if (entry.groupId && entry.groupId.startsWith(REQUEST_GROUP_PREFIX)) {
      ids.add(entry.groupId.slice(REQUEST_GROUP_PREFIX.length))
    }
  }
  return ids
}

function findUnsettledInstallEntry(entries: readonly JournalEntry[], requestId: string): JournalEntry | null {
  const targetGroupId = requestGroupId(requestId)
  for (const entry of entries) {
    if (entry.action !== 'install-mod' || entry.groupId !== targetGroupId) continue
    if (entry.status === 'needs-attention' || entry.status === 'in-progress') {
      return entry
    }
  }
  return null
}

async function cleanupHolding(ctx: AppContext, holdingEntryDir: string): Promise<void> {
  try {
    await ctx.gate.run({
      reason: 'mod-install',
      folderPath: null,
      ops: [{ op: 'remove', path: holdingEntryDir }]
    })
  } catch {
    // Best-effort cleanup; never masks the refusal
  }
}

export function requestsHandlers(ctx: AppContext): Handlers<RequestsChannel> {
  return {
    async 'requests:folder'() {
      return await syncModFolder(ctx)
    },

    async 'requests:pick-folder'() {
      return await pickAndSaveModFolder(ctx)
    },

    async 'requests:send'(req): Promise<ModRequestSent> {
      const folder = await syncModFolder(ctx)
      if (folder.kind !== 'set') {
        return { kind: 'refused', why: 'no-folder' }
      }

      if (!req || typeof req !== 'object' || typeof req.text !== 'string') {
        return { kind: 'refused', why: 'empty' }
      }

      const userNames = collectUserNames(ctx.host.env)
      const text = sanitizeRequestText(req.text, ctx.redact, userNames)
      if (text.length === 0) {
        return { kind: 'refused', why: 'empty' }
      }
      if (charCount(text) > MAX_TEXT_CHARS) {
        return { kind: 'refused', why: 'too-long' }
      }

      const now = ctx.clock.now()
      const id = newRequestId(now)
      const at = now.toISOString()
      const { game, mods } = await gatherRequestMetadata(ctx)
      const data = serializeBoundedRequest({ format: 1, id, at, text, game, mods })

      const requestsDir = join(folder.path, 'requests')
      const target = join(requestsDir, `${id}.json`)

      const written = await ctx.gate.run({
        reason: 'mod-request',
        folderPath: null,
        ops: [
          { op: 'mkdir', path: requestsDir },
          { op: 'write', path: target, data, mode: 'create' }
        ]
      })

      if (written.status !== 'done') {
        return { kind: 'refused', why: 'error' }
      }

      return {
        kind: 'sent',
        request: { id, at, text, status: 'sent', delivery: null }
      }
    },

    async 'requests:list'(): Promise<ModRequest[]> {
      await ctx.startupRecovery()
      const folder = await syncModFolder(ctx)
      if (folder.kind !== 'set') {
        return []
      }

      const [stored, journal] = await Promise.all([
        readStoredRequests(folder.path),
        ctx.safety.listJournal().catch((): JournalEntry[] => [])
      ])

      const installed = installedRequestIds(journal)
      const items: ModRequest[] = []

      for (const req of stored) {
        const check = await readDelivery(folder.path, req.id)
        const isInstalled = installed.has(req.id)

        if (isInstalled) {
          const delivery =
            check.kind === 'ready'
              ? {
                  title: check.delivery.title,
                  note: check.delivery.note,
                  files: check.delivery.files.map(({ name, bytes }) => ({ name, bytes })),
                  hasScript: check.delivery.hasScript
                }
              : null
          items.push({
            id: req.id,
            at: req.at,
            text: req.text,
            status: 'installed',
            delivery
          })
        } else if (check.kind === 'ready') {
          const delivery = {
            title: check.delivery.title,
            note: check.delivery.note,
            files: check.delivery.files.map(({ name, bytes }) => ({ name, bytes })),
            hasScript: check.delivery.hasScript
          }
          items.push({
            id: req.id,
            at: req.at,
            text: req.text,
            status: 'ready',
            delivery
          })
        } else if (check.kind === 'broken') {
          items.push({
            id: req.id,
            at: req.at,
            text: req.text,
            status: 'broken',
            delivery: null
          })
        } else {
          items.push({
            id: req.id,
            at: req.at,
            text: req.text,
            status: 'sent',
            delivery: null
          })
        }
      }

      items.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
      return items
    },

    'requests:install'(req): Promise<FixOutcome> {
      return oneAtATime(ctx, async () => {
        await ctx.startupRecovery()

        const requestId = req && typeof req === 'object' && typeof req.requestId === 'string' ? req.requestId : ''
        if (!REQUEST_ID.test(requestId)) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
        }

        if (await isFiftyFiftyRunning(ctx.paths.stateDir)) {
          return { status: 'refused', refusal: { why: 'fifty-fifty-running' } }
        }

        const folder = await syncModFolder(ctx)
        if (folder.kind !== 'set') {
          return { status: 'refused', refusal: { why: 'not-started' } }
        }

        const simsFolderPath = await resolveSimsFolder(ctx)
        if (!simsFolderPath) {
          return { status: 'refused', refusal: { why: 'backup', reason: 'sims-folder-missing' } }
        }

        const journal = await ctx.safety.listJournal().catch((): JournalEntry[] => [])
        if (installedRequestIds(journal).has(requestId)) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
        }
        const unsettled = findUnsettledInstallEntry(journal, requestId)
        if (unsettled) {
          return {
            status: 'stopped-part-way',
            entry: unsettled,
            detail: 'A previous install of this mod stopped partway through. Open History to undo it before trying again.'
          }
        }

        const check = await readDelivery(folder.path, requestId)
        if (check.kind !== 'ready') {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }

        const { delivery } = check
        // One folder deep: the game loads .ts4script files only at depth 0 or 1 inside Mods.
        const safeTitle = safeModFolderName(delivery.title, requestId)
        const targetModDir = join(simsFolderPath, 'Mods', safeTitle)

        // Never overwrite an existing file in Mods.
        for (const file of delivery.files) {
          if (await exists(join(targetModDir, file.name))) {
            return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
          }
        }

        const entryId = ctx.newId()
        const holdingEntryDir = join(ctx.paths.holdingDir, entryId)
        const holdingModDir = join(holdingEntryDir, 'Mods', safeTitle)
        const sourceFilesDir = join(folder.path, 'from-tyler', requestId, 'files')

        const copyOps: WriteOp[] = [{ op: 'mkdir', path: holdingModDir }]
        for (const file of delivery.files) {
          copyOps.push({
            op: 'copy',
            from: join(sourceFilesDir, file.name),
            to: join(holdingModDir, file.name)
          })
        }

        const staged = await ctx.gate.run({
          reason: 'mod-install',
          folderPath: null,
          ops: copyOps
        })
        if (staged.status === 'refused') {
          return { status: 'refused', refusal: { why: 'gate', refusal: staged.refusal } }
        }
        if (staged.status === 'failed') {
          await cleanupHolding(ctx, holdingEntryDir)
          return { status: 'refused', refusal: { why: 'not-started' } }
        }

        // Verify size and SHA-256 on every staged copy in holding before touching Mods.
        try {
          for (const file of delivery.files) {
            const stagedFile = join(holdingModDir, file.name)
            const info = await lstat(stagedFile)
            if (!info.isFile() || info.size !== file.bytes || info.size > MAX_FILE_BYTES) {
              await cleanupHolding(ctx, holdingEntryDir)
              return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
            }
            const actualSha = await sha256File(stagedFile)
            if (actualSha !== file.sha256) {
              await cleanupHolding(ctx, holdingEntryDir)
              return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
            }
          }
        } catch {
          await cleanupHolding(ctx, holdingEntryDir)
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'file-changed' } }
        }

        const plan: ActionPlan = {
          entryId,
          action: 'install-mod',
          summary: `Installed ${delivery.title}`,
          origin: { by: 'fix' },
          folderPath: simsFolderPath,
          groupId: requestGroupId(requestId),
          groupLabel: delivery.title,
          hasScript: delivery.hasScript,
          steps: delivery.files.map((file) => ({
            kind: 'move',
            from: join(holdingModDir, file.name),
            to: join(targetModDir, file.name)
          }))
        }

        let outcome: FixOutcome
        try {
          outcome = await ctx.safety.runAction(plan, (progress) => ctx.emit(progress))
        } catch {
          await cleanupHolding(ctx, holdingEntryDir)
          return { status: 'refused', refusal: { why: 'not-started' } }
        }

        if (outcome.status === 'refused') {
          await cleanupHolding(ctx, holdingEntryDir)
        }
        return outcome
      })
    }
  }
}
