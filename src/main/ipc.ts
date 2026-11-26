import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, type Handlers, type IpcInvoke } from '../shared/ipc.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import type { AppContext } from './ports.ts'
import { scanHandlers } from './scan/handlers.ts'
import { shareHandlers } from './share/handlers.ts'
import { updateHandlers } from './update/handlers.ts'

export type IpcMainLike = Pick<IpcMain, 'handle'>
export type IsAppWindow = (event: IpcMainInvokeEvent) => boolean

export function collectHandlers(ctx: AppContext): Handlers<keyof IpcInvoke> {
  const groups = [
    scanHandlers(ctx),
    fixHandlers(ctx),
    fiftyHandlers(ctx),
    assistHandlers(ctx),
    updateHandlers(ctx),
    shareHandlers(ctx)
  ]
  const merged: Record<string, (req: unknown) => Promise<unknown>> = {}

  for (const group of groups) {
    for (const [channel, fn] of Object.entries(group)) {
      if (channel in merged) {
        throw new Error(`Duplicate IPC handler for channel: ${channel}`)
      }
      merged[channel] = fn as (req: unknown) => Promise<unknown>
    }
  }

  for (const channel of INVOKE_CHANNELS) {
    if (!(channel in merged)) {
      throw new Error(`Missing IPC handler for channel: ${channel}`)
    }
  }

  if (Object.keys(merged).length !== INVOKE_CHANNELS.length) {
    const allowed = new Set<string>(INVOKE_CHANNELS)
    const extra = Object.keys(merged).filter((c) => !allowed.has(c))
    throw new Error(`Unexpected IPC handlers: ${extra.join(', ')}`)
  }

  return merged as unknown as Handlers<keyof IpcInvoke>
}

/**
 * true: the call can change her files or this app's data, so ctx.busy() holds from its first line to its last and a
 * restart for an update cannot land between two of its steps. Never true for update:*: update:install asks busy()
 * itself, and update:check's one write (the time of the last check, through the gate) is busy-counted by gate.run.
 * The start-up recovery is busy-counted by safety.recover, so the journal reads that wait for it stay false.
 * share:get is false on purpose: its two small housekeeping writes (a link put back after an undone Get, through
 * gate.run, and safety.closeUndo for a slot she has played since) are each busy-counted on their own and each is
 * done again on the next look if the app stops between them. A look every 60 s must not make Restart now answer busy.
 * A new channel fails typecheck until it is named here.
 */
export const CHANGING_CHANNELS = {
  'settings:get': false,
  'settings:update': true,
  'locate:run': false,
  'scan:run': false,
  'game:check': false,
  'report:build': true,
  'report:reveal': false,
  'backup:status': false,
  'fix:apply': true,
  'journal:list': false, // reads only; waits for the start-up recovery
  'journal:recovery': false,
  'journal:undo': true,
  'groups:disabled': false,
  'fifty:get': false,
  'fifty:start': true,
  'fifty:begin-round': true,
  'fifty:answer': true,
  'fifty:stop': true,
  'fifty:finish': true,
  'assist:status': false,
  'assist:preview': false,
  'assist:send': false,
  'assist:set-key': true,
  'assist:clear-key': true,
  'update:get': false,
  'update:check': false,
  'update:download': false,
  'update:install': false,
  'share:get': false,
  'share:set-role': true,
  'share:find-folder': true,
  'share:check': true,
  'share:settings': true,
  'share:local-saves': false,
  'share:send': true,
  'share:receive': true, // so an update cannot restart the app in the middle of a Get
  'share:keep': true,
  'share:old-saves': false,
  'share:restore': true,
  'share:stop': true,
  'share:mod-link': true,
  'share:open-link': false,
  'share:find-preview': false,
  'share:find-send': false
} as const satisfies Record<keyof IpcInvoke, boolean>

function sanitizeIpcError(err: unknown, redact?: (text: string) => string): Error {
  if (err && typeof err === 'object' && 'path' in err && typeof (err as { path?: unknown }).path === 'string') {
    return new Error('A file operation failed')
  }
  const raw = err instanceof Error ? err.message : String(err)
  return new Error(redact ? redact(raw) : raw)
}

/** `handlers` is for tests; the app registers collectHandlers(ctx). */
export function registerIpc(
  ipcMain: IpcMainLike,
  ctx: AppContext,
  isAppWindow: IsAppWindow,
  handlers: Handlers<keyof IpcInvoke> = collectHandlers(ctx)
): void {
  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel] as (req: unknown) => Promise<unknown>
    ipcMain.handle(channel, async (event, req) => {
      if (!isAppWindow(event)) {
        throw new Error(`IPC call rejected on channel ${channel}: untrusted sender`)
      }
      const letGo = CHANGING_CHANNELS[channel] ? ctx.holdBusy?.() : undefined
      try {
        return await handler(req)
      } catch (err) {
        throw sanitizeIpcError(err, ctx.redact)
      } finally {
        letGo?.()
      }
    })
  }
}
