// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFilesPanel } from './ProjectFilesPanel'
import { CollaborationServiceClient } from './collaboration/serviceClient'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFileUpload } from './collaboration/projectFiles'
import type { WorkspaceRole } from './collaboration/workspaceService'
import { projectFilePartHash } from './collaboration/projectFileClient'

const { download } = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('./collaboration/projectFileDownload', () => ({ downloadProjectFile: download, projectFileScopeKey: (scope: unknown) => JSON.stringify(scope) }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  download.mockReset().mockResolvedValue({ status: 'saved', resumedParts: 0 })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function button(text: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)
  if (!result) throw new Error(`Button ${text} is missing.`)
  return result
}

function file(name: string, size = 4, byte = 7) {
  const result = new File([], name, { type: 'text/csv' })
  Object.defineProperty(result, 'size', { value: size })
  Object.defineProperty(result, 'slice', { value: (start: number, end: number) => ({ async arrayBuffer() { return new Uint8Array(end - start).fill(byte).buffer } }) })
  return result
}

async function choose(input: HTMLInputElement, value: File) {
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [value] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function backend() {
  const initial: ProjectFile = { id: 'file-1', path: 'data/shared.csv', size: 17, mediaType: 'text/csv', createdBy: 'alice', createdAt: '2026-11-11T10:00:00Z', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [{ partNumber: 1, size: 17, sha256: 'a'.repeat(64) }] }
  const files = [initial]
  const uploads: ProjectFileUpload[] = []
  let holdFirstPart = false
  let partRequests = 0
  const requests: Array<{ path: string; method: string; signal?: AbortSignal | null }> = []
  const request = vi.fn<typeof fetch>(async (input, init = {}) => {
    const path = new URL(String(input)).pathname
    const route = path.split('/files')[1]
    const method = init.method ?? 'GET'
    requests.push({ path, method, signal: init.signal })
    if (route === '') return Response.json({ files, uploads, quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: files.reduce((sum, value) => sum + value.size, 0), reservedBytes: uploads.reduce((sum, value) => sum + value.size, 0) } })
    if (route === '/uploads' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const upload: ProjectFileUpload = { ...body, id: `upload-${uploads.length + 1}`, createdAt: '2026-11-11T11:00:00Z', updatedAt: '2026-11-11T11:00:00Z', createdBy: 'alice', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [], status: 'uploading' }
      uploads.push(upload)
      return Response.json(upload)
    }
    const match = route?.match(/^\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/)
    if (match) {
      const index = uploads.findIndex((item) => item.id === match[1])
      const upload = uploads[index]
      if (method === 'GET') return Response.json(upload)
      if (method === 'DELETE') { uploads.splice(index, 1); return new Response(null, { status: 204 }) }
      if (match[2]) {
        partRequests += 1
        const bytes = new Uint8Array(init.body as ArrayBuffer)
        const partNumber = Number(match[2])
        upload.parts.push({ partNumber, size: bytes.length, sha256: new Headers(init.headers).get('x-draftmatter-sha256')! })
        if (holdFirstPart) await new Promise<void>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true }) })
        return Response.json(upload)
      }
      if (match[3]) {
        uploads.splice(index, 1)
        const completed: ProjectFile = { id: `saved-${upload.id}`, path: upload.path, size: upload.size, mediaType: upload.mediaType, createdBy: upload.createdBy, createdAt: upload.createdAt, chunkSize: upload.chunkSize, parts: upload.parts }
        files.push(completed)
        return Response.json(completed)
      }
    }
    if (method === 'DELETE') { const id = route!.slice(1); const index = files.findIndex((item) => item.id === id); files.splice(index, 1); return new Response(null, { status: 204 }) }
    throw new Error(`Unexpected request ${method} ${route}`)
  })
  const client = new CollaborationServiceClient('https://files.example.test', async () => 'fresh-token', request)
  return { client, files, uploads, requests, request, hold() { holdFirstPart = true }, partRequests: () => partRequests }
}

async function render(server: ReturnType<typeof backend>, role: WorkspaceRole = 'owner', user = 'alice', projectId = 'paper') {
  await act(async () => root.render(<ProjectFilesPanel client={server.client} workspace={{ id: 'lab', name: 'Lab', role, createdAt: '2026-11-11T09:00:00Z' }} projectId={projectId} currentUserId={user} />))
}

async function openFiles() {
  const toggle = container.querySelector<HTMLButtonElement>('.project-files-toggle')!
  await act(async () => toggle.click())
}

describe('project files panel', () => {
  it.each(['owner', 'editor', 'commenter', 'viewer'] as WorkspaceRole[])('shows file versions and download access for %s with the correct write controls', async (role) => {
    const server = backend()
    await render(server, role)
    expect(server.request).not.toHaveBeenCalled()
    await openFiles()
    expect(container.textContent).toContain('data/shared.csv')
    expect(container.textContent).toContain('17 B used + 0 B reserved / 1 GB')
    const writable = role === 'owner' || role === 'editor'
    expect(Boolean(container.querySelector('input[aria-label="Choose a data file"]'))).toBe(writable)
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === 'Delete version')).toBe(writable)
    await act(async () => button('Download').click())
    expect(download).toHaveBeenCalledOnce()
    expect(download.mock.calls[0][0].scopeKey).toContain('"userId":"alice"')
    expect(download.mock.calls[0][0].scopeKey).toContain('"projectId":"paper"')
  })

  it('uploads a chosen file under data/, updates quota, and confirms deletion of a single version', async () => {
    const server = backend()
    await render(server)
    await openFiles()
    await choose(container.querySelector<HTMLInputElement>('input[aria-label="Choose a data file"]')!, file('new.csv'))
    expect(container.querySelector<HTMLInputElement>('input[placeholder="data/observations.csv"]')?.value).toBe('data/new.csv')
    await act(async () => button('Upload new version').click())
    await vi.waitFor(() => expect(container.textContent).toContain('Saved a new version of data/new.csv.'))
    expect(container.textContent).toContain('21 B used + 0 B reserved / 1 GB')
    expect(server.files).toHaveLength(2)
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label^="Delete version of data/new.csv"]')!
    await act(async () => remove.click())
    expect(server.requests.filter((item) => item.method === 'DELETE')).toHaveLength(0)
    await act(async () => button('Delete this version').click())
    expect(server.files.map((item) => item.path)).toEqual(['data/shared.csv'])
  })

  it('reports a browser download handoff without claiming that the destination file was saved', async () => {
    const server = backend()
    download.mockResolvedValue({ status: 'download-started', resumedParts: 0 })
    await render(server, 'viewer'); await openFiles()
    await act(async () => button('Download').click())
    expect(container.textContent).toContain('Download started for data/shared.csv.')
    expect(container.textContent).not.toContain('Saved data/shared.csv.')
  })

  it('pauses on request and recovers the unfinished session after a panel reload', async () => {
    const server = backend(); server.hold()
    await render(server); await openFiles()
    await choose(container.querySelector<HTMLInputElement>('input[aria-label="Choose a data file"]')!, file('large.csv', PROJECT_FILE_CHUNK_BYTES + 3))
    await act(async () => button('Upload new version').click())
    await vi.waitFor(() => expect(server.partRequests()).toBe(1))
    await act(async () => button('Pause upload').click())
    await vi.waitFor(() => expect(container.textContent).toContain('Upload paused.'))
    expect(server.uploads[0].parts).toHaveLength(1)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(server); await openFiles()
    expect(container.textContent).toContain('Unfinished uploads · 1')
    expect(container.querySelector('button[aria-label="Resume upload of data/large.csv"]')).not.toBeNull()
    await choose(container.querySelector<HTMLInputElement>('input[aria-label="Choose original file to resume upload"]')!, file('large.csv', PROJECT_FILE_CHUNK_BYTES + 3, 99))
    // No resume target was chosen yet, so a hidden input cannot start a request.
    expect(server.partRequests()).toBe(1)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Resume upload of data/large.csv"]')!.click())
    await choose(container.querySelector<HTMLInputElement>('input[aria-label="Choose original file to resume upload"]')!, file('large.csv', PROJECT_FILE_CHUNK_BYTES + 3, 99))
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('different file'))
    expect(server.partRequests()).toBe(1)
  })

  it('aborts transfers and removes the previous catalogue immediately when the account or project changes', async () => {
    const server = backend()
    let signal: AbortSignal | undefined
    download.mockImplementation((options) => new Promise((_resolve, reject) => { signal = options.signal; signal!.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true }) }))
    await render(server); await openFiles()
    await act(async () => button('Download').click())
    expect(signal?.aborted).toBe(false)
    await render(server, 'viewer', 'bob', 'other-project')
    expect(signal?.aborted).toBe(true)
    expect(container.textContent).not.toContain('data/shared.csv')
    expect(container.querySelector('.project-files-body')).toBeNull()
  })

  it('offers unfinished upload actions only to its creator and rejects mismatched recovery metadata', async () => {
    const server = backend()
    server.uploads.push({ id: 'other-upload', path: 'data/private.csv', size: 4, mediaType: 'text/csv', createdBy: 'bob', createdAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [{ partNumber: 1, size: 4, sha256: await projectFilePartHash(new Uint8Array(4)) }], status: 'uploading' })
    await render(server); await openFiles()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('another account')
    expect(container.textContent).not.toContain('data/private.csv')
    expect(container.querySelector('button[aria-label^="Resume upload"]')).toBeNull()
  })
})
