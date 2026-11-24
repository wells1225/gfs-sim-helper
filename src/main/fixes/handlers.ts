import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handlers } from '../../shared/ipc.ts'
import type { DisabledGroup, FixCall, FixOutcome } from '../../shared/model.ts'
import type { AppContext } from '../ports.ts'
import { extractGroupLabel } from './index.ts'

export type FixChannel = 'backup:status' | 'fix:apply' | 'journal:list' | 'journal:undo' | 'groups:disabled'

/**
 * Fails closed: only a missing file, or a file that plainly says the test is over, lets a fix through.
 * A file that is there but cannot be read or understood counts as a test in progress.
 */
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

async function readSavedFolderPath(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'folderPath' in parsed) {
      const folderPath = (parsed as { folderPath?: unknown }).folderPath
      if (typeof folderPath === 'string' && folderPath.length > 0) {
        return folderPath
      }
    }
    return null
  } catch {
    return null
  }
}

const FIX_IDS: readonly string[] = [
  'turn-mods-on',
  'clear-caches',
  'move-script-up',
  'set-aside-files',
  'disable-group',
  'enable-group'
]

/** The window's message is not trusted: only the two FixCall shapes get through. */
function isFixCall(call: unknown): call is FixCall {
  if (!call || typeof call !== 'object') return false
  const c = call as Record<string, unknown>
  if (c.via === 'finding') {
    return typeof c.findingId === 'string' && typeof c.fix === 'string' && FIX_IDS.includes(c.fix)
  }
  if (c.via === 'group') {
    return (
      typeof c.groupId === 'string' && (c.fix === 'disable-group' || c.fix === 'enable-group')
    )
  }
  return false
}

export function fixHandlers(ctx: AppContext): Handlers<FixChannel> {
  /**
   * runAction throws only when its journal entry could not be written, before any file moved, so a throw here
   * becomes a calm refusal. The error text (it can hold her user name) never reaches the window.
   * Until the contract has its own FixRefusal for this, it borrows the gate's check-failed.
   */
  async function applyCalmly(run: () => Promise<FixOutcome>): Promise<FixOutcome> {
    try {
      return await run()
    } catch {
      return {
        status: 'refused',
        refusal: { why: 'gate', refusal: { reason: 'check-failed', path: ctx.paths.journalDir } }
      }
    }
  }

  let recovered = false
  let recoveryPromise: Promise<unknown> | null = null

  async function ensureRecovered(): Promise<void> {
    if (recovered) return
    if (!recoveryPromise) {
      recoveryPromise = ctx.safety
        .recover()
        .then(() => {
          recovered = true
        })
        .catch((err: unknown) => {
          recoveryPromise = null
          throw err
        })
    }
    await recoveryPromise
  }

  return {
    async 'backup:status'() {
      const folderPath = ctx.session.scan?.folder.path ?? (await readSavedFolderPath(ctx.paths.stateDir))
      if (!folderPath) {
        return { state: 'none' }
      }
      return ctx.safety.backupStatus(folderPath)
    },

    async 'fix:apply'(call: FixCall) {
      if (!isFixCall(call)) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-finding' } }
      }
      if (await isFiftyFiftyRunning(ctx.paths.stateDir)) {
        return { status: 'refused', refusal: { why: 'fifty-fifty-running' } }
      }

      const scan = ctx.session.scan
      if (!scan) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'no-scan' } }
      }

      if (call.via === 'finding') {
        const finding = scan.findings.find((f) => f.id === call.findingId)
        if (!finding) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-finding' } }
        }
        const request = finding.fixes.find((r) => r.fix === call.fix)
        if (!request) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-finding' } }
        }
        return applyCalmly(() => ctx.fixes.apply(scan, request, (progress) => ctx.emit(progress)))
      }

      if (call.fix === 'disable-group') {
        const hasGroup = scan.inventory.groups.some((g) => g.id === call.groupId)
        if (!hasGroup) {
          return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-group' } }
        }
        return applyCalmly(() =>
          ctx.fixes.apply(scan, { fix: 'disable-group', groupId: call.groupId }, (progress) => ctx.emit(progress))
        )
      }

      const inScan = scan.inventory.groups.some((g) => g.id === call.groupId)
      const disabled = inScan ? [] : await ctx.fixes.disabledGroups(scan.folder.path)
      if (!inScan && !disabled.some((d) => d.groupId === call.groupId)) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'unknown-group' } }
      }
      return ctx.fixes.apply(
        scan,
        { fix: 'enable-group', groupId: call.groupId },
        (progress) => ctx.emit(progress)
      )
    },

    async 'journal:list'() {
      await ensureRecovered()
      return ctx.safety.listJournal()
    },

    async 'journal:undo'(req) {
      if (await isFiftyFiftyRunning(ctx.paths.stateDir)) {
        return { status: 'refused', refusal: { why: 'fifty-fifty-running' } }
      }
      if (!req || typeof req.entryId !== 'string' || req.entryId.length === 0) {
        return { status: 'refused', refusal: { why: 'out-of-date', detail: 'nothing-to-do' } }
      }
      return ctx.safety.undo(req.entryId, (progress) => ctx.emit(progress))
    },

    async 'groups:disabled'() {
      const folderPath = ctx.session.scan?.folder.path ?? (await readSavedFolderPath(ctx.paths.stateDir))
      if (folderPath) {
        return ctx.fixes.disabledGroups(folderPath)
      }
      const journal = await ctx.safety.listJournal()
      const seen = new Set<string>()
      const result: DisabledGroup[] = []
      for (const entry of journal) {
        if (entry.action !== 'disable-group' || entry.status !== 'done' || entry.groupId === null) {
          continue
        }
        if (seen.has(entry.groupId)) continue
        seen.add(entry.groupId)
        result.push({
          groupId: entry.groupId,
          label: extractGroupLabel(entry),
          entryId: entry.id,
          at: entry.at
        })
      }
      return result
    }
  }
}
