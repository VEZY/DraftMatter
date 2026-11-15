import { beforeAll, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createProjectSyncRemote, ProjectSyncRemoteAdapter, projectSyncContentHash, projectSyncLiveTextVersion, type ProjectSyncRemoteOptions } from './projectSyncRemote'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFileCatalogue, type ProjectFileHead, type ProjectFileUpload } from './collaboration/projectFiles'
import type { ProjectFileTransferOptions, ProjectFileSource } from './collaboration/projectFileClient'
import { MAX_SELECTIVE_SYNC_FILE_BYTES } from './selectiveSync'
import { canonicalizeSyncPreview } from './projectSyncReferences'

beforeAll(() => { if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto) })
const text = (value: string) => new TextEncoder().encode(value)
const conflict = () => Object.assign(new Error('The server head changed.'), { code: 'file-version-conflict', status: 409 })

function fixture() {
  let nextId = 0, writer = true
  const heads = new Map<string, ProjectFileHead>()
  const versions = new Map<string, { file: ProjectFile; bytes: Uint8Array }>()
  const visible = new Map<string, Uint8Array>()
  const uploads: ProjectFileUpload[] = []
  let transferHook: (() => void | Promise<void>) | undefined
  const add = async (path: string, bytes: Uint8Array) => {
    const id = `file-${++nextId}`
    const file: ProjectFile = { id, path, size: bytes.length, mediaType: path.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', createdAt: '2026-11-13T12:00:00Z', createdBy: 'alice', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: bytes.length ? [{ partNumber: 1, size: bytes.length, sha256: (await projectSyncContentHash(bytes)).slice(7) }] : [] }
    versions.set(id, { file, bytes: Uint8Array.from(bytes) }); heads.set(path, { path, versionId: id, deleted: false })
    return file
  }
  const api = {
    currentUserId: 'alice',
    catalogue: vi.fn(async (): Promise<ProjectFileCatalogue> => structuredClone({ files: [...versions.values()].map((entry) => entry.file), uploads, heads: [...heads.values()], quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: 0, reservedBytes: 0 } })),
    readPart: vi.fn(async (file: ProjectFile, partNumber: number) => {
      const entry = versions.get(file.id)!
      return entry.bytes.slice((partNumber - 1) * file.chunkSize, Math.min(partNumber * file.chunkSize, file.size))
    }),
    cancel: vi.fn(async (id: string) => { const index = uploads.findIndex((upload) => upload.id === id); if (index >= 0) uploads.splice(index, 1) }),
    transfer: vi.fn(async (source: ProjectFileSource, path: string, options: ProjectFileTransferOptions = {}) => {
      if ((heads.get(path)?.versionId ?? null) !== options.expectedVersionId) throw conflict()
      const bytes = new Uint8Array(await source.slice(0, source.size).arrayBuffer())
      await transferHook?.()
      if ((heads.get(path)?.versionId ?? null) !== options.expectedVersionId) throw conflict()
      return add(path, bytes)
    }),
  }
  const publishPreview = vi.fn(async (path: string, bytes: Uint8Array, expectedHash: string | null): Promise<Uint8Array | void> => {
    const current = visible.get(path)
    if ((current ? await projectSyncContentHash(current) : null) !== expectedHash) throw conflict()
    visible.set(path, Uint8Array.from(bytes))
  })
  const options: ProjectSyncRemoteOptions = {
    api, canUpload: () => writer,
    getPreviews: async () => [...visible].map(([path, bytes]) => ({ path, bytes })),
    publishPreview,
  }
  return { api, heads, versions, visible, uploads, options, publishPreview, add,
    setWriter(value: boolean) { writer = value }, setTransferHook(hook: typeof transferHook) { transferHook = hook } }
}

function referenceFixture() {
  const backend = fixture()
  backend.options.canonicalizePreview = canonicalizeSyncPreview
  backend.publishPreview.mockImplementation(async (path, bytes, expectedHash) => {
    const canonical = await canonicalizeSyncPreview(path, bytes)
    const current = backend.visible.get(path)
    if ((current ? await projectSyncContentHash(current) : null) !== expectedHash) throw conflict()
    if (new TextDecoder().decode(canonical).trim() === '[]') backend.visible.delete(path)
    else backend.visible.set(path, canonical)
    return canonical
  })
  return backend
}

describe('live manuscript and immutable file synchronization adapter', () => {
  it('keeps inspection read-only and bootstraps a selected preview only through a guarded write', async () => {
    const backend = fixture(), path = 'figures/plot.svg', bytes = text('visible figure')
    backend.visible.set(path, bytes)
    const remote = new ProjectSyncRemoteAdapter(backend.options)
    const [record] = await remote.list({}, [path])
    expect(record).toMatchObject({ path, versionId: expect.stringMatching(/^live-preview:none:/), hash: await projectSyncContentHash(bytes) })
    expect(backend.api.transfer).not.toHaveBeenCalled()
    expect(backend.publishPreview).not.toHaveBeenCalled()
    expect(await remote.read(path, record.versionId)).toEqual(bytes)
    const written = await remote.write(path, bytes, record.versionId)
    expect(written.versionId).toBe('file-1')
    expect(backend.api.transfer).toHaveBeenCalledWith(expect.any(Blob), path, expect.objectContaining({ expectedVersionId: null }))
    expect((await remote.list({}, [path]))[0]).toMatchObject({ versionId: 'file-1', hash: record.hash })
  })

  it('keeps virtual baselines stable while the underlying file head remains absent or unchanged', async () => {
    const backend = fixture(), path = 'references.json', before = text('old'), after = text('new preview')
    backend.visible.set(path, after)
    const remote = createProjectSyncRemote(backend.options)
    const [initial] = await remote.list({}, [path])
    const baseline = { localHash: initial.hash!, remoteVersionId: initial.versionId }
    expect((await remote.list({ [path]: baseline }, [path]))[0]).toMatchObject({ versionId: initial.versionId, hash: initial.hash })
    const file = await backend.add(path, before)
    const firstBaseline = { localHash: await projectSyncContentHash(before), remoteVersionId: file.id }
    const [changed] = await remote.list({ [path]: firstBaseline }, [path])
    expect(changed.versionId).toMatch(/^live-preview:file-1:/)
    expect(changed.conflict).toBeUndefined()
    expect((await remote.list({ [path]: { localHash: changed.hash!, remoteVersionId: changed.versionId } }, [path]))[0]).toMatchObject({ versionId: changed.versionId, hash: changed.hash })
    expect(backend.api.transfer).not.toHaveBeenCalled()
  })

  it('uses a newer file head when its old preview is unchanged, then mirrors the download with a hash guard', async () => {
    const backend = fixture(), path = 'figures/plot.svg', before = text('old'), after = text('new file')
    const original = await backend.add(path, before)
    backend.visible.set(path, before)
    const newest = await backend.add(path, after)
    const remote = createProjectSyncRemote(backend.options)
    const [record] = await remote.list({ [path]: { localHash: await projectSyncContentHash(before), remoteVersionId: original.id } }, [path])
    expect(record).toMatchObject({ versionId: expect.stringMatching(new RegExp(`^live-head:${newest.id}:`)), hash: await projectSyncContentHash(after) })
    expect(record.conflict).toBeUndefined()
    expect(backend.publishPreview).not.toHaveBeenCalled()
    expect(await remote.read(path, record.versionId)).toEqual(after)
    expect(backend.publishPreview).toHaveBeenCalledWith(path, after, await projectSyncContentHash(before))
    expect(backend.visible.get(path)).toEqual(after)
  })

  it('compares immutable and virtual copies without publishing any preview even for an editor', async () => {
    const backend = fixture(), path = 'figures/plot.svg', before = text('old'), after = text('new file')
    const original = await backend.add(path, before)
    backend.visible.set(path, before)
    await backend.add(path, after)
    const remote = new ProjectSyncRemoteAdapter(backend.options)
    const [head] = await remote.list({ [path]: { localHash: await projectSyncContentHash(before), remoteVersionId: original.id } }, [path])
    expect(await remote.readCopy(path, head.versionId)).toEqual(after)
    expect(backend.visible.get(path)).toEqual(before)
    backend.visible.set(path, text('preview edited too'))
    const [virtual] = await remote.list({}, [path])
    expect(await remote.readCopy(path, virtual.versionId)).toEqual(text('preview edited too'))
    expect(backend.api.transfer).not.toHaveBeenCalled()
    expect(backend.api.cancel).not.toHaveBeenCalled()
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('recognizes compact and reordered reference bytes on first join without changing the original file', async () => {
    const backend = referenceFixture(), path = 'references.json'
    const raw = text('[{"title":"Second","id":"b"},{"id":"a","title":"First","custom":{"z":1,"a":2}}]')
    const file = await backend.add(path, raw)
    backend.visible.set(path, await canonicalizeSyncPreview(path, raw))
    const remote = createProjectSyncRemote(backend.options)
    const [record] = await remote.list({}, [path])
    expect(record).toMatchObject({ versionId: file.id, hash: await projectSyncContentHash(raw) })
    expect(record.conflict).toBeUndefined()
    expect(await remote.readCopy(path, record.versionId)).toEqual(raw)
    expect(backend.versions.get(file.id)?.bytes).toEqual(raw)
    expect(backend.api.transfer).not.toHaveBeenCalled()
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('detects a newer raw reference head against its unchanged canonical preview and mirrors only metadata', async () => {
    const backend = referenceFixture(), path = 'references.json'
    const before = text('[{"title":"Before","id":"study"}]'), after = text('[ {"id":"study", "title":"After"} ]')
    const original = await backend.add(path, before)
    backend.visible.set(path, await canonicalizeSyncPreview(path, before))
    const newest = await backend.add(path, after)
    const remote = createProjectSyncRemote(backend.options)
    const [record] = await remote.list({ [path]: { localHash: await projectSyncContentHash(before), remoteVersionId: original.id } }, [path])
    expect(record.versionId).toMatch(new RegExp(`^live-head:${newest.id}:`))
    expect(record.conflict).toBeUndefined()
    expect(await remote.read(path, record.versionId)).toEqual(after)
    expect(backend.visible.get(path)).toEqual(await canonicalizeSyncPreview(path, after))
    const baseline = { localHash: await projectSyncContentHash(after), remoteVersionId: record.versionId }
    expect((await createProjectSyncRemote(backend.options).list({ [path]: baseline }, [path]))[0]).toMatchObject({ versionId: newest.id, hash: baseline.localHash })
    expect(backend.versions.get(newest.id)?.bytes).toEqual(after)
    expect(backend.api.transfer).not.toHaveBeenCalled()
  })

  it('publishes compact external reference bytes exactly while accepting the guarded canonical metadata projection', async () => {
    const backend = referenceFixture(), path = 'references.json'
    const before = text('[{"id":"old","title":"Before"}]')
    const original = await backend.add(path, before)
    backend.visible.set(path, await canonicalizeSyncPreview(path, before))
    const raw = text('[{"title":"New second","id":"b"},{"id":"a","title":"First","unknown":{"preserved":true}}]')
    const remote = createProjectSyncRemote(backend.options)
    await remote.list({}, [path])
    const written = await remote.write(path, raw, original.id)
    expect(written.versionId).toBe('file-2')
    expect(written.bytes).toEqual(raw)
    expect(backend.versions.get(written.versionId)?.bytes).toEqual(raw)
    expect(backend.visible.get(path)).toEqual(await canonicalizeSyncPreview(path, raw))
    const baseline = { localHash: await projectSyncContentHash(raw), remoteVersionId: written.versionId }
    const [record] = await createProjectSyncRemote(backend.options).list({ [path]: baseline }, [path])
    expect(record).toMatchObject({ versionId: written.versionId, hash: baseline.localHash })
    expect(record.conflict).toBeUndefined()
    expect(backend.api.transfer).toHaveBeenCalledOnce()
  })

  it('preserves concurrently changed reference metadata instead of treating all canonical references as equal', async () => {
    const backend = referenceFixture(), path = 'references.json'
    const before = text('[{"id":"study","title":"Before"}]')
    const original = await backend.add(path, before)
    backend.visible.set(path, await canonicalizeSyncPreview(path, before))
    const incoming = text('[{"title":"Local edit","id":"study"}]')
    const concurrent = await canonicalizeSyncPreview(path, text('[{"id":"study","title":"Peer edit"}]'))
    const remote = createProjectSyncRemote(backend.options)
    await remote.list({}, [path])
    backend.setTransferHook(() => { backend.visible.set(path, concurrent) })
    await expect(remote.write(path, incoming, original.id)).rejects.toMatchObject({ code: 'file-version-conflict' })
    expect(backend.visible.get(path)).toEqual(concurrent)
    expect(backend.versions.get(backend.heads.get(path)!.versionId)?.bytes).toEqual(incoming)
    expect(backend.versions.get(original.id)?.bytes).toEqual(before)
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('can publish an empty reference file whose metadata projection removes the last citation', async () => {
    const backend = referenceFixture(), path = 'references.json', before = text('[{"id":"study","title":"Before"}]')
    const original = await backend.add(path, before)
    backend.visible.set(path, await canonicalizeSyncPreview(path, before))
    const remote = createProjectSyncRemote(backend.options)
    const written = await remote.write(path, text('[ ]'), original.id)
    expect(backend.versions.get(written.versionId)?.bytes).toEqual(text('[ ]'))
    expect(backend.visible.has(path)).toBe(false)
    expect((await remote.list({}, [path]))[0].versionId).toBe(written.versionId)
  })

  it('surfaces head/preview divergence and validates both channels before accepting an explicit choice', async () => {
    const backend = fixture(), path = 'figures/plot.svg', originalBytes = text('base')
    const original = await backend.add(path, originalBytes)
    const newer = await backend.add(path, text('head change'))
    backend.visible.set(path, text('preview change'))
    const remote = createProjectSyncRemote(backend.options)
    const [record] = await remote.list({ [path]: { localHash: await projectSyncContentHash(originalBytes), remoteVersionId: original.id } }, [path])
    expect(record.conflict).toMatch(/different versions/)
    expect(record.versionId).toMatch(new RegExp(`^live-preview:${newer.id}:`))
    const bytes = await remote.read(path, record.versionId)
    const written = await remote.write(path, bytes, record.versionId)
    expect(backend.api.transfer).toHaveBeenCalledWith(expect.any(Blob), path, expect.objectContaining({ expectedVersionId: newer.id }))
    expect(backend.versions.get(written.versionId)?.bytes).toEqual(text('preview change'))
    expect(backend.versions.get(newer.id)?.bytes).toEqual(text('head change'))
  })

  it('rejects a stale virtual preview or stale file head before publishing any replacement', async () => {
    const backend = fixture(), path = 'figures/plot.svg'
    backend.visible.set(path, text('first'))
    const remote = createProjectSyncRemote(backend.options)
    const [record] = await remote.list({}, [path])
    backend.visible.set(path, text('second'))
    await expect(remote.read(path, record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    await expect(remote.write(path, text('local'), record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    backend.visible.set(path, text('first'))
    await backend.add(path, text('new server file'))
    await expect(remote.write(path, text('local'), record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    expect(backend.api.transfer).not.toHaveBeenCalled()
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('preserves a newly edited preview when it changes while a guarded upload is in flight', async () => {
    const backend = fixture(), path = 'figures/plot.svg', original = text('base')
    const head = await backend.add(path, original)
    backend.visible.set(path, original)
    const remote = createProjectSyncRemote(backend.options)
    await remote.list({}, [path])
    backend.setTransferHook(() => { backend.visible.set(path, text('concurrent preview')) })
    await expect(remote.write(path, text('local changed'), head.id)).rejects.toMatchObject({ code: 'file-version-conflict' })
    expect(backend.visible.get(path)).toEqual(text('concurrent preview'))
    expect(backend.versions.get(backend.heads.get(path)!.versionId)?.bytes).toEqual(text('local changed'))
    expect(backend.versions.get(head.id)?.bytes).toEqual(original)
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('provides read-only downloads without publishing previews and refuses uploads', async () => {
    const backend = fixture(), path = 'figures/plot.svg'
    const file = await backend.add(path, text('new head'))
    backend.visible.set(path, text('old preview'))
    backend.setWriter(false)
    const remote = createProjectSyncRemote(backend.options)
    expect(remote.canWrite()).toBe(false)
    expect(await remote.read(path, file.id)).toEqual(text('new head'))
    expect(backend.visible.get(path)).toEqual(text('old preview'))
    await expect(remote.write(path, text('new local'), file.id)).rejects.toThrow(/role allows downloading/)
    expect(backend.api.transfer).not.toHaveBeenCalled()
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('requires a sync-capable catalogue and refuses oversized or incomplete downloads before changing files', async () => {
    const backend = fixture()
    const remote = createProjectSyncRemote(backend.options)
    backend.api.catalogue.mockResolvedValueOnce({ files: [], uploads: [], quota: { limitBytes: 1, usedBytes: 0, reservedBytes: 0 } })
    await expect(remote.list()).rejects.toThrow(/Upgrade the server/)
    const file = await backend.add('data/large.bin', text('tiny'))
    backend.versions.get(file.id)!.file.size = MAX_SELECTIVE_SYNC_FILE_BYTES + 1
    expect((await remote.list({}, [file.path]))[0].size).toBe(MAX_SELECTIVE_SYNC_FILE_BYTES + 1)
    await expect(remote.read(file.path, file.id)).rejects.toThrow(/32 MiB/)
    expect(backend.api.readPart).not.toHaveBeenCalled()
    backend.versions.get(file.id)!.file.size = 5
    backend.api.readPart.mockResolvedValueOnce(text('wrong'))
    await expect(remote.read(file.path, file.id)).rejects.toThrow(/integrity check/)
  })

  it('uses the live text revision and never creates a duplicate manuscript file head', async () => {
    const backend = fixture()
    let current = text('# Shared paper')
    const write = vi.fn(async (bytes: Uint8Array, expectedVersionId: string) => {
      expect(expectedVersionId).toBe(await projectSyncLiveTextVersion(current))
      current = text(new TextDecoder().decode(bytes) + '\n')
      return { versionId: await projectSyncLiveTextVersion(current), bytes: current }
    })
    const remote = createProjectSyncRemote({ ...backend.options, liveManuscript: { path: 'paper.qmd', read: async () => current, write } })
    const [record] = await remote.list()
    expect(record).toMatchObject({ path: 'paper.qmd', versionId: await projectSyncLiveTextVersion(current), hash: await projectSyncContentHash(current) })
    const result = await remote.write('paper.qmd', text('# Revised'), record.versionId)
    expect(result.bytes).toEqual(text('# Revised\n'))
    expect(await remote.read('paper.qmd', result.versionId)).toEqual(result.bytes)
    await expect(remote.read('paper.qmd', record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    await expect(remote.write('paper.qmd', text('stale'), record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    expect(write).toHaveBeenCalledOnce()
    expect(backend.api.transfer).not.toHaveBeenCalled()
  })

  it('cancels only the current account’s stale upload bases and leaves recovery images outside live previews', async () => {
    const backend = fixture(), path = 'data/observations.csv'
    const head = await backend.add(path, text('server'))
    const upload = { id: 'upload-stale', path, size: 3, mediaType: 'text/csv', createdAt: '', updatedAt: '', createdBy: 'alice', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [], status: 'uploading' as const, expectedVersionId: 'file-old' }
    backend.uploads.push(upload, { ...upload, id: 'upload-peer', createdBy: 'bob' })
    const remote = createProjectSyncRemote(backend.options)
    await remote.write(path, text('new'), head.id)
    expect(backend.api.cancel).toHaveBeenCalledExactlyOnceWith('upload-stale')
    const recovery = 'figures/plot.conflict-online-1234abcd.svg'
    await remote.write(recovery, text('preserved'), null)
    expect(backend.heads.has(recovery)).toBe(true)
    expect(backend.publishPreview.mock.calls.some(([path]) => path === recovery)).toBe(false)
  })
  it('stops publication if access changes while remote metadata is being read', async () => {
    const backend = fixture(), path = 'data/observations.csv'
    let resolve!: (value: ProjectFileCatalogue) => void
    const pending = new Promise<ProjectFileCatalogue>((done) => { resolve = done })
    backend.api.catalogue.mockReturnValueOnce(pending)
    const remote = createProjectSyncRemote(backend.options)
    const publishing = remote.write(path, text('new local'), null)
    backend.setWriter(false)
    resolve({ files: [], uploads: [], heads: [], quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: 0, reservedBytes: 0 } })
    await expect(publishing).rejects.toThrow(/role allows downloading/)
    expect(backend.api.cancel).not.toHaveBeenCalled()
    expect(backend.api.transfer).not.toHaveBeenCalled()
  })

  it('stops an entered multipart transfer before subsequent publication when the session closes', async () => {
    const backend = fixture(), path = 'data/observations.csv'
    backend.api.transfer.mockImplementationOnce(async (_source, _path, options = {}) => {
      backend.setWriter(false)
      options.onUpload?.({ id: 'upload-pending', path, size: 2, mediaType: 'text/csv', createdAt: '', updatedAt: '', createdBy: 'alice', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [], status: 'uploading', expectedVersionId: null })
      expect(options.signal?.aborted).toBe(true)
      throw new DOMException('Transfer paused', 'AbortError')
    })
    const remote = createProjectSyncRemote(backend.options)
    await expect(remote.write(path, text('new local'), null)).rejects.toMatchObject({ name: 'AbortError' })
    expect(backend.heads.size).toBe(0)
    expect(backend.publishPreview).not.toHaveBeenCalled()
  })

  it('retains readonly head-wins evidence across two passes and a new adapter without reverting to a stale preview', async () => {
    const backend = fixture(), path = 'figures/plot.svg', oldBytes = text('old preview'), newBytes = text('new head')
    const original = await backend.add(path, oldBytes)
    backend.visible.set(path, oldBytes)
    const newest = await backend.add(path, newBytes)
    backend.setWriter(false)
    const remote = createProjectSyncRemote(backend.options)
    const [first] = await remote.list({ [path]: { localHash: await projectSyncContentHash(oldBytes), remoteVersionId: original.id } }, [path])
    expect(first.versionId).toMatch(new RegExp(`^live-head:${newest.id}:`))
    expect(await remote.read(path, first.versionId)).toEqual(newBytes)
    const baseline = { localHash: await projectSyncContentHash(newBytes), remoteVersionId: first.versionId }
    const [second] = await remote.list({ [path]: baseline }, [path])
    expect(second).toMatchObject({ versionId: first.versionId, hash: baseline.localHash })
    const reconnected = createProjectSyncRemote(backend.options)
    expect((await reconnected.list({ [path]: baseline }, [path]))[0]).toMatchObject({ versionId: first.versionId, hash: baseline.localHash })
    expect(backend.visible.get(path)).toEqual(oldBytes)
    expect(backend.publishPreview).not.toHaveBeenCalled()
    backend.visible.set(path, text('actually edited preview'))
    const [changed] = await reconnected.list({ [path]: baseline }, [path])
    expect(changed.versionId).toMatch(/^live-preview:/)
    expect(changed.hash).toBe(await projectSyncContentHash(text('actually edited preview')))
    await expect(reconnected.read(path, first.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
  })

  it('guards opaque head-wins tokens against changes to either the head or the observed preview', async () => {
    const backend = fixture(), path = 'figures/plot.svg', before = text('base')
    const first = await backend.add(path, before)
    backend.visible.set(path, before)
    const latest = await backend.add(path, text('new head'))
    const remote = createProjectSyncRemote(backend.options)
    const [record] = await remote.list({ [path]: { localHash: await projectSyncContentHash(before), remoteVersionId: first.id } }, [path])
    backend.visible.set(path, text('unseen preview edit'))
    await expect(remote.write(path, text('local'), record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    backend.visible.set(path, before)
    await backend.add(path, text('another head'))
    await expect(remote.read(path, record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    await expect(remote.write(path, text('local'), record.versionId)).rejects.toMatchObject({ code: 'file-version-conflict' })
    expect(backend.versions.get(latest.id)?.bytes).toEqual(text('new head'))
    expect(backend.api.transfer).not.toHaveBeenCalled()
  })

})
