import { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { S3ProjectFileStorage } from './projectFileStorage'

function fixture() {
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  const send = vi.spyOn(client, 'send')
  const storage = new S3ProjectFileStorage('private-files', client)
  return { storage, send }
}
const key = 'draftmatter/workspaces/forest/projects/paper/files/file-123'
const metadata = { fileId: 'file-123', size: 10 }

describe('private multipart S3 file storage', () => {
  it('configures bounded real SDK requests without changing an explicitly injected S3 client', async () => {
    const storage = new S3ProjectFileStorage('private-files', { region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
    const client = (storage as unknown as { client: S3Client }).client
    const handler = client.config.requestHandler as unknown as {
      handle(request: unknown, options: { abortSignal: AbortSignal }): Promise<unknown>
      httpHandlerConfigs(): Record<string, unknown>
    }
    // Initializing the handler with a pre-aborted request opens no connection.
    await expect(handler.handle({ protocol: 'http:', hostname: '127.0.0.1', port: 9, method: 'HEAD', path: '/', headers: {} }, { abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(handler.httpHandlerConfigs()).toMatchObject({ connectionTimeout: 5_000, requestTimeout: 60_000, socketTimeout: 60_000, throwOnRequestTimeout: true })
    expect(await client.config.maxAttempts()).toBe(1)
    client.destroy()
    const injected = new S3Client({ region: 'us-east-1', maxAttempts: 2 })
    expect((new S3ProjectFileStorage('private-files', injected) as unknown as { client: S3Client }).client).toBe(injected)
    expect(await injected.config.maxAttempts()).toBe(2)
    injected.destroy()
  })

  it('terminates a ranged response body that never completes, even after successful response headers', async () => {
    const { storage, send } = fixture()
    const body = new Readable({ read() {} })
    send.mockResolvedValueOnce({ Body: body, ContentLength: 1 } as never)
    vi.useFakeTimers()
    try {
      const read = storage.readPart(key, 0, 1)
      const rejected = expect(read).rejects.toMatchObject({ name: 'ProjectFileStorageError' })
      await vi.advanceTimersByTimeAsync(60_001)
      await rejected
      expect(body.destroyed).toBe(true)
    } finally { vi.useRealTimers(); body.destroy() }
  })

  it('recovers an upload whose create response was lost, and creates encrypted uploads and immutable objects', async () => {
    const { storage, send } = fixture()
    send.mockResolvedValueOnce({ Uploads: [{ Key: `${key}-different`, UploadId: 'other' }] } as never)
      .mockResolvedValueOnce({ UploadId: 'new-upload' } as never)
    expect(await storage.begin(key, 'text/csv', metadata)).toBe('new-upload')
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateMultipartUploadCommand)
    expect(send.mock.calls[1][0].input).toMatchObject({ Bucket: 'private-files', Key: key, ContentType: 'text/csv', ServerSideEncryption: 'AES256', Metadata: { 'file-id': metadata.fileId, size: '10' } })
    send.mockResolvedValueOnce({ Uploads: [{ Key: key, UploadId: 'new-upload' }] } as never)
    expect(await storage.begin(key, 'text/csv', metadata)).toBe('new-upload')
    expect(send).toHaveBeenCalledTimes(3)
    send.mockResolvedValueOnce({ ETag: 'etag-1' } as never).mockResolvedValueOnce({} as never).mockResolvedValueOnce({} as never)
    const bytes = new Uint8Array([1, 2, 3])
    expect(await storage.putPart(key, 'new-upload', 1, bytes)).toBe('etag-1')
    expect(send.mock.calls[3][0]).toBeInstanceOf(UploadPartCommand)
    expect(send.mock.calls[3][0].input).toMatchObject({ ContentLength: 3, Body: bytes })
    await storage.complete(key, 'new-upload', [{ partNumber: 1, etag: 'etag-1' }])
    expect(send.mock.calls[4][0]).toBeInstanceOf(CompleteMultipartUploadCommand)
    expect(send.mock.calls[4][0].input).toMatchObject({ IfNoneMatch: '*', MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'etag-1' }] } })
    await storage.putEmpty(key, 'text/csv', { ...metadata, size: 0 })
    expect(send.mock.calls[5][0]).toBeInstanceOf(PutObjectCommand)
    expect(send.mock.calls[5][0].input).toMatchObject({ IfNoneMatch: '*', ServerSideEncryption: 'AES256' })
  })

  it('reads only bounded ranges and rejects providers that ignore Range or stream excess bytes', async () => {
    const { storage, send } = fixture()
    const body = Readable.from([new Uint8Array([7]), new Uint8Array([8, 9])])
    send.mockResolvedValueOnce({ Body: body, ContentLength: 3 } as never)
    expect(await storage.readPart(key, 8 * 1024 * 1024, 3)).toEqual(new Uint8Array([7, 8, 9]))
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand)
    expect(send.mock.calls[0][0].input).toMatchObject({ Range: 'bytes=8388608-8388610' })
    const ignored = Readable.from([new Uint8Array(1024)])
    const destroy = vi.spyOn(ignored, 'destroy')
    send.mockResolvedValueOnce({ Body: ignored, ContentLength: 1_000_000_000 } as never)
    await expect(storage.readPart(key, 0, 3)).rejects.toMatchObject({ name: 'ProjectFileStorageError' })
    expect(destroy).toHaveBeenCalled()
    send.mockResolvedValueOnce({ Body: Readable.from([new Uint8Array(4)]), ContentLength: 3 } as never)
    await expect(storage.readPart(key, 0, 3)).rejects.toMatchObject({ name: 'ProjectFileStorageError' })
    send.mockResolvedValueOnce({ Body: Readable.from([new Uint8Array(2)]), ContentLength: 3 } as never)
    await expect(storage.readPart(key, 0, 3)).rejects.toMatchObject({ name: 'ProjectFileStorageError' })
    const calls = send.mock.calls.length
    await expect(storage.readPart(key, -1, 1)).rejects.toThrow()
    await expect(storage.readPart(key, 0, 8 * 1024 * 1024 + 1)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(calls)
  })

  it('aborts every orphan session for one key and purges paginated workspace objects without touching neighbours', async () => {
    const { storage, send } = fixture()
    send.mockResolvedValueOnce({ Uploads: [{ Key: key, UploadId: 'one' }, { Key: key, UploadId: 'two' }, { Key: `${key}-neighbour`, UploadId: 'other' }] } as never)
      .mockResolvedValueOnce({} as never).mockRejectedValueOnce({ name: 'NoSuchUpload' })
    await storage.abort(key)
    expect(send.mock.calls.filter(([command]) => command instanceof AbortMultipartUploadCommand).map(([command]) => command.input)).toEqual([
      { Bucket: 'private-files', Key: key, UploadId: 'one' }, { Bucket: 'private-files', Key: key, UploadId: 'two' },
    ])
    send.mockClear()
    const prefix = 'draftmatter/workspaces/forest/projects/paper/files/'
    send.mockImplementation(async (command) => {
      if (command instanceof ListMultipartUploadsCommand) return { Uploads: [{ Key: key, UploadId: 'pending' }, { Key: 'draftmatter/workspaces/other/projects/paper/files/private', UploadId: 'other' }] } as never
      if (command instanceof ListObjectsV2Command) return command.input.ContinuationToken
        ? { Contents: [{ Key: `${prefix}second` }], IsTruncated: false } as never
        : { Contents: [{ Key: key }, { Key: 'draftmatter/workspaces/other/projects/paper/files/private' }], IsTruncated: true, NextContinuationToken: 'next' } as never
      return {} as never
    })
    await storage.purge(prefix)
    expect(send.mock.calls.filter(([command]) => command instanceof DeleteObjectCommand).map(([command]) => command.input)).toEqual([
      { Bucket: 'private-files', Key: key }, { Bucket: 'private-files', Key: `${prefix}second` },
    ])
    expect(send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command).map(([command]) => command.input)).toEqual([
      { Bucket: 'private-files', Prefix: prefix, ContinuationToken: undefined }, { Bucket: 'private-files', Prefix: prefix, ContinuationToken: 'next' },
    ])
  })

  it('only treats missing objects as absent, bounds errors and rejects unsafe keys before network access', async () => {
    const { storage, send } = fixture()
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } }).mockRejectedValueOnce(new Error('secret endpoint and access key'))
    expect(await storage.stat(key)).toBeUndefined()
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand)
    await expect(storage.stat(key)).rejects.toMatchObject({ message: 'Project file storage is temporarily unavailable. Retry the operation.' })
    const calls = send.mock.calls.length
    await expect(storage.begin('../escape', 'text/csv', metadata)).rejects.toThrow()
    await expect(storage.delete('/absolute')).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(calls)
  })
})
