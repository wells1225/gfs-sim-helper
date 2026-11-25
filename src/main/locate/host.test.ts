// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { extractVersion } from './game-install.ts'
import { createWindowsHost } from './host.ts'
import type { ExecRunner } from './host.ts'
import { checkGameRunning } from './process.ts'

interface Call {
  file: string
  args: readonly string[]
  timeout: number | undefined
  env: Record<string, string | undefined> | undefined
}

function fakeRunner(respond: (call: Call) => string | Error): { run: ExecRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: ExecRunner = async (file, args, options) => {
    const call = { file, args, timeout: options.timeout, env: options.env }
    calls.push(call)
    const out = respond(call)
    if (out instanceof Error) throw out
    return { stdout: out }
  }
  return { run, calls }
}

function exitError(code: number): Error {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code })
}

describe('Windows host', () => {
  it('returns undefined when reg query exits 1 for a missing key, with a timeout set', async () => {
    const { run, calls } = fakeRunner(() => exitError(1))
    const host = createWindowsHost('C:\\Users\\Player\\Documents', {}, run)

    expect(await host.readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Maxis\\The Sims 4', 'Install Dir')).toBeUndefined()
    expect(calls[0]?.file).toBe('reg')
    expect(calls[0]?.args).toEqual(['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Maxis\\The Sims 4', '/v', 'Install Dir'])
    expect(calls[0]?.timeout).toBeGreaterThan(0)
  })

  it('rejects listProcesses when tasklist fails or lists nothing, so the game state is unknown, not "not running"', async () => {
    const failing = createWindowsHost('', {}, fakeRunner(() => exitError(1)).run)
    await expect(failing.listProcesses()).rejects.toThrow()
    expect(await checkGameRunning(failing)).toBe('unknown')

    const empty = createWindowsHost('', {}, fakeRunner(() => 'INFO: No tasks are running.\r\n').run)
    await expect(empty.listProcesses()).rejects.toThrow()
    expect(await checkGameRunning(empty)).toBe('unknown')

    const { run, calls } = fakeRunner(
      () => '"System Idle Process","0","Services","0","8 K"\r\n"TS4_x64.exe","4820","Console","1","1 842 100 Ko"\r\n'
    )
    const ok = createWindowsHost('', {}, run)
    expect(await checkGameRunning(ok)).toBe('running')
    expect(calls[0]?.file).toBe('tasklist')
    expect(calls[0]?.args).toEqual(['/fo', 'csv', '/nh'])
    expect(calls[0]?.timeout).toBeGreaterThan(0)

    const notRunning = createWindowsHost('', {}, fakeRunner(() => '"explorer.exe","1","Console","1","9 K"\r\n').run)
    expect(await checkGameRunning(notRunning)).toBe('not-running')
  })

  it('passes the exe path to PowerShell only through the environment, with -NoProfile and a timeout', async () => {
    const exePath = "C:\\Games\\The Sims 4'; Remove-Item -Recurse C:\\ ;'\\Game\\Bin\\TS4_x64.exe"
    const { run, calls } = fakeRunner(() => '1.129.39.1030\r\n1.129.39.1030\r\n')
    const host = createWindowsHost('', {}, run)

    expect(extractVersion(await host.fileVersion(exePath))).toBe('1.129.39.1030')
    const call = calls[0]!
    expect(call.file).toBe('powershell.exe')
    expect(call.args).toContain('-NoProfile')
    expect(call.args).toContain('-NonInteractive')
    expect(call.args.join(' ')).not.toContain(exePath)
    expect(call.env?.['SIMS_HELPER_VERSION_PATH']).toBe(exePath)
    expect(call.timeout).toBeGreaterThan(0)
  })

  it('prints the numeric file version after the version string, so a comma-style string still yields a version', async () => {
    const { run, calls } = fakeRunner(() => '1, 129, 39, 1030\r\n1.129.39.1030\r\n')
    const host = createWindowsHost('', {}, run)
    expect(extractVersion(await host.fileVersion('C:\\x\\TS4_x64.exe'))).toBe('1.129.39.1030')

    const script = calls[0]!.args.at(-1)!
    // The numeric line must not depend on the string being empty.
    expect(script).not.toMatch(/elseif/i)
    expect(script).toMatch(/FileVersion\b[\s\S]*FileMajorPart/)
  })

  it('returns undefined when PowerShell fails or times out', async () => {
    const host = createWindowsHost('', {}, fakeRunner(() => Object.assign(new Error('timed out'), { killed: true })).run)
    expect(await host.fileVersion('C:\\x\\TS4_x64.exe')).toBeUndefined()
  })
})
