// Test helpers: a temp HOME with a config, a fake Drive folder, and fake `rclone` and `msmtp` first on PATH.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const RELAY = path.resolve(here, '..', 'm8-relay.mjs')
export const DELIVER = path.resolve(here, '..', 'deliver.mjs')

export const SECRET_TO = 'tyler.private.inbox@example.test'
export const SECRET_REMOTE = 'zzhiddenremote'

export function makeEnv({ webhookUrl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const drive = path.join(root, 'drive')
  const mail = path.join(root, 'mail')
  for (const d of [home, bin, drive, mail]) fs.mkdirSync(d, { recursive: true })
  for (const name of ['rclone', 'msmtp']) {
    const target = path.join(bin, name)
    fs.copyFileSync(path.join(here, 'fakes', `${name}.mjs`), target)
    fs.chmodSync(target, 0o755)
  }
  const configDir = path.join(home, '.config', 'sims-helper-relay')
  fs.mkdirSync(configDir, { recursive: true })
  const configFile = path.join(configDir, 'config.json')
  const config = { to: SECRET_TO, rcloneRemote: SECRET_REMOTE }
  if (webhookUrl) config.webhookUrl = webhookUrl
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
  fs.chmodSync(configFile, 0o600)

  const secrets = [SECRET_TO, SECRET_REMOTE, 'hunter2', ...(webhookUrl ? [webhookUrl, new URL(webhookUrl).pathname] : [])]
  const outputs = []

  const env = {
    ...process.env,
    HOME: home,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    FAKE_DRIVE: drive,
    FAKE_RCLONE_LOG: path.join(root, 'rclone.log'),
    FAKE_MAIL_DIR: mail,
  }

  return {
    root,
    home,
    drive,
    mail,
    configFile,
    seenFile: path.join(home, '.local', 'state', 'sims-helper-relay', 'seen.json'),
    lockFile: path.join(home, '.local', 'state', 'sims-helper-relay', 'run.lock'),
    outputs,
    run(script, args = [], extraEnv = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...args], { env: { ...env, ...extraEnv } })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => (stdout += c))
        child.stderr.on('data', (c) => (stderr += c))
        child.on('close', (code) => {
          outputs.push(stdout, stderr)
          resolve({ code, stdout, stderr })
        })
      })
    },
    rcloneCalls() {
      if (!fs.existsSync(env.FAKE_RCLONE_LOG)) return []
      return fs
        .readFileSync(env.FAKE_RCLONE_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).args)
    },
    mails() {
      return fs
        .readdirSync(mail)
        .filter((f) => f.endsWith('.eml'))
        .sort()
        .map((f) => fs.readFileSync(path.join(mail, f), 'utf8'))
    },
    seen() {
      return JSON.parse(fs.readFileSync(this.seenFile, 'utf8'))
    },
    addRequest(id, overrides = {}, raw) {
      const dir = path.join(drive, 'requests')
      fs.mkdirSync(dir, { recursive: true })
      const body =
        raw ??
        JSON.stringify({
          format: 1,
          id,
          at: '2026-11-26T14:30:00.000Z',
          text: 'A mod where my Sims notice new outfits.\nAnd say something nice!',
          game: { version: '1.112.519.1020', packs: ['EP01 Get to Work', 'GP04 Vampires'] },
          mods: ['MC Command Center', 'UI Cheats Extension'],
          ...overrides,
        })
      fs.writeFileSync(path.join(dir, `${id}.json`), body)
    },
    /** Fails the test if any config value or secret appears in anything a script printed. */
    assertNoSecrets() {
      const all = outputs.join('\n')
      for (const s of secrets) assert.ok(!all.includes(s), `output leaked a secret value`)
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
