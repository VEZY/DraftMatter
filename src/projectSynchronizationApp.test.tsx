// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import App from './App'
import { desktopHost, projectAssetHash, type ProjectSnapshot, type ProjectSyncStateSnapshot } from './desktopHost'
import { sourceHash } from './document'
import { CollaborationServiceClient } from './collaboration/serviceClient'
import type { CollaborationDialogProps, CollaborationFileService } from './CollaborationDialog'
import type { CollaborativeEditorBinding } from './sharedEditor'
import type { ProjectSyncRemoteOptions } from './projectSyncRemote'
import { publishProjectResources, readProjectResources, sharedImage } from './sharedEditor/projectResources'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const originalSource = '# A selectively synchronized paper\n\nThe common manuscript version.\n'
const onlineSource = '# A selectively synchronized paper\n\nA collaborator updated this manuscript online.\n'
const scope = { serviceUrl: 'https://collab.example.test', workspaceId: 'lab', projectId: 'paper' }
const project: ProjectSnapshot = {
  root: '/research/selective-app',
  config: { schemaVersion: 1, name: 'Selective paper', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US', collaboration: { schemaVersion: 1, ...scope } },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: encoder.encode(originalSource).length, hash: sourceHash(originalSource), modifiedMs: 1 }],
  bibliographies: [],
}
let local = new Map<string, Uint8Array>()
let remote = new Map<string, { bytes: Uint8Array; versionId: string }>()
let stored: ProjectSyncStateSnapshot
let stateRevision = 0
let version = 10
let liveSource: string
let binding: CollaborativeEditorBinding
let awareness: Awareness
let fileService: CollaborationFileService
let remoteWrites: Array<{ path: string; bytes: Uint8Array; expectedVersionId: string | null }>
let syncOptions: ProjectSyncRemoteOptions
let dialogProps: CollaborationDialogProps

vi.mock('./ProjectFilesPanel', () => ({ ProjectFilesPanel: () => <div>Shared data file versions</div> }))
vi.mock('./CollaborationDialog', () => ({ CollaborationDialog: (props: CollaborationDialogProps) => { dialogProps = props; return props.open ? <button onClick={() => {
  props.onSessionStateChange?.(true)
  props.onRoleChange?.('editor')
  props.onStatus('connected')
  props.onRemoteSource(liveSource)
  props.onEditorBindingChange?.(binding)
  props.onFileServiceChange?.(fileService)
  props.onConnected?.()
}}>Connect test collaboration</button> : null } }))
vi.mock('./projectSyncRemote', () => ({ ProjectSyncRemoteAdapter: class {
  constructor(private options: ProjectSyncRemoteOptions) { syncOptions = options }
  canWrite() { return this.options.canUpload() }
  async list() {
    const files = await Promise.all([...remote].map(async ([path, file]) => ({ path, versionId: file.versionId, hash: await projectAssetHash(file.bytes), size: file.bytes.length })))
    if (this.options.liveManuscript) {
      const bytes = await this.options.liveManuscript.read()
      const hash = await projectAssetHash(bytes)
      files.push({ path: this.options.liveManuscript.path, versionId: `live-text:${hash.slice(7)}`, hash, size: bytes.length })
    }
    return files
  }
  async read(path: string, versionId: string) {
    if (path === this.options.liveManuscript?.path) {
      const bytes = await this.options.liveManuscript.read()
      if (`live-text:${(await projectAssetHash(bytes)).slice(7)}` !== versionId) throw new Error('The online manuscript changed.')
      return bytes
    }
    const file = remote.get(path)
    if (!file || file.versionId !== versionId) throw new Error('The online version changed.')
    return Uint8Array.from(file.bytes)
  }
  async write(path: string, bytes: Uint8Array, expectedVersionId: string | null) {
    if (!this.options.canUpload()) throw new Error('The collaboration session ended.')
    if (path === this.options.liveManuscript?.path) return this.options.liveManuscript.write(bytes, expectedVersionId!)
    if ((remote.get(path)?.versionId ?? null) !== expectedVersionId) throw new Error('The online version changed.')
    remoteWrites.push({ path, bytes: Uint8Array.from(bytes), expectedVersionId })
    const versionId = `file-${++version}`
    remote.set(path, { bytes: Uint8Array.from(bytes), versionId })
    return { versionId, bytes }
  }
} }))

async function until(predicate: () => boolean, timeout = 4000) {
  const limit = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= limit) throw new Error('The expected selective synchronization UI did not appear.')
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)) })
  }
}

describe('selective synchronization in the actual app', () => {
  let container: HTMLDivElement
  let root: Root
  let availability: boolean
  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    availability = desktopHost.available; desktopHost.available = true
    local = new Map([['paper.qmd', encoder.encode(originalSource)], ['data/input.csv', encoder.encode('common data')]])
    remote = new Map([['data/input.csv', { bytes: encoder.encode('common data'), versionId: 'file-data-common' }]])
    remoteWrites = []; version = 10; stateRevision = 0; liveSource = originalSource
    const paperHash = await projectAssetHash(encoder.encode(originalSource))
    stored = { revision: null, state: { schemaVersion: 1, scope, paused: false, trackedPaths: ['data/input.csv', 'paper.qmd'], excludedPaths: [], baselines: { 'paper.qmd': { localHash: paperHash, remoteVersionId: `live-text:${paperHash.slice(7)}` }, 'data/input.csv': { localHash: await projectAssetHash(encoder.encode('common data')), remoteVersionId: 'file-data-common' } } } }
    const sharedDocument = new Y.Doc()
    awareness = new Awareness(sharedDocument)
    binding = { document: sharedDocument, awareness, user: { id: 'alice', name: 'Alice', color: '#617f73' }, publishPortableSource: (source) => source }
    const client = new CollaborationServiceClient(scope.serviceUrl, async () => 'token')
    fileService = { client, workspace: { id: 'lab', name: 'Lab', role: 'editor', createdAt: '2026-11-13T10:00:00Z' }, projectId: 'paper', currentUserId: 'alice' }
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async (_root, path) => { const bytes = local.get(path)!; return { path, content: decoder.decode(bytes), hash: sourceHash(decoder.decode(bytes)), modifiedMs: 1 } })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'readProjectAssets').mockResolvedValue([])
    vi.spyOn(desktopHost, 'terminateKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'documentStatus').mockImplementation(async (_root, path) => ({ kind: 'current', hash: sourceHash(decoder.decode(local.get(path)!)), modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'assistantConnectionsStatus').mockResolvedValue({ ok: true, scope: 'device', clients: [] })
    vi.spyOn(desktopHost, 'agentIntegrationStatus').mockResolvedValue({ schemaVersion: 2, protocolVersion: '1.0', projectEnabled: false, instructionsReady: false, portableSkillReady: false, portableSkillFallback: false, manifestReady: false, localAdapters: [], repairCommand: '', doctorCommand: '', notes: [] })
    vi.spyOn(desktopHost, 'executionTrustStatus').mockResolvedValue({ trusted: false, scope: 'session', warning: 'No code runs in this test.' })
    vi.spyOn(desktopHost, 'listProjectFiles').mockImplementation(async () => ({ files: [...local].map(([path, bytes]) => ({ path, bytes: bytes.length, modifiedMs: 1 })), truncated: false }))
    vi.spyOn(desktopHost, 'readProjectSyncState').mockImplementation(async () => structuredClone(stored))
    vi.spyOn(desktopHost, 'saveProjectSyncState').mockImplementation(async (request) => {
      if (request.expectedRevision !== stored.revision) throw new Error('The synchronization state changed.')
      stored = { state: structuredClone(request.state), revision: `sha256:${(++stateRevision).toString(16).padStart(64, '0')}` }
      return structuredClone(stored)
    })
    vi.spyOn(desktopHost, 'inspectProjectSyncFiles').mockImplementation(async (_root, paths) => Promise.all(paths.map(async (path) => {
      const bytes = local.get(path)
      return { path, exists: Boolean(bytes), bytes: bytes?.length ?? 0, hash: bytes ? await projectAssetHash(bytes) : null, tooLarge: false, modifiedMs: bytes ? 1 : null }
    })))
    vi.spyOn(desktopHost, 'readProjectSyncFile').mockImplementation(async (_root, path, expectedHash) => {
      const bytes = local.get(path)
      if (!bytes || await projectAssetHash(bytes) !== expectedHash) throw new Error('The local file changed before upload.')
      return { path, bytes: [...bytes], hash: expectedHash }
    })
    vi.spyOn(desktopHost, 'applyProjectSyncFile').mockImplementation(async (request) => {
      const existing = local.get(request.path)
      if ((existing ? await projectAssetHash(existing) : null) !== request.expectedHash) throw new Error('The local file changed before replacement.')
      const bytes = Uint8Array.from(request.bytes); local.set(request.path, bytes)
      return { path: request.path, bytes: bytes.length, hash: await projectAssetHash(bytes), recoveryPath: existing ? '.draftmatter/sync-recovery/original' : null }
    })
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => {
      const previous = local.get(request.path)
      if ((previous ? sourceHash(decoder.decode(previous)) : null) !== request.expectedHash) throw new Error('The manuscript changed.')
      const bytes = encoder.encode(request.content); local.set(request.path, bytes)
      return { path: request.path, bytes: bytes.length, hash: sourceHash(decoder.decode(bytes)), recoveryPath: null }
    })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); awareness.destroy(); binding.document.destroy(); desktopHost.available = availability; vi.restoreAllMocks(); container.remove() })
  const button = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label)!
  async function connectAndOpenFiles() {
    await act(async () => root.render(<App desktopProjectLaunch={project} />))
    await until(() => container.querySelector('.project-switcher-name small')?.textContent === 'paper.qmd')
    await act(async () => button('Open online collaboration').click())
    await act(async () => button('Connect test collaboration').click())
    await act(async () => button('Files', container.querySelector('[aria-label="Workspace navigation"]')!).click())
    await until(() => Boolean(container.querySelector('[aria-label="Selective synchronization"]')))
    await act(async () => container.querySelector<HTMLElement>('.project-file-explorer-transfers > summary')!.click())
  }

  it('automatically pulls the shared manuscript into its unchanged local default without creating a second text authority', async () => {
    liveSource = onlineSource
    await connectAndOpenFiles()
    const onlineHash = await projectAssetHash(encoder.encode(onlineSource))
    // The data row can already say "Up to date" while the manuscript transfer
    // has written its bytes but is still persisting its synchronization baseline.
    await until(() => decoder.decode(local.get('paper.qmd')) === onlineSource
      && stored.state.baselines['paper.qmd'].localHash === onlineHash && container.textContent?.includes('Up to date') === true)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('A collaborator updated this manuscript online.')
    expect(desktopHost.applyProjectSyncFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'paper.qmd', expectedHash: await projectAssetHash(encoder.encode(originalSource)) }))
    expect(remoteWrites.some((write) => write.path === 'paper.qmd')).toBe(false)
    expect(stored.state.baselines['paper.qmd'].localHash).toBe(onlineHash)
  })

  it('pauses a file changed on both sides and keeps both versions when the app user resolves it', async () => {
    local.set('data/input.csv', encoder.encode('a new local analysis'))
    remote.set('data/input.csv', { bytes: encoder.encode('a new online analysis'), versionId: 'file-data-online' })
    await connectAndOpenFiles()
    const row = () => container.querySelector<HTMLInputElement>('input[aria-label="Follow data/input.csv"]')?.closest('li')
    await until(() => Boolean(row()?.querySelector('.selective-sync-resolve')) && button('Keep both', row()!)?.disabled === false)
    expect(decoder.decode(local.get('data/input.csv'))).toBe('a new local analysis')
    expect(decoder.decode(remote.get('data/input.csv')!.bytes)).toBe('a new online analysis')
    await act(async () => button('Keep both', row()!).click())
    await until(() => decoder.decode(local.get('data/input.csv')) === 'a new online analysis' && [...local.keys()].some((path) => /input\.conflict-local-[a-f0-9]+\.csv$/.test(path)))
    const copy = [...local.keys()].find((path) => /input\.conflict-local-[a-f0-9]+\.csv$/.test(path))!
    expect(decoder.decode(local.get(copy))).toBe('a new local analysis')
    expect(decoder.decode(remote.get(copy)!.bytes)).toBe('a new local analysis')
    expect(decoder.decode(remote.get('data/input.csv')!.bytes)).toBe('a new online analysis')
    expect(stored.state.trackedPaths).toContain(copy)
  })

  it('rejects references exceeding the combined resource limit before removing existing shared references', async () => {
    await connectAndOpenFiles()
    await until(() => !container.querySelector('[aria-label="Selective synchronization"]')?.textContent?.includes('Synchronizing…'))
    const old = { citekey: 'original', title: 'Preserve this reference', type: 'article', authors: [], source: 'csl-json' as const }
    publishProjectResources(binding.document, {
      images: [1, 2, 3].map((index) => sharedImage(`figures/large-${index}.png`, new Uint8Array(1_800_000).fill(index))),
      citations: [old],
    })
    const preview = (await syncOptions.getPreviews!()).find((file) => file.path === 'references.json')!
    const bytes = encoder.encode(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ id: `new${index}`, title: 'x'.repeat(60_000), type: 'article' }))))
    await expect(syncOptions.publishPreview!('references.json', bytes, await projectAssetHash(preview.bytes))).rejects.toThrow('8 MB project limit')
    expect(readProjectResources(binding.document).citations).toEqual([old])
    expect(readProjectResources(binding.document).images).toHaveLength(3)
  })

  it('prevents an explicit checkpoint from bypassing an unresolved manuscript conflict', async () => {
    const localSource = '# A local change that must survive\n'
    local.set('paper.qmd', encoder.encode(localSource))
    liveSource = onlineSource
    await connectAndOpenFiles()
    await until(() => Boolean(container.querySelector<HTMLInputElement>('input[aria-label="Follow paper.qmd"]')?.closest('li')?.classList.contains('conflict')))
    await expect(dialogProps.onCheckpoint({ source: onlineSource, bytes: encoder.encode(onlineSource), contentHash: sourceHash(onlineSource), revision: 'test', recordCount: 0 })).rejects.toThrow('Review selective synchronization in Files')
    expect(decoder.decode(local.get('paper.qmd'))).toBe(localSource)
    expect(remoteWrites.some((write) => write.path === 'paper.qmd')).toBe(false)
  })
})
