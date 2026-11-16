// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectDocumentWorkspace, type ProjectDocumentWorkspaceHandle } from './ProjectDocumentWorkspace'
import type { ProjectFileViewerProps } from './ProjectFileViewer'
import { desktopHost } from './desktopHost'
import { ProjectFileClient } from './collaboration/projectFileClient'
import { CollaborationServiceClient } from './collaboration/serviceClient'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile } from './collaboration/projectFiles'
import type { CollaborationFileContext } from './ProjectFilesWorkspace'

vi.mock('./ProjectFileViewer', () => ({ ProjectFileViewer: (props: ProjectFileViewerProps) => {
  const [draft, setDraft] = useState(new TextDecoder().decode(props.bytes))
  const [problem, setProblem] = useState('')
  return <div data-viewer={props.path} data-editable={String(props.editable)}>
    <span>{props.provenance}</span><output>{draft}</output>
    <button onClick={() => { setDraft(`edited ${props.path}`); props.onDirtyChange?.(true) }}>Change draft</button>
    <button onClick={() => { void props.onSave?.(draft).then(() => { props.onDirtyChange?.(false); setProblem('') }).catch((error: Error) => setProblem(error.message)) }}>Save draft</button>
    {problem && <p role="alert">{problem}</p>}
  </div>
} }))

let container: HTMLDivElement
let app: Root
let previousAvailability: boolean
const workspace = createRef<ProjectDocumentWorkspaceHandle>()
const onNotice = vi.fn()
const originalHash = `sha256:${'a'.repeat(64)}`
const nextHash = `sha256:${'b'.repeat(64)}`
const remoteScope = 'https://files.example.test:team:paper:alice'
const bytes = new TextEncoder().encode('original draft')
const file: ProjectFile = { id: 'file-original', path: 'scripts/analysis.py', size: bytes.length, mediaType: 'text/plain', createdAt: '2026-11-16T10:00:00Z', createdBy: 'alice', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [{ partNumber: 1, size: bytes.length, sha256: 'c'.repeat(64) }] }

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  previousAvailability = desktopHost.available; desktopHost.available = true
  localStorage.clear(); onNotice.mockReset()
  vi.spyOn(desktopHost, 'readProjectFilePreview').mockImplementation(async (_root, path) => ({ path, bytes: [...bytes], size: bytes.length, hash: originalHash, modifiedMs: 1, truncated: false }))
  vi.spyOn(desktopHost, 'saveProjectFileText').mockResolvedValue({ path: file.path, bytes: bytes.length, hash: nextHash, recoveryPath: null })
  vi.spyOn(ProjectFileClient.prototype, 'readPreview').mockImplementation(async (target) => ({ bytes, versionId: target.id, truncated: false }))
  vi.spyOn(ProjectFileClient.prototype, 'saveText').mockResolvedValue({ ...file, id: 'file-saved' })
  container = document.createElement('div'); document.body.append(container); app = createRoot(container)
})
afterEach(async () => {
  await act(async () => app.unmount()); container.remove()
  desktopHost.available = previousAvailability; vi.restoreAllMocks()
})

function context(role: 'owner' | 'editor' | 'viewer' = 'editor'): CollaborationFileContext {
  return { client: new CollaborationServiceClient('https://files.example.test', async () => 'token'), workspace: { id: 'team', name: 'Team', role, createdAt: file.createdAt }, projectId: 'paper', currentUserId: 'alice' }
}
async function render(extra: { context?: CollaborationFileContext; root?: string; scope?: string; bundledFiles?: { path: string; content: string }[] } = {}) {
  await act(async () => app.render(<ProjectDocumentWorkspace workspaceRef={workspace} scope={extra.scope ?? 'test-project'} root={extra.root === '' ? undefined : extra.root ?? '/research/project'} manuscriptPath="paper.qmd" images={[]} sharedImages={[]} bundledFiles={extra.bundledFiles ?? []} onNotice={onNotice} context={extra.context}><div data-testid="manuscript" contentEditable suppressContentEditableWarning>Unsaved manuscript text</div></ProjectDocumentWorkspace>))
}
async function open(path: string, options?: Parameters<ProjectDocumentWorkspaceHandle['openFile']>[1]) {
  await act(async () => workspace.current!.openFile(path, options))
}
function tabs() { return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')] }
function viewer(location?: 'Local' | 'Online') {
  return [...container.querySelectorAll<HTMLDivElement>('[data-viewer]')].find((element) => !location || element.textContent?.includes(`${location} ·`))!
}
async function clickWithin(element: Element, label: string) {
  await act(async () => [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!.click())
}

describe('project document workspace integration', () => {
  it('reloads clean file tabs after external Git changes without replacing the manuscript', async () => {
    await render()
    await open('notes/methods.md', { keepOpen: true })
    const manuscript = container.querySelector('[data-testid="manuscript"]')
    const next = new TextEncoder().encode('Updated by a fast-forward pull')
    vi.mocked(desktopHost.readProjectFilePreview).mockResolvedValueOnce({ path: 'notes/methods.md', bytes: [...next], size: next.length, hash: nextHash, modifiedMs: 2, truncated: false })
    await act(async () => workspace.current!.reloadFiles())
    expect(viewer().querySelector('output')?.textContent).toBe('Updated by a fast-forward pull')
    expect(container.querySelector('[data-testid="manuscript"]')).toBe(manuscript)
    expect(tabs()).toHaveLength(2)
  })

  it('keeps dirty file drafts when refreshing clean tabs', async () => {
    await render()
    await open('notes/draft.md', { keepOpen: true })
    await clickWithin(viewer(), 'Change draft')
    const draft = viewer()
    await act(async () => workspace.current!.reloadFiles())
    expect(viewer()).toBe(draft)
    expect(viewer().querySelector('output')?.textContent).toBe('edited notes/draft.md')
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledTimes(1)
  })

  it('reads complete PDF previews up to 32 MiB locally and online without writing either copy', async () => {
    const pdf = { ...file, id: 'pdf-version', path: 'exports/article.PDF', size: 9 * 1024 * 1024, mediaType: 'application/pdf' }
    await render({ context: context() })
    await open(pdf.path, { keepOpen: true })
    expect(desktopHost.readProjectFilePreview).toHaveBeenLastCalledWith('/research/project', pdf.path, 32 * 1024 * 1024)
    await open(pdf.path, { location: 'online', file: pdf })
    expect(ProjectFileClient.prototype.readPreview).toHaveBeenLastCalledWith(pdf, 32 * 1024 * 1024, expect.any(AbortSignal))
    expect(desktopHost.saveProjectFileText).not.toHaveBeenCalled()
    expect(ProjectFileClient.prototype.saveText).not.toHaveBeenCalled()
  })

  it('keeps the manuscript DOM, selection, scroll and unsaved text while preview tabs replace one another', async () => {
    await render()
    const manuscript = container.querySelector<HTMLDivElement>('[data-testid="manuscript"]')!
    manuscript.scrollTop = 137
    const range = document.createRange(); range.setStart(manuscript.firstChild!, 8); range.collapse(true)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    await open('notes/first.md')
    expect(container.querySelector('#file-panel-manuscript')?.hasAttribute('hidden')).toBe(true)
    await open('notes/second.md')
    expect(tabs().map((tab) => tab.textContent)).toEqual(['paper.qmdManuscript', 'second.mdLocal'])
    await act(async () => workspace.current!.showManuscript())
    expect(container.querySelector('[data-testid="manuscript"]')).toBe(manuscript)
    expect(manuscript.textContent).toBe('Unsaved manuscript text')
    expect(manuscript.scrollTop).toBe(137)
    expect(window.getSelection()!.anchorNode).toBe(manuscript.firstChild)
    expect(window.getSelection()!.anchorOffset).toBe(8)
    expect(container.querySelector('#file-panel-manuscript')?.hasAttribute('hidden')).toBe(false)
  })

  it('retains kept and dirty drafts and refuses leaving or closing a dirty file without discarding it', async () => {
    await render()
    await open('notes/kept.md', { keepOpen: true })
    await open('notes/draft.md')
    await clickWithin(viewer(), 'Change draft')
    // The first viewer is the retained note; edit the active preview as well.
    const draft = container.querySelector('[data-viewer="notes/draft.md"]')!
    await clickWithin(draft, 'Change draft')
    await open('notes/third.md')
    expect(tabs()).toHaveLength(4)
    expect(workspace.current!.canLeave()).toBe(false)
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Save or close'))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close notes/draft.md (local)"]')!.click())
    expect(container.querySelector('[data-viewer="notes/draft.md"] output')?.textContent).toBe('edited notes/draft.md')
    expect(tabs()).toHaveLength(4)
  })

  it('navigates file tabs with the keyboard and retains duplicate filenames with visible folder paths', async () => {
    await render()
    await open('notes/analysis.md', { keepOpen: true })
    await open('methods/analysis.md', { keepOpen: true })
    expect(tabs()[1].textContent).toContain('notes/analysis.md')
    expect(tabs()[2].textContent).toContain('methods/analysis.md')
    const list = container.querySelector('[role="tablist"]')!
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[0])
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[2])
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, 0])
  })

  it('keeps a conflicting local draft and advances the saved fingerprint only after a successful save', async () => {
    await render()
    await open(file.path)
    await clickWithin(viewer(), 'Change draft')
    vi.mocked(desktopHost.saveProjectFileText).mockRejectedValueOnce(new Error('The file changed outside DraftMatter.'))
    await clickWithin(viewer(), 'Save draft')
    expect(viewer().textContent).toContain('The file changed outside DraftMatter.')
    expect(viewer().querySelector('output')?.textContent).toBe(`edited ${file.path}`)
    expect(workspace.current!.canLeave()).toBe(false)
    expect(desktopHost.saveProjectFileText).toHaveBeenLastCalledWith({ root: '/research/project', path: file.path, content: `edited ${file.path}`, expectedHash: originalHash })
    await clickWithin(viewer(), 'Save draft')
    expect(workspace.current!.canLeave()).toBe(true)
    await clickWithin(viewer(), 'Change draft')
    await clickWithin(viewer(), 'Save draft')
    expect(desktopHost.saveProjectFileText).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHash: nextHash }))
    expect(ProjectFileClient.prototype.saveText).not.toHaveBeenCalled()
  })

  it('keeps local and online versions separate and saves online edits against the latest successful version', async () => {
    await render({ context: context() })
    await open(file.path, { location: 'local', keepOpen: true })
    await open(file.path, { location: 'online', file, keepOpen: true })
    expect(tabs()).toHaveLength(3)
    expect(ProjectFileClient.prototype.readPreview).toHaveBeenCalledWith(file, 1024 * 1024, expect.any(AbortSignal))
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledWith('/research/project', file.path, 1024 * 1024)
    await clickWithin(viewer('Online'), 'Change draft')
    await clickWithin(viewer('Online'), 'Save draft')
    expect(ProjectFileClient.prototype.saveText).toHaveBeenLastCalledWith(file, `edited ${file.path}`)
    expect(desktopHost.saveProjectFileText).not.toHaveBeenCalled()
    await clickWithin(viewer('Online'), 'Change draft')
    await clickWithin(viewer('Online'), 'Save draft')
    expect(ProjectFileClient.prototype.saveText).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'file-saved' }), `edited ${file.path}`)
    await clickWithin(viewer('Local'), 'Change draft')
    await clickWithin(viewer('Local'), 'Save draft')
    expect(desktopHost.saveProjectFileText).toHaveBeenCalledTimes(1)
  })

  it('opens the original immutable version separately after the edited tab advances to a new version', async () => {
    await render({ context: context() })
    await open(file.path, { location: 'online', file, keepOpen: true })
    await clickWithin(viewer(), 'Change draft')
    await clickWithin(viewer(), 'Save draft')
    expect(viewer().textContent).toContain('Version file-saved')
    await open(file.path, { location: 'online', file })
    expect(tabs()).toHaveLength(3)
    expect(ProjectFileClient.prototype.readPreview).toHaveBeenCalledTimes(2)
    const original = [...container.querySelectorAll('[data-viewer]')].find((element) => element.textContent?.includes(`Version ${file.id}`))!
    expect(original.querySelector('output')?.textContent).toBe('original draft')
    expect(viewer().querySelector('output')?.textContent).toBe(`edited ${file.path}`)
    expect(tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true')[0].title).toContain(file.id)
  })

  it('ignores a stale local read that completes after closing and reopening the same path', async () => {
    const pending: Array<(value: Awaited<ReturnType<typeof desktopHost.readProjectFilePreview>>) => void> = []
    vi.mocked(desktopHost.readProjectFilePreview).mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    await render()
    await open('notes/reopened.md')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close notes/reopened.md (local)"]')!.click())
    await open('notes/reopened.md')
    const preview = (text: string) => ({ path: 'notes/reopened.md', bytes: [...new TextEncoder().encode(text)], size: text.length, hash: originalHash, modifiedMs: 1, truncated: false })
    await act(async () => pending[1](preview('new read')))
    expect(viewer().querySelector('output')?.textContent).toBe('new read')
    await act(async () => pending[0](preview('stale read')))
    expect(tabs()).toHaveLength(2)
    expect(viewer().querySelector('output')?.textContent).toBe('new read')
  })

  it('preserves a local dirty draft and manuscript instance while connecting and disconnecting the server', async () => {
    await render()
    const manuscript = container.querySelector('[data-testid="manuscript"]')!
    await open(file.path)
    await clickWithin(viewer(), 'Change draft')
    const draftView = viewer()
    await render({ context: context() })
    expect(viewer()).toBe(draftView)
    expect(viewer().querySelector('output')?.textContent).toBe(`edited ${file.path}`)
    expect(container.querySelector('[data-testid="manuscript"]')).toBe(manuscript)
    await render()
    expect(viewer()).toBe(draftView)
    expect(viewer().querySelector('output')?.textContent).toBe(`edited ${file.path}`)
    expect(workspace.current!.canLeave()).toBe(false)
    expect(container.querySelector('[data-testid="manuscript"]')).toBe(manuscript)
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledTimes(1)
  })

  it('rechecks online edit permission when access changes and preserves the pending draft', async () => {
    const liveContext = context()
    await render({ context: liveContext })
    await open(file.path, { location: 'online', file })
    await clickWithin(viewer(), 'Change draft')
    expect(viewer().dataset.editable).toBe('true')
    await render({ context: { ...liveContext, workspace: { ...liveContext.workspace, role: 'viewer' } } })
    expect(viewer().dataset.editable).toBe('false')
    await clickWithin(viewer(), 'Save draft')
    expect(ProjectFileClient.prototype.saveText).not.toHaveBeenCalled()
    expect(viewer().textContent).toContain('does not allow editing')
    expect(workspace.current!.canLeave()).toBe(false)
  })

  it('previews an online version in a plain browser without requesting a local filesystem or granting viewer editing', async () => {
    desktopHost.available = false
    await render({ root: '', context: context('viewer') })
    await open(file.path, { location: 'online', file })
    expect(ProjectFileClient.prototype.readPreview).toHaveBeenCalledWith(file, 1024 * 1024, expect.any(AbortSignal))
    expect(viewer().dataset.editable).toBe('false')
    expect(viewer().textContent).toContain(`Online · Version ${file.id}`)
    expect(desktopHost.readProjectFilePreview).not.toHaveBeenCalled()
    expect(desktopHost.saveProjectFileText).not.toHaveBeenCalled()
  })

  it('can reload after an online preview response is discarded during disconnection', async () => {
    const liveContext = context()
    let finish!: (value: Awaited<ReturnType<ProjectFileClient['readPreview']>>) => void
    vi.mocked(ProjectFileClient.prototype.readPreview).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await render({ context: liveContext })
    await open(file.path, { location: 'online', file })
    expect(container.textContent).toContain('Loading file preview')
    await render()
    await act(async () => finish({ bytes: new TextEncoder().encode('discarded response'), versionId: file.id, truncated: false }))
    expect(container.textContent).not.toContain('discarded response')
    await render({ context: liveContext })
    const reload = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reload file')!
    expect(reload.disabled).toBe(false)
    await act(async () => reload.click())
    expect(ProjectFileClient.prototype.readPreview).toHaveBeenCalledTimes(2)
    expect(viewer().querySelector('output')?.textContent).toBe('original draft')
    expect(viewer().textContent).toContain(`Version ${file.id}`)
  })

  it('does not substitute bundled local contents for an unavailable online file', async () => {
    desktopHost.available = false
    await render({ root: '', context: context(), bundledFiles: [{ path: file.path, content: 'private local bundled copy' }] })
    await open(file.path, { location: 'online' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unavailable in this copy')
    expect(container.textContent).not.toContain('private local bundled copy')
    expect(container.querySelector('[data-viewer]')).toBeNull()
    expect(desktopHost.readProjectFilePreview).not.toHaveBeenCalled()
  })

  it('restores only retained paths and immutable IDs, without persisting draft or manuscript content', async () => {
    const storageKey = 'draftmatter.file-tabs.v1:test-project'
    localStorage.setItem(storageKey, JSON.stringify([{ path: 'notes/restore.md', location: 'local', content: 'ignored secret' }, { path: file.path, location: 'online', fileId: file.id }]))
    vi.spyOn(ProjectFileClient.prototype, 'catalogue').mockResolvedValue({ files: [file], uploads: [], quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: file.size, reservedBytes: 0 } })
    await render({ context: context() })
    expect(tabs()).toHaveLength(3)
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledWith('/research/project', 'notes/restore.md', 1024 * 1024)
    await clickWithin(viewer('Local'), 'Change draft')
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([{ path: 'notes/restore.md', location: 'local' }, { path: file.path, location: 'online', fileId: file.id, remoteScope }])
    expect(localStorage.getItem(storageKey)).not.toContain('edited')
    expect(localStorage.getItem(storageKey)).not.toContain('original draft')
    expect(localStorage.getItem(storageKey)).not.toContain('Unsaved manuscript')
  })

  it('preserves a restored immutable version while its online catalogue is still loading', async () => {
    const storageKey = 'draftmatter.file-tabs.v1:test-project'
    const stored = [{ path: file.path, location: 'online', fileId: file.id }]
    localStorage.setItem(storageKey, JSON.stringify(stored))
    let finish!: (value: Awaited<ReturnType<ProjectFileClient['catalogue']>>) => void
    vi.spyOn(ProjectFileClient.prototype, 'catalogue').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await render({ context: context() })
    const whileLoading: unknown = JSON.parse(localStorage.getItem(storageKey)!)
    await act(async () => finish({ files: [file], uploads: [], quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: file.size, reservedBytes: 0 } }))
    expect(whileLoading).toEqual([{ ...stored[0], remoteScope }])
  })
})
