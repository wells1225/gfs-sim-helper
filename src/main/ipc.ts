import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, type Handlers, type IpcInvoke } from '../shared/ipc.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import type { AppContext } from './ports.ts'
import { scanHandlers } from './scan/handlers.ts'
import { updateHandlers } from './update/handlers.ts'

export type IpcMainLike = Pick<IpcMain, 'handle'>
export type IsAppWindow = (event: IpcMainInvokeEvent) => boolean

export function collectHandlers(ctx: AppContext): Handlers<keyof IpcInvoke> {
  const groups = [
    scanHandlers(ctx),
    fixHandlers(ctx),
    fiftyHandlers(ctx),
    assistHandlers(ctx),
    updateHandlers(ctx)
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
 * itself. A new channel fails typecheck until it is named here.
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
  'journal:list': true, // the first call runs safety.recover()
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
  'update:install': false
} as const satisfies Record<keyof IpcInvoke, boolean>

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
      if (!CHANGING_CHANNELS[channel]) return await handler(req)
      const letGo = ctx.holdBusy?.()
      try {
        return await handler(req)
      } finally {
        letGo?.()
      }
    })
  }
}
