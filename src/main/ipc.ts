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

const ERRNO_PREFIX = /^([A-Z][A-Z0-9_]{1,30}):(?:\s|$)/

const FS_SYSCALLS = new Set(
  (
    'open read write stat lstat fstat statfs scandir readdir mkdir rmdir unlink rename copyfile ' +
    'realpath readlink chmod chown access rm link symlink mkdtemp truncate utime futime close fsync'
  ).split(' ')
)

const FS_ERRNO_CODES = new Set(
  (
    'ENOENT EACCES EPERM EBUSY EEXIST EISDIR ENOTDIR ENOTEMPTY ENOSPC ' +
    'EMFILE ENFILE EROFS EXDEV ENAMETOOLONG ELOOP EIO EBADF EFBIG'
  ).split(' ')
)

const NETWORK_ERRNO_CODES = new Set(
  (
    'ECONNRESET ECONNREFUSED ECONNABORTED EPIPE ETIMEDOUT ' +
    'EHOSTUNREACH ENETUNREACH ENOTFOUND EAI_AGAIN ERR_SOCKET_CLOSED'
  ).split(' ')
)

const WIN_DRIVE_OR_DEVICE_PATH = /(?:^|[\s'"`()[\]{}=,:;])(?:\\{2,}[?.][\\/]|(?:\\+[?.]\\+)?[A-Za-z]:[\\/])/
const WIN_UNC_PATH = /(?:^|[\s'"`()[\]{}=,:;])\\{2,}(?:<user>|[^\s\\/:*?"'`<>|])+\\+(?:<user>|[^\s\\/:*?"'`<>|])/
const POSIX_UNC_PATH = /(?:^|[\s'"`()[\]{}=,;])\/\/(?:<user>|[^\s\\/:*?"'`<>|])+\/(?:<user>|[^\s\\/:*?"'`<>|])/
const FILE_URL_PATH = /(?:^|[\s'"`()[\]{}=,:;])file:\//i
const ENV_OR_HOME_PATH =
  /(?:^|[\s'"`()[\]{}=,:;])(?:(?:~|%[A-Za-z_][A-Za-z0-9_()]*%|\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|(?:env:)?[A-Za-z_][A-Za-z0-9_]*))[\\/]|\.\.?[\\/](?:<user>|[A-Za-z0-9_.-]))/i
const WEB_URL =
  /https?:\/\/(?:<user>|[^\s'"`()<>[\]{},;:/])+(?::\d{1,5})?(?:\/(?:<user>|;(?![\\/])|[^\s'"`()<>[\]{},;:])*)?/gi

const UNIX_START_BOUNDARY = /[\s'"`()[\]{}=,:;]/
const UNIX_SEG_STOP = /[\s\\/:*?"'`<>|()[\]{},;!]/
const UNIX_EXT = /^[A-Za-z][A-Za-z0-9]{0,11}$/
const KNOWN_UNIX_ROOTS = new Set(
  (
    'Users Volumes Applications Library System private home root etc var tmp opt usr bin sbin ' +
    'dev proc sys run mnt media srv nix snap fake sims'
  ).split(' ')
)

function isTrailingPunct(ch: string): boolean {
  return ch === '.' || ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === '?'
}

function hasUnixAbsPath(text: string): boolean {
  let i = 0
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] !== '/' && (i === 0 || UNIX_START_BOUNDARY.test(text[i - 1]!))) {
      let j = i + 1
      while (j < text.length) {
        if (text.startsWith('<user>', j)) {
          j += 6
          continue
        }
        if (UNIX_SEG_STOP.test(text[j]!)) break
        j += 1
      }
      if (j === i + 1) {
        i = j
        continue
      }
      if (
        text[j] === '/' &&
        j + 1 < text.length &&
        text[j + 1] !== '/' &&
        (text.startsWith('<user>', j + 1) || !UNIX_SEG_STOP.test(text[j + 1]!))
      ) {
        return true
      }
      let end = j
      while (end > i + 1 && isTrailingPunct(text[end - 1]!)) {
        end -= 1
      }
      if (end > i + 1) {
        const cleanSeg1 = text.slice(i + 1, end)
        if (KNOWN_UNIX_ROOTS.has(cleanSeg1) || cleanSeg1 === '<user>') {
          return true
        }
        const lastDot = cleanSeg1.lastIndexOf('.')
        const minDot = cleanSeg1.startsWith('.') ? 2 : 1
        const extLen = cleanSeg1.length - lastDot - 1
        if (lastDot >= minDot && extLen >= 1 && extLen <= 12 && UNIX_EXT.test(cleanSeg1.slice(lastDot + 1))) {
          return true
        }
      }
      i = j
      continue
    }
    i += 1
  }
  return false
}

function containsFilePath(text: string): boolean {
  if (
    WIN_DRIVE_OR_DEVICE_PATH.test(text) ||
    WIN_UNC_PATH.test(text) ||
    POSIX_UNC_PATH.test(text) ||
    FILE_URL_PATH.test(text) ||
    ENV_OR_HOME_PATH.test(text)
  ) {
    return true
  }
  const withoutWebUrls = text.replace(WEB_URL, ' ')
  return hasUnixAbsPath(withoutWebUrls)
}

function isPathValue(value: unknown): boolean {
  return typeof value === 'string' || value instanceof Uint8Array || Buffer.isBuffer(value) || value instanceof URL
}

function isFsErrnoCode(code: string): boolean {
  return FS_ERRNO_CODES.has(code) || code.startsWith('ERR_FS_')
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Something went wrong'
}

function isFileSystemError(err: unknown, raw: string): boolean {
  if (err && typeof err === 'object') {
    const candidate = err as { path?: unknown; dest?: unknown; syscall?: unknown; code?: unknown }
    if (isPathValue(candidate.path) || isPathValue(candidate.dest)) return true
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : undefined
    if (typeof candidate.syscall === 'string') {
      if (!FS_SYSCALLS.has(candidate.syscall.toLowerCase())) return false
      return code === undefined || !NETWORK_ERRNO_CODES.has(code)
    }
    if (code !== undefined) {
      if (NETWORK_ERRNO_CODES.has(code)) return false
      if (isFsErrnoCode(code)) return true
    }
  }
  const match = ERRNO_PREFIX.exec(raw)
  return match !== null && isFsErrnoCode(match[1]!)
}

export function sanitizeIpcError(err: unknown, redact?: (text: string) => string): Error {
  const raw = errorText(err)
  if (isFileSystemError(err, raw)) {
    return new Error('A file operation failed')
  }
  const redacted = redact ? redact(raw) : raw
  if (containsFilePath(raw) || (redacted !== raw && containsFilePath(redacted))) {
    return new Error('A file operation failed')
  }
  return new Error(redacted)
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
