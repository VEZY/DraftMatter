import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { downloadProjectFile, projectFileScopeKey, type DownloadDirectory, type DownloadFileHandle, type ProjectFileDownloadDependencies } from './projectFileDownload'
import { PROJECT_FILE_CHUNK_BYTES, type ProjectFile } from './projectFiles'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const small = new TextEncoder().encode('abc')
function metadata(parts = [small], overrides: Partial<ProjectFile> = {}): ProjectFile {
  return { id: 'version-one', path: 'data/measurements.csv', size: parts.reduce((size, part) => size + part.length, 0), mediaType: 'text/csv', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: parts.map((bytes, index) => ({ partNumber: index + 1, size: bytes.length, sha256: hash(bytes) })), createdAt: '2026-11-11T10:00:00Z', createdBy: 'alice', ...overrides }
}
const scope = (file: ProjectFile, overrides = {}) => projectFileScopeKey({ serviceUrl: 'https://collab.example.test', userId: 'alice', workspaceId: 'workspace', projectId: 'project', fileId: file.id, ...overrides })
class DiskFile implements DownloadFileHandle {
  bytes = new Uint8Array()
  constructor(readonly name: string, private readonly reads: string[], private readonly writes: number[]) {}
  async getFile() {
    const snapshot = new File([this.bytes.slice().buffer], this.name)
    const original = snapshot.arrayBuffer.bind(snapshot)
    Object.defineProperty(snapshot, 'arrayBuffer', { value: () => {
      this.reads.push(this.name)
      if (snapshot.size > PROJECT_FILE_CHUNK_BYTES) throw new Error('Whole-file arrayBuffer is forbidden')
      return original()
    } })
    return snapshot
  }
  async createWritable() {
    const parts: Uint8Array[] = []
    return {
      write: async (data: ArrayBuffer | string) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.writes.push(bytes.length); parts.push(bytes.slice())
      },
      close: async () => {
        const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
        let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length }
        this.bytes = bytes
      },
      abort: async () => {},
    }
  }
}
class DiskDirectory implements DownloadDirectory {
  readonly directories = new Map<string, DiskDirectory>()
  readonly files = new Map<string, DiskFile>()
  constructor(readonly reads: string[] = [], readonly writes: number[] = []) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DiskDirectory> {
    if (!this.directories.has(name)) { if (!options?.create) throw new DOMException('Missing', 'NotFoundError'); this.directories.set(name, new DiskDirectory(this.reads, this.writes)) }
    return this.directories.get(name)!
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<DiskFile> {
    if (!this.files.has(name)) { if (!options?.create) throw new DOMException('Missing', 'NotFoundError'); this.files.set(name, new DiskFile(name, this.reads, this.writes)) }
    return this.files.get(name)!
  }
  async removeEntry(name: string) { this.files.delete(name) }
}
function browser(root = new DiskDirectory()) {
  const save = vi.fn<(file: Blob, name: string) => void>()
  const dependencies: ProjectFileDownloadDependencies = { desktop: null, getDirectory: async () => root, saveBlob: save }
  const session = () => [...root.directories.get('draftmatter-downloads')!.directories.values()][0]
  return { root, save, dependencies, session }
}

describe('bounded resumable project file downloads', () => {
  it('resumes verified disk parts after a failed request, ignoring a forged progress marker, and never reads the assembled file', async () => {
    const first = new Uint8Array(PROJECT_FILE_CHUNK_BYTES).fill(7), file = metadata([first, small]), fixture = browser()
    const failing = vi.fn(async (number: number) => { if (number === 1) return first; throw new Error('Connection lost') })
    await expect(downloadProjectFile({ file, scopeKey: scope(file), readPart: failing }, fixture.dependencies)).rejects.toThrow('Connection lost')
    fixture.session().files.get('progress.json')!.bytes = new TextEncoder().encode('{"completedParts":[1,2]}')
    const read = vi.fn(async () => small), progress = vi.fn()
    await expect(downloadProjectFile({ file, scopeKey: scope(file), readPart: read, onProgress: progress }, fixture.dependencies)).resolves.toEqual({ status: 'download-started', resumedParts: 1 })
    expect(read).toHaveBeenCalledExactlyOnceWith(2, expect.any(AbortSignal))
    expect(progress).toHaveBeenNthCalledWith(1, first.length, file.size)
    expect(fixture.save.mock.calls[0][0].size).toBe(file.size)
    expect(fixture.root.reads).not.toContain('complete-file')
    expect(Math.max(...fixture.root.writes)).toBeLessThanOrEqual(PROJECT_FILE_CHUNK_BYTES)
  })

  it('rehashes cached bytes rather than trusting length and redownloads a same-length corrupt part', async () => {
    const file = metadata(), fixture = browser(), read = vi.fn(async () => small)
    await downloadProjectFile({ file, scopeKey: scope(file), readPart: read }, fixture.dependencies)
    fixture.session().files.get('part-1')!.bytes = new TextEncoder().encode('bad')
    read.mockClear()
    const result = await downloadProjectFile({ file, scopeKey: scope(file), readPart: read }, fixture.dependencies)
    expect(result.resumedParts).toBe(0); expect(read).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(fixture.session().files.get('part-1')!.bytes)).toBe('abc')
  })

  it('verifies a cached final file before reuse and repairs it from verified disk parts without refetching', async () => {
    const file = metadata(), fixture = browser()
    await downloadProjectFile({ file, scopeKey: scope(file), readPart: async () => small }, fixture.dependencies)
    fixture.session().files.get('complete-file')!.bytes = new TextEncoder().encode('bad')
    const read = vi.fn(async () => small)
    const result = await downloadProjectFile({ file, scopeKey: scope(file), readPart: read }, fixture.dependencies)
    expect(result.resumedParts).toBe(1); expect(read).not.toHaveBeenCalled()
    expect(await fixture.save.mock.calls.at(-1)![0].text()).toBe('abc')
  })

  it('rejects corrupt network parts before persistence or final download', async () => {
    const file = metadata(), fixture = browser()
    await expect(downloadProjectFile({ file, scopeKey: scope(file), readPart: async () => new TextEncoder().encode('bad') }, fixture.dependencies)).rejects.toThrow(/SHA-256/)
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.session().files.has('part-1')).toBe(false)
  })

  it('isolates every service, account, workspace, project, and immutable file version cache', async () => {
    const file = metadata(), fixture = browser()
    await downloadProjectFile({ file, scopeKey: scope(file), readPart: async () => small }, fixture.dependencies)
    for (const changed of [{ serviceUrl: 'https://other.example.test' }, { userId: 'bob' }, { workspaceId: 'other-workspace' }, { projectId: 'other-project' }, { fileId: 'other-version' }]) {
      const candidate = changed.fileId ? { ...file, id: changed.fileId } : file
      const read = vi.fn(async () => small)
      await expect(downloadProjectFile({ file: candidate, scopeKey: scope(candidate, changed), readPart: read }, fixture.dependencies)).resolves.toMatchObject({ resumedParts: 0 })
      expect(read).toHaveBeenCalledOnce()
    }
    const read = vi.fn(async () => small)
    await expect(downloadProjectFile({ file: { ...file, parts: file.parts.map(({ sha256, size, partNumber }) => ({ sha256, size, partNumber })) }, scopeKey: scope(file), readPart: read }, fixture.dependencies)).resolves.toMatchObject({ resumedParts: 1 })
    expect(read).not.toHaveBeenCalled()
  })

  it('cancels after a persisted part and resumes it on the next attempt', async () => {
    const first = new Uint8Array(PROJECT_FILE_CHUNK_BYTES), file = metadata([first, small]), fixture = browser(), controller = new AbortController()
    const result = await downloadProjectFile({ file, scopeKey: scope(file), readPart: async () => first, signal: controller.signal, onProgress: (bytes) => { if (bytes) controller.abort() } }, fixture.dependencies)
    expect(result.status).toBe('cancelled'); expect(fixture.save).not.toHaveBeenCalled()
    const read = vi.fn(async () => small)
    expect((await downloadProjectFile({ file, scopeKey: scope(file), readPart: read }, fixture.dependencies)).resumedParts).toBe(1)
    expect(read).toHaveBeenCalledExactlyOnceWith(2, expect.any(AbortSignal))
  })

  it('refuses a 1 GB in-memory fallback before fetching any bytes', async () => {
    const size = 1_000_000_000
    const parts = Array.from({ length: Math.ceil(size / PROJECT_FILE_CHUNK_BYTES) }, (_, index) => ({ partNumber: index + 1, size: Math.min(PROJECT_FILE_CHUNK_BYTES, size - index * PROJECT_FILE_CHUNK_BYTES), sha256: '0'.repeat(64) }))
    const file = metadata([], { size, parts }), read = vi.fn(async () => small)
    await expect(downloadProjectFile({ file, scopeKey: scope(file), readPart: read }, { desktop: null, getDirectory: null, saveBlob: vi.fn() })).rejects.toThrow(/on-disk storage.*desktop/)
    expect(read).not.toHaveBeenCalled()
  })

  it('allows an explicitly bounded small-file fallback when OPFS is unavailable', async () => {
    const file = metadata(), save = vi.fn()
    await expect(downloadProjectFile({ file, scopeKey: scope(file), readPart: async () => small }, { desktop: null, getDirectory: null, saveBlob: save })).resolves.toMatchObject({ status: 'download-started' })
    expect(await save.mock.calls[0][0].text()).toBe('abc')
  })

  it('rejects an incorrect version scope before filesystem or network access', async () => {
    const file = metadata(), directory = vi.fn(async () => new DiskDirectory()), read = vi.fn(async () => small)
    await expect(downloadProjectFile({ file, scopeKey: scope(file, { fileId: 'another-version' }), readPart: read }, { desktop: null, getDirectory: directory })).rejects.toThrow(/scope/)
    expect(directory).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  })

  it('uses the native disk cache and save dialog with only missing bounded parts over IPC', async () => {
    const first = new Uint8Array(PROJECT_FILE_CHUNK_BYTES), file = metadata([first, small])
    const desktop = {
      available: true,
      beginProjectFileDownload: vi.fn().mockResolvedValue({ operationId: 'opaque-operation', completedParts: [1], completedBytes: first.length, totalBytes: file.size }),
      writeProjectFileDownloadPart: vi.fn().mockResolvedValue(undefined),
      saveProjectFileDownload: vi.fn().mockResolvedValue({ path: '/user/chosen.csv', bytes: file.size }),
      cancelProjectFileDownload: vi.fn().mockResolvedValue(undefined),
    }
    const read = vi.fn(async () => small)
    await expect(downloadProjectFile({ file, scopeKey: scope(file), readPart: read }, { desktop })).resolves.toEqual({ status: 'saved', resumedParts: 1 })
    expect(read).toHaveBeenCalledExactlyOnceWith(2, expect.any(AbortSignal))
    expect(desktop.writeProjectFileDownloadPart).toHaveBeenCalledExactlyOnceWith({ cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/), operationId: 'opaque-operation', partNumber: 2, bytes: [97, 98, 99] })
    expect(desktop.saveProjectFileDownload).toHaveBeenCalledExactlyOnceWith({ cacheKey: expect.any(String), operationId: 'opaque-operation' })
  })

  it('honors native cancellation while preserving the resumable cache', async () => {
    const file = metadata(), controller = new AbortController()
    const desktop = { available: true, beginProjectFileDownload: vi.fn().mockResolvedValue({ operationId: 'opaque', completedParts: [] }), writeProjectFileDownloadPart: vi.fn(), saveProjectFileDownload: vi.fn(), cancelProjectFileDownload: vi.fn().mockResolvedValue(undefined) }
    const result = await downloadProjectFile({ file, scopeKey: scope(file), signal: controller.signal, readPart: async () => { controller.abort(); return small } }, { desktop })
    expect(result.status).toBe('cancelled'); expect(desktop.cancelProjectFileDownload).toHaveBeenCalledWith('opaque')
    expect(desktop.writeProjectFileDownloadPart).not.toHaveBeenCalled(); expect(desktop.saveProjectFileDownload).not.toHaveBeenCalled()
  })
})
