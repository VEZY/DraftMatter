// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborativeEditorBinding } from './sharedEditor'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

const sharedSource = reviewedProjection({ ...initialDraft, title: 'Browser workspace manuscript' })
const collaborativeDocument = new Y.Doc()
const collaborativeAwareness = new Awareness(collaborativeDocument)
const editorBinding: CollaborativeEditorBinding = {
  document: collaborativeDocument,
  awareness: collaborativeAwareness,
  publishPortableSource: vi.fn(),
}

afterAll(() => {
  collaborativeAwareness.destroy()
  collaborativeDocument.destroy()
})

vi.mock('./CollaborationDialog', () => ({
  CollaborationDialog: (props: {
    open: boolean
    onRemoteSource: (source: string) => void
    onStatus: (status: 'connected') => void
    onSessionStateChange: (active: boolean) => void
    onRoleChange: (role: 'viewer') => void
    onEditorBindingChange: (binding: CollaborativeEditorBinding) => void
  }) => props.open ? createElement('button', {
    'data-testid': 'join-browser-workspace',
    onClick: () => {
      props.onSessionStateChange(true)
      props.onRoleChange('viewer')
      props.onStatus('connected')
      props.onRemoteSource(sharedSource)
      props.onEditorBindingChange(editorBinding)
    },
  }, 'Join browser workspace') : null,
}))

import App from './App'
import { desktopHost } from './desktopHost'

describe('fresh browser collaboration entry', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    previousAvailability = desktopHost.available
    desktopHost.available = false
    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => appRoot.render(createElement(App)))
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('switches the sample shell into the shared rendered editor when the workspace synchronizes', async () => {
    expect(container.querySelector<HTMLElement>('.structured-manuscript-editor')?.dataset.collaborative).toBe('false')
    await act(async () => container.querySelector<HTMLButtonElement>('.collaboration-toggle')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="join-browser-workspace"]')!.click())

    const editor = container.querySelector<HTMLElement>('.structured-manuscript-editor')
    expect(editor?.dataset.collaborative).toBe('true')
    expect(editor?.dataset.readOnly).toBe('true')
    expect(container.textContent).toContain('Browser workspace manuscript')
    expect(container.querySelector('.suggestion-mode-control')?.textContent).toContain('Read-only')

    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 400)) })
    expect(localStorage.getItem('draftmatter.structured-mode.v1')).toBe('true')
  })
})
