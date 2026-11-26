// @vitest-environment node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_ICON_RELATIVE_PATH, appIconPath } from './app-icon.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface IcoEntry {
  width: number
  height: number
  bitCount: number
  bytesInRes: number
  imageOffset: number
}

function parseIco(buf: Buffer): { reserved: number; type: number; count: number; entries: IcoEntry[] } {
  expect(buf.length).toBeGreaterThanOrEqual(6)
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  const entries: IcoEntry[] = []

  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16
    expect(buf.length).toBeGreaterThanOrEqual(base + 16)
    const rawW = buf.readUInt8(base)
    const rawH = buf.readUInt8(base + 1)
    entries.push({
      width: rawW === 0 ? 256 : rawW,
      height: rawH === 0 ? 256 : rawH,
      bitCount: buf.readUInt16LE(base + 6),
      bytesInRes: buf.readUInt32LE(base + 8),
      imageOffset: buf.readUInt32LE(base + 12)
    })
  }

  return { reserved, type, count, entries }
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.length).toBeGreaterThanOrEqual(24)
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  }
}

describe('app icon assets and wiring', () => {
  it('ships a valid multi-size build/icon.ico containing 16, 24, 32, 48, 64, 128, and 256 px entries', async () => {
    const icoPath = join(REPO_ROOT, 'build/icon.ico')
    expect(existsSync(icoPath)).toBe(true)

    const buf = await readFile(icoPath)
    const { reserved, type, count, entries } = parseIco(buf)
    expect(reserved).toBe(0)
    expect(type).toBe(1)
    expect(count).toBe(entries.length)

    const sizes = entries.map((e) => {
      expect(e.width).toBe(e.height)
      expect(e.bytesInRes).toBeGreaterThan(0)
      expect(e.imageOffset + e.bytesInRes).toBeLessThanOrEqual(buf.length)
      return e.width
    })

    for (const required of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes).toContain(required)
    }

    for (const entry of entries) {
      const payload = buf.subarray(entry.imageOffset, entry.imageOffset + entry.bytesInRes)
      if (payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
        expect(parsePngDimensions(payload)).toEqual({ width: entry.width, height: entry.height })
      } else {
        // 32-bit RGBA DIB: BITMAPINFOHEADER (40 bytes) with doubled height for XOR + AND masks.
        expect(payload.readUInt32LE(0)).toBe(40)
        expect(payload.readInt32LE(4)).toBe(entry.width)
        expect(payload.readInt32LE(8)).toBe(entry.height * 2)
        expect(payload.readUInt16LE(14)).toBe(32)
      }
    }
  })

  it('ships a valid 256x256 build/icon.png', async () => {
    const pngPath = join(REPO_ROOT, 'build/icon.png')
    expect(existsSync(pngPath)).toBe(true)

    const buf = await readFile(pngPath)
    expect(parsePngDimensions(buf)).toEqual({ width: 256, height: 256 })
  })

  it('configures win.icon and packages the runtime icon asset in electron-builder.yml', async () => {
    const builder = (await readFile(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')).replaceAll('\r\n', '\n')

    const winSection = builder.slice(builder.indexOf('\nwin:\n'))
    expect(winSection).toMatch(/^win:\n[\s\S]*?^ {2}icon: build\/icon\.ico$/m)

    const filesSection = builder.slice(builder.indexOf('\nfiles:\n'), builder.indexOf('\nwin:\n'))
    expect(filesSection).toMatch(new RegExp(`^ {2}- ${APP_ICON_RELATIVE_PATH.replace('.', '\\.')}$`, 'm'))
  })

  it('resolves the BrowserWindow icon path from both src/main and out/main to the existing PNG', async () => {
    const expected = join(REPO_ROOT, 'build/icon.png')
    expect(appIconPath()).toBe(expected)
    expect(appIconPath(join(REPO_ROOT, 'out/main'))).toBe(expected)
    expect(existsSync(appIconPath())).toBe(true)

    const mainEntry = await readFile(join(REPO_ROOT, 'src/main/index.ts'), 'utf8')
    expect(mainEntry).toContain("from './app-icon.ts'")
    expect(mainEntry).toMatch(/icon:\s*appIconPath\(__dirname\)/)
  })
})
