// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborativeDocument, createCollaborationCheckpoint } from './sharedEditor'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

const source = reviewedProjection(initialDraft)
const sharedSource = reviewedProjection({ ...initialDraft, title: 'Shared canopy revision' })
const collaboration = CollaborativeDocument.fromPortableSource(sharedSource)
const checkpoint = createCollaborationCheckpoint(collaboration)

vi.mock('./CollaborationDialog', () => ({
  CollaborationDialog: (props: {
    open: boolean
    onRemoteSource: (source: string) => void
    onStatus: (status: 'connected') => void
    onSessionStateChange: (active: boolean) => void
    onCheckpointStateChange: (pending: boolean) => void
    onCheckpoint: (value: typeof checkpoint) => Promise<void>
  }) => props.open ? createElement('div', { 'data-testid': 'collaboration-test-controls' },
    createElement('button', {
      onClick: () => {
        props.onSessionStateChange(true)
        props.onStatus('connected')
        props.onRemoteSource(sharedSource)
        props.onCheckpointStateChange(true)
      },
    }, 'Apply live revision'),
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
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    previousAvailability = desktopHost.available
    desktopHost.available = true
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
    collaboration.destroy()
    await act(async () => appRoot.unmount())
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
})
