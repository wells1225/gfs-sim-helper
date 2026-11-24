import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, type Handlers, type IpcInvoke } from '../shared/ipc.ts'
import { assistHandlers } from './assist/handlers.ts'
import { fiftyHandlers } from './fiftyfifty/handlers.ts'
import { fixHandlers } from './fixes/handlers.ts'
import type { AppContext } from './ports.ts'
import { scanHandlers } from './scan/handlers.ts'

export type IpcMainLike = Pick<IpcMain, 'handle'>
export type IsAppWindow = (event: IpcMainInvokeEvent) => boolean

export function collectHandlers(ctx: AppContext): Handlers<keyof IpcInvoke> {
  const groups = [scanHandlers(ctx), fixHandlers(ctx), fiftyHandlers(ctx), assistHandlers(ctx)]
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

export function registerIpc(ipcMain: IpcMainLike, ctx: AppContext, isAppWindow: IsAppWindow): void {
  const handlers = collectHandlers(ctx)

  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel] as (req: unknown) => Promise<unknown>
    ipcMain.handle(channel, async (event, req) => {
      if (!isAppWindow(event)) {
        throw new Error(`IPC call rejected on channel ${channel}: untrusted sender`)
      }
      return await handler(req)
    })
  }
}
