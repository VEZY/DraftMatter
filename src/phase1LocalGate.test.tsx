// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { readRecoverySnapshots } from './storage'

const projectRoot = '/research/phase-1-gate'
const originalSource = `---
title: "Phase 1 article"
---

# Phase 1 article

## Results

First observation.
`
const editedSource = originalSource.replace('First observation.', 'Edited without source punctuation.')
const externalSource = originalSource.replace('First observation.', 'Changed safely in another editor.')

const project: ProjectSnapshot = {
  root: projectRoot,
  config: {
    schemaVersion: 1,
    name: 'Phase 1 Gate',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
  },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: originalSource.length, modifiedMs: 1, hash: 'document-1' }],
  bibliographies: [],
}

async function flush(delay = 0) {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, delay)) })
}

function buttonWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))!
}

describe('DM-P1-GATE local project workflow', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean
  let persistedSource: string
  let persistedHash: string

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    persistedSource = originalSource
    persistedHash = 'document-1'
    previousAvailability = desktopHost.available
    desktopHost.available = true

    vi.spyOn(desktopHost, 'pickProjectFolder').mockResolvedValue(projectRoot)
    vi.spyOn(desktopHost, 'createProject').mockImplementation(async (_root, name) => ({
      ...project,
      config: { ...project.config, name },
    }))
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async () => ({
      path: 'paper.qmd',
      content: persistedSource,
      hash: persistedHash,
      modifiedMs: 1,
    }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'documentStatus').mockImplementation(async () => ({
      kind: 'current',
      hash: persistedHash,
      modifiedMs: 1,
    }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => {
      persistedSource = request.content
      persistedHash = 'document-2'
      return { path: request.path, hash: persistedHash, bytes: request.content.length, recoveryPath: '.draftmatter/recovery/paper-document-1.qmd' }
    })

    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('creates, edits, autosaves, reopens identical source, and exposes recovery', async () => {
    await act(async () => appRoot.render(<App />))

    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    await act(async () => buttonWithText(container, 'Create project').click())
    await flush()

    const createDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="create-project-title"]')!
    expect(createDialog).not.toBeNull()
    const name = createDialog.querySelector<HTMLInputElement>('input')!
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      inputSetter?.call(name, 'Portable research article')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => createDialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush(30)

    expect(desktopHost.createProject).toHaveBeenCalledWith(projectRoot, 'Portable research article')
    expect(container.querySelector('.structured-manuscript-editor h1')?.textContent).toBe('Phase 1 article')
    expect(localStorage.getItem('draftmatter.last-project-root.v1')).toBe(projectRoot)

    await act(async () => buttonWithText(container, 'View source').click())
    await act(async () => buttonWithText(container, 'Edit source').click())
    const sourceEditor = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      textareaSetter?.call(sourceEditor, editedSource)
      sourceEditor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonWithText(container, 'Apply source').click())
    await flush(1_000)

    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({
      root: projectRoot,
      path: 'paper.qmd',
      content: editedSource,
      expectedHash: 'document-1',
    }))
    expect(persistedSource).toBe(editedSource)

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close source inspector"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    await act(async () => buttonWithText(container, 'Save recovery snapshot').click())
    expect(readRecoverySnapshots(localStorage).map((snapshot) => snapshot.source)).toEqual([editedSource, originalSource])

    await act(async () => appRoot.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App />))
    await flush(40)

    expect(desktopHost.openProject).toHaveBeenCalledWith(projectRoot)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Edited without source punctuation.')
    await act(async () => buttonWithText(container, 'View source').click())
    expect(container.querySelector('.source-drawer pre')?.textContent).toBe(editedSource)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close source inspector"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    await act(async () => buttonWithText(container, 'Recovery history').click())
    const recoveryDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Recovery history"]')!
    expect(recoveryDialog.querySelectorAll('.recovery-list > button')).toHaveLength(2)
  })

  it('reloads a clean external edit without creating a conflict', async () => {
    localStorage.setItem('draftmatter.last-project-root.v1', projectRoot)
    await act(async () => appRoot.render(<App />))
    await flush(50)

    persistedSource = externalSource
    persistedHash = 'document-external'
    vi.mocked(desktopHost.documentStatus)
      .mockResolvedValueOnce({ kind: 'modified', hash: persistedHash, modifiedMs: 2 })
      .mockImplementation(async () => ({ kind: 'current', hash: persistedHash, modifiedMs: 2 }))
    await flush(1_300)

    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Changed safely in another editor.')
    expect(container.querySelector('.save-alert')).toBeNull()
    expect(container.querySelector('.toast')?.textContent).toContain('Reloaded external changes')
  })

  it('snapshots the newest editor copy immediately before blocking on a save conflict', async () => {
    localStorage.setItem('draftmatter.last-project-root.v1', projectRoot)
    await act(async () => appRoot.render(<App />))
    await flush(50)
    vi.mocked(desktopHost.saveDocument).mockRejectedValueOnce({
      kind: 'conflict',
      message: 'paper.qmd changed outside DraftMatter.',
    })

    await act(async () => buttonWithText(container, 'View source').click())
    await act(async () => buttonWithText(container, 'Edit source').click())
    const sourceEditor = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      textareaSetter?.call(sourceEditor, editedSource)
      sourceEditor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonWithText(container, 'Apply source').click())
    await flush(1_000)

    const alert = container.querySelector<HTMLElement>('.save-alert.conflict')!
    expect(alert.textContent).toContain('A recovery snapshot of your editor copy was saved before disk reload.')
    expect(readRecoverySnapshots(localStorage).some((snapshot) => snapshot.source === editedSource)).toBe(true)
    expect(persistedSource).toBe(originalSource)

    await act(async () => buttonWithText(alert, 'Reload disk version').click())
    await flush(50)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('First observation.')
    expect(readRecoverySnapshots(localStorage).some((snapshot) => snapshot.source === editedSource)).toBe(true)
  })
})
