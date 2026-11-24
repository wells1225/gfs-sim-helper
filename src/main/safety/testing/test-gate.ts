// A stand-in for the real write gate (PR 8), for PR 9's tests only. Nothing in the app imports this file.
//
// It imports no fs write function: the test file hands it the ones it may use, so the read and write rule
// (gate-lint.test.ts) still holds for every non-test file under src/. It is strict on purpose, like the real gate:
// mkdir makes one level and fails when the folder exists; copy, move and write 'create' never overwrite; Saves and
// Tray are always refused; a write into Mods, a cache or Options.ini asks gameState and backupStatus first.
import { lstat, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { BackupStatus, GameRunState } from '../../../shared/model.ts'
import { CACHE_NAMES } from '../../ports.ts'
import type { Gate, GateResult, WriteOp, WriteRequest } from '../../ports.ts'

export interface TestGateFs {
  mkdir(path: string): Promise<unknown>
  copyFile(from: string, to: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, data: string | Uint8Array, options: { flag: string }): Promise<void>
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
  utimes(path: string, atime: Date, mtime: Date): Promise<void>
}

export interface TestGateHooks {
  /** Return a result to answer the request without running it. */
  beforeRequest?(request: WriteRequest, index: number): GateResult | undefined | Promise<GateResult | undefined>
  /** Return a string to stop at this op with `failed` (the op does not run). */
  beforeOp?(op: WriteOp, opIndex: number, request: WriteRequest): string | undefined | Promise<string | undefined>
  afterOp?(op: WriteOp, opIndex: number, request: WriteRequest): void | Promise<void>
}

export interface TestGateOptions {
  fs: TestGateFs
  gameState?: () => Promise<GameRunState>
  backupStatus?: (folderPath: string) => Promise<BackupStatus>
  hooks?: TestGateHooks
}

export interface TestGate extends Gate {
  readonly requests: WriteRequest[]
  count(reason?: WriteRequest['reason']): number
  hooks: TestGateHooks
}

const COPYFILE_EXCL = 1

function lower(path: string): string {
  return path.toLowerCase()
}

function inside(child: string, parent: string): boolean {
  const rel = relative(lower(parent), lower(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function writtenPaths(op: WriteOp): string[] {
  switch (op.op) {
    case 'mkdir':
      return [op.path]
    case 'copy':
      return [op.to]
    case 'move':
      return [op.from, op.to]
    case 'write':
      return [op.path]
    case 'remove':
      return [op.path]
  }
}

function zoneOf(path: string, folderPath: string | null): 'forbidden' | 'protected' | 'other' {
  if (folderPath === null || !inside(path, folderPath)) return 'other'
  const rel = relative(folderPath, path)
  const top = lower(rel.split(sep)[0] ?? '')
  if (top === 'saves' || top === 'tray') return 'forbidden'
  if (top === 'mods') return 'protected'
  if (rel.split(sep).length === 1) {
    if (top === 'options.ini') return 'protected'
    if (CACHE_NAMES.some((name) => lower(name.replace(/\/$/, '')) === top)) return 'protected'
  }
  return 'other'
}

export function makeTestGate(options: TestGateOptions): TestGate {
  const { fs } = options
  const requests: WriteRequest[] = []
  const gate: TestGate = {
    requests,
    hooks: options.hooks ?? {},
    count(reason) {
      return reason === undefined ? requests.length : requests.filter((r) => r.reason === reason).length
    },
    async run(request) {
      const index = requests.length
      requests.push(request)
      const early = await gate.hooks.beforeRequest?.(request, index)
      if (early) return early

      let touchesProtected = false
      for (const op of request.ops) {
        for (const path of writtenPaths(op)) {
          const zone = zoneOf(path, request.folderPath)
          if (zone === 'forbidden') return { status: 'refused', refusal: { reason: 'saves-or-tray', path } }
          if (zone === 'protected') touchesProtected = true
        }
      }
      if (touchesProtected && request.folderPath !== null) {
        const game = options.gameState ? await options.gameState().catch(() => 'unknown' as const) : 'not-running'
        if (game === 'running') return { status: 'refused', refusal: { reason: 'game-running' } }
        if (game === 'unknown') return { status: 'refused', refusal: { reason: 'game-state-unknown' } }
        if (options.backupStatus) {
          const status = await options.backupStatus(request.folderPath).catch(
            (err: unknown): BackupStatus => ({ state: 'unknown', detail: String(err) })
          )
          if (status.state !== 'verified') {
            return { status: 'refused', refusal: { reason: 'no-verified-backup', backup: status.state } }
          }
        }
      }

      for (let i = 0; i < request.ops.length; i += 1) {
        const op = request.ops[i]!
        const stop = await gate.hooks.beforeOp?.(op, i, request)
        if (stop !== undefined) return { status: 'failed', opsDone: i, detail: stop }
        try {
          await runOp(fs, op)
        } catch (err) {
          return { status: 'failed', opsDone: i, detail: `${op.op}: ${(err as Error).message}` }
        }
        await gate.hooks.afterOp?.(op, i, request)
      }
      return { status: 'done' }
    }
  }
  return gate
}

async function runOp(fs: TestGateFs, op: WriteOp): Promise<void> {
  switch (op.op) {
    case 'mkdir':
      await fs.mkdir(op.path)
      return
    case 'copy': {
      const source = await stat(op.from)
      await fs.copyFile(op.from, op.to, COPYFILE_EXCL)
      await fs.utimes(op.to, source.atime, source.mtime)
      return
    }
    case 'move':
      if (await exists(op.to)) throw new Error(`target exists: ${op.to}`)
      if (!(await exists(dirname(op.to)))) throw new Error(`no parent folder: ${op.to}`)
      await fs.rename(op.from, op.to)
      return
    case 'write':
      if (op.mode === 'create') {
        await fs.writeFile(op.path, op.data, { flag: 'wx' })
        return
      }
      {
        const temp = join(dirname(op.path), `.${basename(op.path)}.tmp-${process.pid}`)
        await fs.writeFile(temp, op.data, { flag: 'wx' })
        await fs.rename(temp, op.path)
      }
      return
    case 'remove':
      await fs.rm(op.path, { recursive: true, force: false })
      return
  }
}
