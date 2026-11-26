/**
 * Deterministic generator for build/icon.png (256x256) and build/icon.ico (16, 24, 32, 48, 64, 128, 256).
 * Renders the exact Emblem.tsx SVG geometry and light-theme OKLCH palette in pure Node (zero external deps).
 *
 * Run with: node scripts/generate-icon.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = join(REPO_ROOT, 'build')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const

type Rgb = readonly [number, number, number]
type Point = readonly [number, number]
type Segment = readonly [number, number, number, number]

/** CSS Color 4 OKLCH -> sRGB bytes (exact match for src/renderer/styles.css tokens). */
function oklchToRgb(L: number, C: number, H: number): Rgb {
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  const toByte = (linear: number): number => {
    const clamped = Math.max(0, Math.min(1, linear))
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
    return Math.round(srgb * 255)
  }

  return [toByte(lr), toByte(lg), toByte(lb)]
}

function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()
}

// Light-theme tokens from src/renderer/styles.css:
// --accent:  oklch(0.955 0.025 166) -> #E1F6EC
// --primary: oklch(0.535 0.105 166) -> #16805F
const ACCENT_RGB = oklchToRgb(0.955, 0.025, 166)
const PRIMARY_RGB = oklchToRgb(0.535, 0.105, 166)

function sampleCubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    pts.push([x, y])
  }
  return pts
}

function polylineToSegments(points: readonly Point[]): Segment[] {
  const segs: Segment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[i + 1]!
    segs.push([x1, y1, x2, y2])
  }
  return segs
}

// Exact paths from src/renderer/components/Emblem.tsx (64x64 viewBox)
const HALF_STROKE_SQ = (4.2 / 2) * (4.2 / 2)

// Roof: M14 31.5 L30.2 17.6 C31.2 16.7 32.8 16.7 33.8 17.6 L50 31.5
const ROOF_SEGMENTS: readonly Segment[] = polylineToSegments([
  [14, 31.5],
  ...sampleCubicBezier([30.2, 17.6], [31.2, 16.7], [32.8, 16.7], [33.8, 17.6], 32),
  [50, 31.5]
])

// Walls: M20 29 V45.5 C20 47.4 21.6 49 23.5 49 H40.5 C42.4 49 44 47.4 44 45.5 V29
const WALL_SEGMENTS: readonly Segment[] = polylineToSegments([
  [20, 29],
  ...sampleCubicBezier([20, 45.5], [20, 47.4], [21.6, 49], [23.5, 49], 24),
  ...sampleCubicBezier([40.5, 49], [42.4, 49], [44, 47.4], [44, 45.5], 24),
  [44, 29]
])

const STROKE_SEGMENTS: readonly Segment[] = [...ROOF_SEGMENTS, ...WALL_SEGMENTS]

// 4-point sparkle:
// M32 29.5 C32.4 33.6 33.4 34.6 37.5 35 C33.4 35.4 32.4 36.4 32 40.5
//          C31.6 36.4 30.6 35.4 26.5 35 C30.6 34.6 31.6 33.6 32 29.5 Z
const SPARKLE_POLYGON: readonly Point[] = [
  ...sampleCubicBezier([32, 29.5], [32.4, 33.6], [33.4, 34.6], [37.5, 35], 32).slice(0, -1),
  ...sampleCubicBezier([37.5, 35], [33.4, 35.4], [32.4, 36.4], [32, 40.5], 32).slice(0, -1),
  ...sampleCubicBezier([32, 40.5], [31.6, 36.4], [30.6, 35.4], [26.5, 35], 32).slice(0, -1),
  ...sampleCubicBezier([26.5, 35], [30.6, 34.6], [31.6, 33.6], [32, 29.5], 32).slice(0, -1)
]

function distSqToSegment(px: number, py: number, [x1, y1, x2, y2]: Segment): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  const ex = px - projX
  const ey = py - projY
  return ex * ex + ey * ey
}

function insideRoundedRect(x: number, y: number): boolean {
  const qx = Math.abs(x - 32) - 16
  const qy = Math.abs(y - 32) - 16
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside <= 16
}

function insideSparkle(px: number, py: number): boolean {
  if (px < 26.4 || px > 37.6 || py < 29.4 || py > 40.6) return false
  let inside = false
  for (let i = 0, j = SPARKLE_POLYGON.length - 1; i < SPARKLE_POLYGON.length; j = i++) {
    const [xi, yi] = SPARKLE_POLYGON[i]!
    const [xj, yj] = SPARKLE_POLYGON[j]!
    const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function insideForeground(px: number, py: number): boolean {
  if (insideSparkle(px, py)) return true
  if (px < 11.5 || px > 52.5 || py < 14.5 || py > 51.5) return false
  for (let i = 0; i < STROKE_SEGMENTS.length; i++) {
    if (distSqToSegment(px, py, STROKE_SEGMENTS[i]!) <= HALF_STROKE_SQ) return true
  }
  return false
}

/** Rasterizes the 64x64 emblem at `size x size` using NxN supersampling with premultiplied-alpha filtering. */
function renderEmblemRgba(size: number): Buffer {
  const samples = size <= 48 ? 16 : 8
  const totalSamples = samples * samples
  const rgba = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let aSum = 0

      for (let sy = 0; sy < samples; sy++) {
        const y = ((py + (sy + 0.5) / samples) / size) * 64
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 64
          if (!insideRoundedRect(x, y)) continue
          const [r, g, b] = insideForeground(x, y) ? PRIMARY_RGB : ACCENT_RGB
          rSum += r
          gSum += g
          bSum += b
          aSum += 1
        }
      }

      const dst = (py * size + px) * 4
      if (aSum === 0) {
        rgba[dst] = 0
        rgba[dst + 1] = 0
        rgba[dst + 2] = 0
        rgba[dst + 3] = 0
      } else {
        rgba[dst] = Math.round(rSum / aSum)
        rgba[dst + 1] = Math.round(gSum / aSum)
        rgba[dst + 2] = Math.round(bSum / aSum)
        rgba[dst + 3] = Math.round((aSum / totalSamples) * 255)
      }
    }
  }

  return rgba
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** Encodes flat top-down 8-bit RGBA pixels into a standard PNG buffer. */
function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // color type: RGBA
  ihdr.writeUInt8(0, 10) // compression
  ihdr.writeUInt8(0, 11) // filter
  ihdr.writeUInt8(0, 12) // interlace

  const stride = width * 4
  const scanlines = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0 // filter type 0 (None)
    rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const idat = deflateSync(scanlines, { level: 9 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

/** Encodes RGBA pixels into a 32-bit BGRA Windows ICO DIB (BITMAPINFOHEADER + XOR + 1-bit AND mask). */
function encodeIcoDib(width: number, height: number, rgba: Buffer): Buffer {
  const headerSize = 40
  const xorSize = width * height * 4
  const andRowStride = Math.ceil(width / 32) * 4
  const andSize = andRowStride * height
  const buf = Buffer.alloc(headerSize + xorSize + andSize)

  buf.writeUInt32LE(headerSize, 0) // biSize
  buf.writeInt32LE(width, 4) // biWidth
  buf.writeInt32LE(height * 2, 8) // biHeight (doubled for XOR + AND mask)
  buf.writeUInt16LE(1, 12) // biPlanes
  buf.writeUInt16LE(32, 14) // biBitCount
  buf.writeUInt32LE(0, 16) // biCompression (BI_RGB)
  buf.writeUInt32LE(xorSize + andSize, 20) // biSizeImage

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const src = (srcY * width + x) * 4
      const dst = headerSize + (y * width + x) * 4
      buf[dst] = rgba[src + 2]! // B
      buf[dst + 1] = rgba[src + 1]! // G
      buf[dst + 2] = rgba[src]! // R
      buf[dst + 3] = rgba[src + 3]! // A
    }
  }

  const andBase = headerSize + xorSize
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(srcY * width + x) * 4 + 3]!
      if (alpha === 0) {
        const byteIndex = andBase + y * andRowStride + (x >> 3)
        buf[byteIndex] = buf[byteIndex]! | (0x80 >> (x & 7))
      }
    }
  }

  return buf
}

/** Packs sized image payloads into a multi-size Windows ICO file. */
function buildIco(images: readonly { size: number; payload: Buffer }[]): Buffer {
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = images.length * dirEntrySize
  let dataOffset = headerSize + dirSize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: ICO
  header.writeUInt16LE(images.length, 4) // image count

  const directory = Buffer.alloc(dirSize)
  for (let i = 0; i < images.length; i++) {
    const { size, payload } = images[i]!
    const entry = i * dirEntrySize
    directory.writeUInt8(size === 256 ? 0 : size, entry)
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2) // color palette count
    directory.writeUInt8(0, entry + 3) // reserved
    directory.writeUInt16LE(1, entry + 4) // color planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(payload.length, entry + 8)
    directory.writeUInt32LE(dataOffset, entry + 12)
    dataOffset += payload.length
  }

  return Buffer.concat([header, directory, ...images.map((img) => img.payload)])
}

async function main(): Promise<void> {
  const icoImages: { size: number; payload: Buffer }[] = []
  let png256: Buffer | null = null

  for (const size of ICO_SIZES) {
    const rgba = renderEmblemRgba(size)
    if (size === 256) {
      png256 = encodeRgbaPng(size, size, rgba)
      // 256x256 uses PNG payload inside ICO (standard Windows Vista+ format).
      icoImages.push({ size, payload: png256 })
    } else {
      // Smaller sizes use 32-bit BGRA DIB + AND mask for maximum Windows/NSIS/rcedit compatibility.
      icoImages.push({ size, payload: encodeIcoDib(size, size, rgba) })
    }
  }

  if (!png256) throw new Error('Missing 256x256 PNG render')

  await mkdir(BUILD_DIR, { recursive: true })
  await writeFile(join(BUILD_DIR, 'icon.png'), png256)
  await writeFile(join(BUILD_DIR, 'icon.ico'), buildIco(icoImages))

  console.log(
    `Generated build/icon.png (${png256.length} bytes) and build/icon.ico (${icoImages.length} sizes: ${ICO_SIZES.join(', ')}) using accent=${rgbToHex(ACCENT_RGB)}, primary=${rgbToHex(PRIMARY_RGB)}`
  )
}

await main()
