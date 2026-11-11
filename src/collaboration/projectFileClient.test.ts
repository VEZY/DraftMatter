import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CollaborationServiceClient } from './serviceClient'
import { ProjectFileClient, projectFilePartHash, type ProjectFileSource } from './projectFileClient'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFileUpload } from './projectFiles'

beforeAll(() => { if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto) })

function selectedFile(size: number, byte = 7) {
  const reads: number[] = []
  const source: ProjectFileSource = {
    size, type: 'text/csv',
    slice(start, end) {
      reads.push(end - start)
      return { async arrayBuffer() { return new Uint8Array(end - start).fill(byte).buffer } }
    },
  }
  return { source, reads }
}

function server() {
  const uploads = new Map<string, ProjectFileUpload>()
  const bodies = new Map<string, Uint8Array>()
  const files = new Map<string, ProjectFile>()
  const requests: Array<{ path: string; method: string; headers: Headers; credentials: RequestCredentials | undefined }> = []
  let tokenNumber = 0
  let uploadNumber = 0
  let downloadTamper: 'header' | 'body' | 'size' | undefined
  const base = '/api/workspaces/lab/projects/paper/files'
  const request = vi.fn<typeof fetch>(async (raw, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('Paused', 'AbortError')
    const path = new URL(String(raw)).pathname
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    requests.push({ path, method, headers, credentials: init.credentials })
    if (!path.startsWith(base)) return Response.json({ error: { code: 'not-found', message: 'Not found.' } }, { status: 404 })
    const route = path.slice(base.length)
    if (route === '' && method === 'GET') return Response.json({ files: [...files.values()], uploads: [...uploads.values()].filter((upload) => upload.status === 'uploading'), quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: [...files.values()].reduce((sum, file) => sum + file.size, 0), reservedBytes: [...uploads.values()].filter((upload) => upload.status === 'uploading').reduce((sum, upload) => sum + upload.size, 0) } })
    if (route === '/uploads' && method === 'POST') {
      const value = JSON.parse(String(init.body)) as { path: string; size: number; mediaType: string }
      const upload: ProjectFileUpload = { ...value, id: `upload-${++uploadNumber}`, createdBy: 'alice', createdAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [], status: 'uploading' }
      uploads.set(upload.id, upload)
      return Response.json(upload)
    }
    const match = route.match(/^\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/)
    if (match) {
      const upload = uploads.get(match[1])!
      if (!upload) return Response.json({ error: { code: 'not-found', message: 'Not found.' } }, { status: 404 })
      if (method === 'GET') return Response.json(upload)
      if (method === 'DELETE') { uploads.delete(upload.id); return new Response(null, { status: 204 }) }
      if (match[2] && method === 'PUT') {
        const bytes = new Uint8Array(init.body as ArrayBuffer)
        const partNumber = Number(match[2])
        const sha256 = await projectFilePartHash(bytes)
        expect(headers.get('x-draftmatter-sha256')).toBe(sha256)
        upload.parts = [...upload.parts.filter((part) => part.partNumber !== partNumber), { partNumber, size: bytes.length, sha256 }]
        bodies.set(`${upload.id}:${partNumber}`, bytes)
        return Response.json(upload)
      }
      if (match[3] && method === 'POST') {
        if (upload.parts.length !== Math.ceil(upload.size / upload.chunkSize)) return Response.json({ error: { code: 'incomplete', message: 'Upload incomplete.' } }, { status: 409 })
        upload.status = 'completed'
        const file: ProjectFile = { id: `version-${upload.id}`, path: upload.path, size: upload.size, mediaType: upload.mediaType, createdBy: upload.createdBy, createdAt: upload.createdAt, chunkSize: upload.chunkSize, parts: [...upload.parts] }
        files.set(file.id, file)
        for (const part of file.parts) bodies.set(`${file.id}:${part.partNumber}`, bodies.get(`${upload.id}:${part.partNumber}`)!)
        return Response.json(file)
      }
    }
    const partRoute = route.match(/^\/([^/]+)\/parts\/(\d+)$/)
    if (partRoute) {
      const part = files.get(partRoute[1])!.parts.find((item) => item.partNumber === Number(partRoute[2]))!
      const source = bodies.get(`${partRoute[1]}:${partRoute[2]}`)!
      const bytes = downloadTamper === 'body' ? new Uint8Array(source.length).fill(99) : downloadTamper === 'size' ? new Uint8Array(source.length + 1) : source
      return new Response(bytes.slice().buffer, { headers: { 'x-draftmatter-sha256': downloadTamper === 'header' ? '0'.repeat(64) : part.sha256 } })
    }
    if (/^\/[^/]+$/.test(route) && method === 'DELETE') { files.delete(route.slice(1)); return new Response(null, { status: 204 }) }
    throw new Error(`Unexpected request ${method} ${route}`)
  })
  const service = new CollaborationServiceClient('https://files.example.test', async () => `fresh-token-${++tokenNumber}`, request)
  const api = () => new ProjectFileClient(service, 'lab', 'paper', 'alice')
  return { api, service, requests, uploads, files, setTamper(value: typeof downloadTamper) { downloadTamper = value } }
}

describe('bounded and resumable project file transfers', () => {
  it('pauses a multipart upload and resumes in a new client after checking received bytes', async () => {
    const backend = server()
    const chosen = selectedFile(PROJECT_FILE_CHUNK_BYTES + 19)
    const pause = new AbortController()
    await expect(backend.api().transfer(chosen.source, 'data/observations.csv', { signal: pause.signal, onUpload: (upload) => { if (upload.parts.length === 1) pause.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(backend.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
    const restarted = backend.api()
    const catalogue = await restarted.catalogue()
    expect(catalogue.uploads).toHaveLength(1)
    expect(catalogue.quota.reservedBytes).toBe(chosen.source.size)
    const progress: string[] = []
    const completed = await restarted.transfer(chosen.source, 'data/observations.csv', { uploadId: catalogue.uploads[0].id, onProgress: (value) => progress.push(value.phase) })
    expect(completed.parts).toHaveLength(2)
    expect(backend.requests.filter((request) => request.method === 'PUT')).toHaveLength(2)
    expect(progress).toContain('verifying')
    expect(Math.max(...chosen.reads)).toBe(PROJECT_FILE_CHUNK_BYTES)
    expect(chosen.reads.filter((size) => size === PROJECT_FILE_CHUNK_BYTES)).toHaveLength(2)
    const after = await restarted.catalogue()
    expect(after.quota).toEqual({ limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: chosen.source.size, reservedBytes: 0 })
    expect(backend.requests.every((request, index) => request.headers.get('authorization') === `Bearer fresh-token-${index + 1}` && request.credentials === 'omit')).toBe(true)
  })

  it('rejects a different same-size file before uploading any further part', async () => {
    const backend = server()
    const chosen = selectedFile(PROJECT_FILE_CHUNK_BYTES + 31)
    const pause = new AbortController()
    await expect(backend.api().transfer(chosen.source, 'data/input.bin', { signal: pause.signal, onUpload: (upload) => { if (upload.parts.length) pause.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    const upload = (await backend.api().catalogue()).uploads[0]
    await expect(backend.api().transfer(selectedFile(chosen.source.size, 11).source, upload.path, { uploadId: upload.id })).rejects.toThrow(/different file/)
    expect(backend.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
    expect(backend.files.size).toBe(0)
    expect(backend.uploads.has(upload.id)).toBe(true)
  })

  it('keeps upload recovery scoped to the creator and project', async () => {
    const backend = server()
    const upload = await backend.api().begin({ path: 'data/input.bin', size: 1, mediaType: 'application/octet-stream' })
    const otherAccount = new ProjectFileClient(backend.service, 'lab', 'paper', 'bob')
    await expect(otherAccount.uploadStatus(upload.id)).rejects.toThrow(/account and project/)
    await expect(otherAccount.catalogue()).rejects.toThrow(/another account/)
    const otherProject = new ProjectFileClient(backend.service, 'lab', 'other', 'alice')
    await expect(otherProject.uploadStatus(upload.id)).rejects.toMatchObject({ status: 404 })
    expect(backend.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
  })

  it('verifies each downloaded part against both metadata and bytes and bounds its body', async () => {
    const backend = server()
    const file = await backend.api().transfer(selectedFile(17).source, 'data/input.bin')
    expect(await backend.api().readPart(file, 1)).toEqual(new Uint8Array(17).fill(7))
    backend.setTamper('header')
    await expect(backend.api().readPart(file, 1)).rejects.toThrow(/file version/)
    backend.setTamper('body')
    await expect(backend.api().readPart(file, 1)).rejects.toThrow(/integrity check/)
    backend.setTamper('size')
    await expect(backend.api().readPart(file, 1)).rejects.toThrow(/expected size/)
  })

  it('validates quota and paths before creating sessions, and releases explicit cancellations', async () => {
    const backend = server()
    await expect(backend.api().transfer(selectedFile(PROJECT_FILE_QUOTA_BYTES + 1).source, 'data/too-big.bin')).rejects.toThrow(/1 GB/)
    await expect(backend.api().transfer(selectedFile(1).source, '../private.bin')).rejects.toThrow(/inside data/)
    expect(backend.requests).toHaveLength(0)
    const upload = await backend.api().begin({ path: 'data/cancel.bin', size: 15, mediaType: 'application/octet-stream' })
    await backend.api().cancel(upload.id)
    expect((await backend.api().catalogue()).quota.reservedBytes).toBe(0)
    const file = await backend.api().transfer(selectedFile(4).source, 'data/version.bin')
    await backend.api().deleteVersion(file.id)
    expect((await backend.api().catalogue()).files).toEqual([])
  })
})
