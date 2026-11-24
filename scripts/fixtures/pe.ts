const DOS_HEADER_SIZE = 0x80
const PE_SIGNATURE_SIZE = 4
const COFF_HEADER_SIZE = 20
const OPTIONAL_HEADER64_SIZE = 0xf0
const SECTION_HEADER_SIZE = 40
const FILE_ALIGNMENT = 0x200
const SECTION_ALIGNMENT = 0x1000
const RSRC_RVA = 0x1000
const RSRC_FILE_OFFSET = 0x200

const RT_VERSION = 16
const VS_VERSION_INFO_ID = 1
const LANG_EN_US = 0x0409
const CODEPAGE_UNICODE = 0x04b0

const VS_FFI_SIGNATURE = 0xfeef04bd

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

function align4(value: number): number {
  return (value + 3) & ~3
}

function encodeUtf16Z(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf16le')
}

function parseVersionParts(version: string): [number, number, number, number] {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`Invalid 4-part version string for PE resource: ${version}`)
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as [
    number,
    number,
    number,
    number
  ]
  for (const part of parts) {
    if (!Number.isInteger(part) || part < 0 || part > 0xffff) {
      throw new Error(`Version part out of uint16 range in ${version}`)
    }
  }
  return parts
}

function buildVersionNode(options: {
  key: string
  type: 0 | 1
  value?: Buffer
  valueLengthOverride?: number
  children?: readonly Buffer[]
}): Buffer {
  const keyBuf = encodeUtf16Z(options.key)
  const valueBuf = options.value ?? Buffer.alloc(0)
  const children = options.children ?? []

  const valueOffset = align4(6 + keyBuf.length)
  let cursor = valueOffset + valueBuf.length
  const childOffsets: number[] = []
  for (const child of children) {
    const offset = align4(cursor)
    childOffsets.push(offset)
    cursor = offset + child.length
  }

  const buf = Buffer.alloc(cursor)
  buf.writeUInt16LE(cursor, 0)
  buf.writeUInt16LE(options.valueLengthOverride ?? valueBuf.length, 2)
  buf.writeUInt16LE(options.type, 4)
  keyBuf.copy(buf, 6)
  if (valueBuf.length > 0) {
    valueBuf.copy(buf, valueOffset)
  }
  for (let i = 0; i < children.length; i += 1) {
    ;(children[i] as Buffer).copy(buf, childOffsets[i] as number)
  }
  return buf
}

function buildVersionInfoResource(version: string): Buffer {
  const [major, minor, build, revision] = parseVersionParts(version)
  const versionMS = (((major & 0xffff) << 16) | (minor & 0xffff)) >>> 0
  const versionLS = (((build & 0xffff) << 16) | (revision & 0xffff)) >>> 0

  // VS_FIXEDFILEINFO (52 bytes)
  const fixedInfo = Buffer.alloc(52)
  fixedInfo.writeUInt32LE(VS_FFI_SIGNATURE, 0) // dwSignature
  fixedInfo.writeUInt32LE(0x00010000, 4) // dwStrucVersion
  fixedInfo.writeUInt32LE(versionMS, 8) // dwFileVersionMS
  fixedInfo.writeUInt32LE(versionLS, 12) // dwFileVersionLS
  fixedInfo.writeUInt32LE(versionMS, 16) // dwProductVersionMS
  fixedInfo.writeUInt32LE(versionLS, 20) // dwProductVersionLS
  fixedInfo.writeUInt32LE(0x0000003f, 24) // dwFileFlagsMask
  fixedInfo.writeUInt32LE(0, 28) // dwFileFlags
  fixedInfo.writeUInt32LE(0x00040004, 32) // dwFileOS (VOS_NT_WINDOWS32)
  fixedInfo.writeUInt32LE(0x00000001, 36) // dwFileType (VFT_APP)
  fixedInfo.writeUInt32LE(0, 40) // dwFileSubtype
  fixedInfo.writeUInt32LE(0, 44) // dwFileDateMS
  fixedInfo.writeUInt32LE(0, 48) // dwFileDateLS

  // StringFileInfo -> 040904b0 -> FileVersion (needed for FileVersionInfo.FileVersion string)
  const fileVersionString = buildVersionNode({
    key: 'FileVersion',
    type: 1,
    value: encodeUtf16Z(version),
    valueLengthOverride: version.length + 1
  })
  const stringTable = buildVersionNode({
    key: '040904b0',
    type: 1,
    children: [fileVersionString]
  })
  const stringFileInfo = buildVersionNode({
    key: 'StringFileInfo',
    type: 1,
    children: [stringTable]
  })

  // VarFileInfo -> Translation (0x0409, 0x04B0)
  const translationValue = Buffer.alloc(4)
  translationValue.writeUInt16LE(LANG_EN_US, 0)
  translationValue.writeUInt16LE(CODEPAGE_UNICODE, 2)
  const translationVar = buildVersionNode({
    key: 'Translation',
    type: 0,
    value: translationValue
  })
  const varFileInfo = buildVersionNode({
    key: 'VarFileInfo',
    type: 1,
    children: [translationVar]
  })

  return buildVersionNode({
    key: 'VS_VERSION_INFO',
    type: 0,
    value: fixedInfo,
    children: [stringFileInfo, varFileInfo]
  })
}

function buildResourceSection(versionInfo: Buffer): Buffer {
  // 3 directory levels (24 bytes each) + 1 IMAGE_RESOURCE_DATA_ENTRY (16 bytes) = 88 bytes
  const headerSize = 24 * 3 + 16
  const rsrc = Buffer.alloc(headerSize + versionInfo.length)

  // Level 1: Type directory (RT_VERSION = 16 -> subdir at offset 24)
  rsrc.writeUInt16LE(1, 14)
  rsrc.writeUInt32LE(RT_VERSION, 16)
  rsrc.writeUInt32LE((0x80000000 | 24) >>> 0, 20)

  // Level 2: Name/ID directory (ID = 1 -> subdir at offset 48)
  rsrc.writeUInt16LE(1, 24 + 14)
  rsrc.writeUInt32LE(VS_VERSION_INFO_ID, 24 + 16)
  rsrc.writeUInt32LE((0x80000000 | 48) >>> 0, 24 + 20)

  // Level 3: Language directory (0x0409 -> data entry at offset 72)
  rsrc.writeUInt16LE(1, 48 + 14)
  rsrc.writeUInt32LE(LANG_EN_US, 48 + 16)
  rsrc.writeUInt32LE(72, 48 + 20)

  // IMAGE_RESOURCE_DATA_ENTRY at offset 72 (OffsetToData is an RVA from image base)
  rsrc.writeUInt32LE(RSRC_RVA + headerSize, 72)
  rsrc.writeUInt32LE(versionInfo.length, 76)
  rsrc.writeUInt32LE(0, 80)
  rsrc.writeUInt32LE(0, 84)

  versionInfo.copy(rsrc, headerSize)
  return rsrc
}

/**
 * Builds a minimal, deterministic 64-bit Windows PE (PE32+) binary holding only a `.rsrc`
 * section with a valid `VS_VERSIONINFO` resource so Windows `FileVersionInfo` reads the version.
 */
export function writeMinimalVersionPe(version: string): Buffer {
  const versionInfo = buildVersionInfoResource(version)
  const rsrc = buildResourceSection(versionInfo)
  const rsrcVirtualSize = rsrc.length
  const rsrcRawSize = alignUp(rsrcVirtualSize, FILE_ALIGNMENT)
  const sizeOfImage = RSRC_RVA + alignUp(rsrcVirtualSize, SECTION_ALIGNMENT)

  const pe = Buffer.alloc(RSRC_FILE_OFFSET + rsrcRawSize)

  // DOS header
  pe.write('MZ', 0, 'ascii')
  pe.writeUInt32LE(DOS_HEADER_SIZE, 0x3c) // e_lfanew

  // PE signature
  let offset = DOS_HEADER_SIZE
  pe.write('PE\0\0', offset, 'ascii')
  offset += PE_SIGNATURE_SIZE

  // COFF File Header (20 bytes)
  pe.writeUInt16LE(0x8664, offset) // Machine: AMD64
  pe.writeUInt16LE(1, offset + 2) // NumberOfSections: 1 (.rsrc)
  pe.writeUInt32LE(0, offset + 4) // TimeDateStamp (deterministic)
  pe.writeUInt32LE(0, offset + 8) // PointerToSymbolTable
  pe.writeUInt32LE(0, offset + 12) // NumberOfSymbols
  pe.writeUInt16LE(OPTIONAL_HEADER64_SIZE, offset + 16) // SizeOfOptionalHeader
  pe.writeUInt16LE(0x0022, offset + 18) // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
  offset += COFF_HEADER_SIZE

  // PE32+ Optional Header (240 bytes)
  const opt = offset
  pe.writeUInt16LE(0x020b, opt) // Magic: PE32+
  pe.writeUInt8(14, opt + 0x02) // MajorLinkerVersion
  pe.writeUInt32LE(rsrcRawSize, opt + 0x08) // SizeOfInitializedData
  pe.writeUInt32LE(RSRC_RVA, opt + 0x14) // BaseOfCode
  pe.writeBigUInt64LE(0x0000000140000000n, opt + 0x18) // ImageBase
  pe.writeUInt32LE(SECTION_ALIGNMENT, opt + 0x20) // SectionAlignment
  pe.writeUInt32LE(FILE_ALIGNMENT, opt + 0x24) // FileAlignment
  pe.writeUInt16LE(6, opt + 0x28) // MajorOperatingSystemVersion
  pe.writeUInt16LE(6, opt + 0x30) // MajorSubsystemVersion
  pe.writeUInt32LE(sizeOfImage, opt + 0x38) // SizeOfImage
  pe.writeUInt32LE(RSRC_FILE_OFFSET, opt + 0x3c) // SizeOfHeaders
  pe.writeUInt16LE(2, opt + 0x44) // Subsystem: WINDOWS_GUI
  pe.writeBigUInt64LE(0x100000n, opt + 0x48) // SizeOfStackReserve
  pe.writeBigUInt64LE(0x1000n, opt + 0x50) // SizeOfStackCommit
  pe.writeBigUInt64LE(0x100000n, opt + 0x58) // SizeOfHeapReserve
  pe.writeBigUInt64LE(0x1000n, opt + 0x60) // SizeOfHeapCommit
  pe.writeUInt32LE(16, opt + 0x6c) // NumberOfRvaAndSizes

  // DataDirectory[2] = Resource Table (opt + 0x70 + 2 * 8 = opt + 0x80)
  pe.writeUInt32LE(RSRC_RVA, opt + 0x80)
  pe.writeUInt32LE(rsrcVirtualSize, opt + 0x84)
  offset += OPTIONAL_HEADER64_SIZE

  // Section Header: .rsrc (40 bytes)
  pe.write('.rsrc', offset, 'ascii')
  pe.writeUInt32LE(rsrcVirtualSize, offset + 8) // VirtualSize
  pe.writeUInt32LE(RSRC_RVA, offset + 12) // VirtualAddress
  pe.writeUInt32LE(rsrcRawSize, offset + 16) // SizeOfRawData
  pe.writeUInt32LE(RSRC_FILE_OFFSET, offset + 20) // PointerToRawData
  pe.writeUInt32LE(0x40000040, offset + 36) // CNT_INITIALIZED_DATA | MEM_READ
  offset += SECTION_HEADER_SIZE

  if (offset > RSRC_FILE_OFFSET) {
    throw new Error('PE headers exceeded RSRC_FILE_OFFSET')
  }

  rsrc.copy(pe, RSRC_FILE_OFFSET)
  return pe
}
