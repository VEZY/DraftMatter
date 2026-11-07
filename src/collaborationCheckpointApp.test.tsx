import { sharedImage, type ProjectResources } from './sharedEditor/projectResources'
import { publicationAssetPaths } from './publicationAssets'
// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CollaborativeDocument, createCollaborationCheckpoint, type CollaborativeEditorBinding } from './sharedEditor'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

const source = reviewedProjection(initialDraft)
const sharedSource = reviewedProjection({ ...initialDraft, title: 'Shared canopy revision' })
const collaboration = CollaborativeDocument.fromPortableSource(sharedSource)
const checkpoint = createCollaborationCheckpoint(collaboration)
let resources: ProjectResources = { images: [], citations: [] }
let editorDocument: Y.Doc
let editorAwareness: Awareness
let publishPortableSource: Mock<(source: string) => string>
let editorBinding: CollaborativeEditorBinding

vi.mock('./CollaborationDialog', () => ({
  CollaborationDialog: (props: {
    open: boolean
    onRemoteSource: (source: string) => void
    onResources: (resources: ProjectResources) => void
    onStatus: (status: 'connected') => void
    onSessionStateChange: (active: boolean) => void
    onRoleChange: (role: 'owner' | 'editor' | 'commenter' | 'viewer' | null) => void
    onCheckpointStateChange: (pending: boolean) => void
    onEditorBindingChange: (binding: CollaborativeEditorBinding | null) => void
    onCheckpoint: (value: typeof checkpoint) => Promise<void>
  }) => props.open ? createElement('div', { 'data-testid': 'collaboration-test-controls' },
    createElement('button', {
      onClick: () => {
        props.onSessionStateChange(true)
        props.onRoleChange('owner')
        props.onStatus('connected')
        props.onRemoteSource(sharedSource)
        props.onResources(resources)
        props.onCheckpointStateChange(true)
      },
    }, 'Apply live revision'),
    createElement('button', {
      onClick: () => {
        props.onSessionStateChange(true)
        props.onRoleChange('commenter')
        props.onStatus('connected')
        props.onRemoteSource(sharedSource)
        props.onEditorBindingChange(editorBinding)
      },
    }, 'Join as commenter'),
    createElement('button', {
      onClick: () => {
        props.onSessionStateChange(true)
        props.onRoleChange('viewer')
        props.onStatus('connected')
      },
    }, 'Join as viewer'),
    createElement('button', {
      onClick: () => void props.onCheckpoint(checkpoint).then(() => props.onCheckpointStateChange(false)),
    }, 'Checkpoint live revision'),
  ) : null,
}))

import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

const rootPath = '/research/collaboration-checkpoint'
const project: ProjectSnapshot = {
  root: rootPath,
  config: { schemaVersion: 1, name: 'Shared paper', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'document-old' }],
  bibliographies: [],
}

describe('owner-controlled collaboration checkpoint', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    resources = { images: [], citations: [] }
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    previousAvailability = desktopHost.available
    desktopHost.available = true
    editorDocument = new Y.Doc()
    editorAwareness = new Awareness(editorDocument)
    publishPortableSource = vi.fn((nextSource: string) => nextSource.replace('Shared browser reply', 'Canonical shared browser reply'))
    editorBinding = {
      document: editorDocument,
      awareness: editorAwareness,
      user: { id: 'commenter', name: 'Casey Reviewer', color: '#617f73' },
      publishPortableSource,
    }
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'saveDocument').mockResolvedValue({ path: 'paper.qmd', hash: 'document-checkpoint', bytes: checkpoint.bytes.length, recoveryPath: null })
    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => {
      appRoot.render(createElement(App))
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    collaboration.destroy()
    editorAwareness.destroy()
    editorDocument.destroy()
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('does not autosave live edits and writes exact deterministic bytes only on request', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('.collaboration-toggle')!.click())
    const controls = container.querySelector<HTMLElement>('[data-testid="collaboration-test-controls"]')!
    await act(async () => [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Apply live revision')!.click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 980)) })

    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Live changes · checkpoint needed')

    await act(async () => {
      [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Checkpoint live revision')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(desktopHost.saveDocument).toHaveBeenCalledTimes(1)
    expect(desktopHost.saveDocument).toHaveBeenCalledWith({
      root: rootPath,
      path: 'paper.qmd',
      content: checkpoint.source,
      expectedHash: 'document-old',
    })
    expect(container.textContent).toContain('Saved to project')
  })

  it('checkpoints shared figure bytes with the baseline revision in the native atomic transaction', async () => {
    const path = publicationAssetPaths(checkpoint.source)[0]
    const before = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>Before</text></svg>')
    const after = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>After</text></svg>')
    const { projectAssetHash } = await import('./desktopHost')
    vi.spyOn(desktopHost, 'readProjectAssets').mockResolvedValue([{ path, bytes: [...before], mediaType: 'image/svg+xml' }])
    const save = vi.spyOn(desktopHost, 'saveCollaborationCheckpoint').mockResolvedValue({ documentHash: 'document-complete', assetHashes: { [path]: await projectAssetHash(after) } })
    resources = { images: [sharedImage(path, after)], citations: [] }
    await act(async () => container.querySelector<HTMLButtonElement>('.collaboration-toggle')!.click())
    const controls = container.querySelector<HTMLElement>('[data-testid="collaboration-test-controls"]')!
    await act(async () => [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Apply live revision')!.click())
    await act(async () => {
      [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Checkpoint live revision')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ root: rootPath, documentPath: 'paper.qmd', documentContent: checkpoint.source, expectedDocumentHash: 'document-old', assets: [{ path, bytes: [...after], expectedHash: await projectAssetHash(before) }] }))
  })

  it('prevents opening a different manuscript into the current live room', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('.collaboration-toggle')!.click())
    const controls = container.querySelector<HTMLElement>('[data-testid="collaboration-test-controls"]')!
    await act(async () => [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Apply live revision')!.click())
    const before = container.querySelector('.structured-manuscript-editor')?.textContent
    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.project-menu-example')!.click())
    expect(container.textContent).toContain('Leave the live session before opening another manuscript')
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toBe(before)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).not.toContain('A reproducible cross-language analysis')
  })

  it('enforces commenter and viewer capabilities across the rendered editor and review rail', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('.collaboration-toggle')!.click())
    const controls = container.querySelector<HTMLElement>('[data-testid="collaboration-test-controls"]')!
    await act(async () => [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Join as commenter')!.click())

    expect(container.querySelector('.structured-manuscript-editor')?.getAttribute('data-read-only')).toBe('true')
    expect(container.querySelector<HTMLButtonElement>('.suggestion-mode-control')?.disabled).toBe(true)
    expect(container.querySelector('.suggestion-mode-control')?.textContent).toContain('Comment-only')
    expect(container.querySelector<HTMLButtonElement>('.format-toolbar [aria-label="Bold"]')?.disabled).toBe(true)
    expect(container.textContent).toContain('New comment')
    expect(container.textContent).not.toContain('Suggest edit')
    expect(container.querySelector('.review-actions')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('#review-item-dm-comment-01')!.click())
    const reply = container.querySelector<HTMLInputElement>('input[aria-label^="Reply to"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(reply, 'Shared browser reply')
      reply.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.reply-box button')!.click())
    expect(publishPortableSource).toHaveBeenCalledWith(expect.stringContaining('Shared browser reply'))
    expect(publishPortableSource).toHaveBeenCalledWith(expect.stringContaining('data-author="commenter"'))
    expect(container.textContent).toContain('Canonical shared browser reply')

    await act(async () => [...controls.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Join as viewer')!.click())
    expect(container.querySelector('.suggestion-mode-control')?.textContent).toContain('Read-only')
    expect(container.textContent).not.toContain('New comment')
    expect(container.textContent).not.toContain('Suggest edit')
    expect(container.querySelector('.reply-box')).toBeNull()
  })
})
