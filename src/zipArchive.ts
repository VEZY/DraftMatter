export interface StoredZipFile {
  name: string
  bytes: Uint8Array | string
}

interface ZipEntry {
  name: string
  bytes: Uint8Array
  crc: number
  offset: number
}

const encoder = new TextEncoder()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function write16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true)
}

function write32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true)
}

function safeArchiveName(name: string) {
  if (!name || name.length > 1024 || name.includes('\\') || name.startsWith('/') || name.includes('\0')) {
    throw new Error(`Invalid ZIP entry name: ${JSON.stringify(name)}.`)
  }
  const segments = name.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`ZIP entry names must be portable relative paths: ${JSON.stringify(name)}.`)
  }
  return name
}

/** Build a deterministic, uncompressed ZIP archive without platform or timestamp metadata. */
export function createStoredZip(files: StoredZipFile[]): Uint8Array<ArrayBuffer> {
  if (files.length > 65_535) throw new Error('A ZIP archive cannot contain more than 65,535 files.')
  const entries: ZipEntry[] = []
  const localParts: Uint8Array[] = []
  const seen = new Set<string>()
  let offset = 0
  for (const file of files) {
    const filename = safeArchiveName(file.name)
    if (seen.has(filename)) throw new Error(`Duplicate ZIP entry: ${filename}.`)
    seen.add(filename)
    const name = encoder.encode(filename)
    const bytes = typeof file.bytes === 'string' ? encoder.encode(file.bytes) : file.bytes
    const crc = crc32(bytes)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    write32(view, 0, 0x04034b50)
    write16(view, 4, 20)
    write16(view, 6, 0x0800)
    write16(view, 8, 0)
    write32(view, 14, crc)
    write32(view, 18, bytes.length)
    write32(view, 22, bytes.length)
    write16(view, 26, name.length)
    header.set(name, 30)
    entries.push({ name: filename, bytes, crc, offset })
    localParts.push(header, bytes)
    offset += header.length + bytes.length
  }

  const centralParts: Uint8Array[] = []
  let centralSize = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const header = new Uint8Array(46 + name.length)
    const view = new DataView(header.buffer)
    write32(view, 0, 0x02014b50)
    write16(view, 4, 20)
    write16(view, 6, 20)
    write16(view, 8, 0x0800)
    write16(view, 10, 0)
    write32(view, 16, entry.crc)
    write32(view, 20, entry.bytes.length)
    write32(view, 24, entry.bytes.length)
    write16(view, 28, name.length)
    write32(view, 38, 0)
    write32(view, 42, entry.offset)
    header.set(name, 46)
    centralParts.push(header)
    centralSize += header.length
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  write32(endView, 0, 0x06054b50)
  write16(endView, 8, entries.length)
  write16(endView, 10, entries.length)
  write32(endView, 12, centralSize)
  write32(endView, 16, offset)
  const total = offset + centralSize + end.length
  const archive = new Uint8Array(total)
  let cursor = 0
  for (const part of [...localParts, ...centralParts, end]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}
