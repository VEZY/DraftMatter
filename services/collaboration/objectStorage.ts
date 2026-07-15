import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

export interface StoredObject {
  bytes: Uint8Array
  contentType?: string
  metadata: Record<string, string>
}

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, options?: { contentType?: string; metadata?: Record<string, string>; immutable?: boolean }): Promise<void>
  get(key: string): Promise<StoredObject>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

export class ObjectStorageError extends Error {
  constructor(readonly code: 'not-found' | 'already-exists' | 'invalid-key' | 'transport', message: string) {
    super(message)
    this.name = 'ObjectStorageError'
  }
}

function safeKey(key: string) {
  if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => !part || part === '.' || part === '..') || key.length > 1024) {
    throw new ObjectStorageError('invalid-key', 'Object keys must be relative, normalized, and bounded.')
  }
  return key
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client
  constructor(private readonly bucket: string, configuration: S3ClientConfig) {
    if (!bucket.trim()) throw new Error('Object-storage bucket is required.')
    this.client = new S3Client(configuration)
  }

  async put(key: string, bytes: Uint8Array, options: { contentType?: string; metadata?: Record<string, string>; immutable?: boolean } = {}) {
    safeKey(key)
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: options.contentType ?? 'application/octet-stream',
        Metadata: options.metadata,
        ...(options.immutable ? { IfNoneMatch: '*' } : {}),
        ServerSideEncryption: 'AES256',
      }))
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 409 || status === 412) throw new ObjectStorageError('already-exists', 'Immutable collaboration object already exists.')
      throw new ObjectStorageError('transport', 'Object storage could not persist collaboration state.')
    }
  }

  async get(key: string): Promise<StoredObject> {
    safeKey(key)
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (!response.Body) throw new ObjectStorageError('not-found', 'Collaboration object was not found.')
      return {
        bytes: Uint8Array.from(await response.Body.transformToByteArray()),
        contentType: response.ContentType,
        metadata: response.Metadata ?? {},
      }
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404) throw new ObjectStorageError('not-found', 'Collaboration object was not found.')
      throw new ObjectStorageError('transport', 'Object storage could not read collaboration state.')
    }
  }

  async delete(key: string) {
    safeKey(key)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch {
      throw new ObjectStorageError('transport', 'Object storage could not delete collaboration state.')
    }
  }

  async list(prefix: string) {
    safeKey(`${prefix.replace(/\/$/, '')}/sentinel`)
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }))
      keys.push(...(response.Contents ?? []).flatMap((object) => object.Key ? [object.Key] : []))
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (continuationToken)
    return keys.sort()
  }
}

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>()

  async put(key: string, bytes: Uint8Array, options: { contentType?: string; metadata?: Record<string, string>; immutable?: boolean } = {}) {
    safeKey(key)
    if (options.immutable && this.objects.has(key)) throw new ObjectStorageError('already-exists', 'Immutable collaboration object already exists.')
    this.objects.set(key, { bytes: Uint8Array.from(bytes), contentType: options.contentType, metadata: { ...(options.metadata ?? {}) } })
  }

  async get(key: string) {
    safeKey(key)
    const object = this.objects.get(key)
    if (!object) throw new ObjectStorageError('not-found', 'Collaboration object was not found.')
    return { bytes: Uint8Array.from(object.bytes), contentType: object.contentType, metadata: { ...object.metadata } }
  }

  async delete(key: string) {
    safeKey(key)
    this.objects.delete(key)
  }

  async list(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
  }
}
