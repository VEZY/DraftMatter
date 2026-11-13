import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class BackupError extends Error {
  constructor(message) { super(message); this.name = 'BackupError' }
}

const magic = Buffer.from('DRAFTMATTER-BACKUP-1\n')
const nonceBytes = 12
const tagBytes = 16
const headerBytes = magic.length + nonceBytes

async function writeAll(file, bytes, position) {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset)
    if (!bytesWritten) throw new BackupError('Backup output could not be written completely.')
    offset += bytesWritten
  }
}

export async function readBackupKey(path) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 ||
      (process.platform !== 'win32' && (details.mode & 0o077) !== 0)) {
    throw new BackupError('Backup key must be a private regular file (chmod 600), without links.')
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.nlink !== 1 || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)) {
      throw new BackupError('Backup key must be a private regular file (chmod 600), without links.')
    }
    if (opened.size !== 32) throw new BackupError('Backup key must contain exactly 32 random raw bytes.')
    return await file.readFile()
  } finally { await file.close() }
}

export async function encryptStream(source, destination, key) {
  if (key.length !== 32) throw new BackupError('Backup encryption needs a 32-byte key.')
  const nonce = randomBytes(nonceBytes)
  const header = Buffer.concat([magic, nonce])
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagBytes })
  cipher.setAAD(header)
  const file = await open(destination, 'wx', 0o600)
  let complete = false
  try {
    await writeAll(file, header, 0)
    let position = header.length
    const sink = new Writable({
      write(chunk, _encoding, done) {
        writeAll(file, chunk, position).then(() => { position += chunk.length; done() }, done)
      },
    })
    await pipeline(source, cipher, sink)
    const tag = cipher.getAuthTag()
    await writeAll(file, tag, position)
    await file.sync()
    complete = true
  } finally {
    await file.close()
    if (!complete) await unlink(destination).catch(() => undefined)
  }
}

async function encryptedFile(path, key) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new BackupError('Backup archive must be a regular file, without links.')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const initial = await file.stat()
    if (initial.size <= headerBytes + tagBytes) throw new BackupError('Backup archive is truncated.')
    const header = Buffer.alloc(headerBytes)
    await file.read(header, 0, header.length, 0)
    if (!header.subarray(0, magic.length).equals(magic)) throw new BackupError('Backup archive format is unsupported.')
    const tag = Buffer.alloc(tagBytes)
    await file.read(tag, 0, tag.length, initial.size - tagBytes)
    const stream = () => {
      const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length), { authTagLength: tagBytes })
      decipher.setAAD(header)
      decipher.setAuthTag(tag)
      const input = Readable.from((async function* () {
        for (let position = headerBytes; position < initial.size - tagBytes;) {
          const bytes = Buffer.alloc(Math.min(256 * 1024, initial.size - tagBytes - position))
          const { bytesRead } = await file.read(bytes, 0, bytes.length, position)
          if (!bytesRead) throw new BackupError('Backup archive is truncated.')
          position += bytesRead
          yield bytes.subarray(0, bytesRead)
        }
      })())
      input.on('error', (error) => decipher.destroy(error))
      decipher.once('close', () => input.destroy())
      return input.pipe(decipher)
    }
    return { file, initial, stream }
  } catch (error) {
    await file.close()
    throw error
  }
}

/** Authenticate the complete archive before exposing any plaintext to a restore. */
export async function withVerifiedPlaintext(path, key, consume) {
  const opened = await encryptedFile(path, key)
  try {
    try {
      await pipeline(opened.stream(), new Writable({ write(_chunk, _encoding, done) { done() } }))
    } catch {
      throw new BackupError('Backup authentication failed: wrong key, damaged archive, or incomplete backup.')
    }
    const checked = await opened.file.stat()
    if (checked.size !== opened.initial.size || checked.mtimeMs !== opened.initial.mtimeMs) {
      throw new BackupError('Backup archive changed during verification.')
    }
    const plaintext = opened.stream()
    try { return await consume(plaintext) }
    finally { plaintext.destroy() }
  } finally { await opened.file.close() }
}
