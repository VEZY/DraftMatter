// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import App from './App'
import { desktopHost, type DocumentRecoverySnapshot, type ProjectSnapshot } from './desktopHost'
import { parsePortableDocument } from './document'
import { initialDraft } from './sampleDraft'
import { readRecoverySnapshots, recoveryDocumentStorageKey, saveRecoverySnapshot } from './storage'

const projectRoot = '/research/native-history-fixture'
const paper = (title: string) => `---\ntitle: "${title}"\n---\n\n# ${title}\n\nExact ${title} source, with **formatting**.\n`
const savedAtMillis = Date.parse('2026-11-01T10:00:00.000Z')

describe('native recovery history stays attached to its manuscript', () => {
  let root: Root
  let container: HTMLDivElement
  let available: boolean
  let project: ProjectSnapshot
  let sources: Record<string, string>
  let archives: Map<string, DocumentRecoverySnapshot>
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    available = desktopHost.available
    desktopHost.available = true
    archives = new Map()
    sources = { 'paper.md': paper('Current paper'), 'concept.md': paper('Current concept'), 'README.md': paper('Current README') }
    project = {
      root: projectRoot,
      config: { schemaVersion: 1, name: 'Native history fixture', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
      documents: Object.keys(sources).map((path) => ({ path, kind: 'manuscript', bytes: sources[path].length, modifiedMs: 1, hash: path })),
      bibliographies: [],
    }
    vi.spyOn(desktopHost, 'openProject').mockImplementation(async () => project)
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async (_root, path) => ({ path, content: sources[path], hash: path, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'listProjectFiles').mockImplementation(async () => ({ files: project.documents.map(({ path, bytes, modifiedMs }) => ({ path, bytes, modifiedMs })), truncated: false }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'documentStatus').mockImplementation(async (_root, path) => ({ kind: 'current', hash: path, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'listDocumentRecoveries').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listSavedDocumentVersions').mockImplementation(async (_root, path) => [...archives.values()].filter((entry) => entry.documentPath === path).map(({ source, ...entry }) => ({ ...entry, kind: entry.kind as 'manual', sourceHash: entry.sourceHash!, bytes: entry.bytes!, title: parsePortableDocument(source, initialDraft).draft.title })))
    vi.spyOn(desktopHost, 'readSavedDocumentVersion').mockImplementation(async (_root, path, id) => {
      const entry = archives.get(id)
      if (!entry || entry.documentPath !== path) throw new Error('Saved version belongs to another document')
      return entry
    })
    vi.spyOn(desktopHost, 'createDocumentRecovery').mockImplementation(async (_root, path, content, _preserve, options) => {
      const entry = { id: `archive-${archives.size + 1}`, documentPath: path, source: content, savedAtMillis: Date.now(), ...options, sourceHash: `sha256:${createHash('sha256').update(content).digest('hex')}`, bytes: new TextEncoder().encode(content).byteLength }
      archives.set(entry.id, entry)
      return entry
    })
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => {
      sources[request.path] = request.content
      return { path: request.path, hash: request.path, bytes: request.content.length, recoveryPath: '.draftmatter/recovery/retained-current.bak' }
    })
    vi.spyOn(desktopHost, 'setMainDocument').mockImplementation(async (_root, path) => {
      project = { ...project, config: { ...project.config, mainDocument: path } }
      return project
    })
    vi.spyOn(desktopHost, 'executeKernel').mockRejectedValue(new Error('Recovery must not execute manuscript code'))
    vi.spyOn(desktopHost, 'gitRestoreCheckpoint').mockRejectedValue(new Error('Recovery does not use Git'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = available
    vi.restoreAllMocks()
  })
  async function waitFor(check: () => void) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { check(); return } catch { await act(async () => new Promise((resolve) => setTimeout(resolve, 10))) }
    }
    check()
  }
  async function open() {
    await act(async () => root.render(<App desktopProjectLaunch={project} selectedManuscriptPath="paper.md" />))
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('paper.md'))
  }
  async function history() { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click()) }
  async function restoreSelected() {
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>('.recovery-restore-version')?.disabled).toBe(false))
    await act(async () => container.querySelector<HTMLButtonElement>('.recovery-restore-version')!.click())
  }
  async function editSource(source: string) {
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('View source'))!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Edit source'))!.click())
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, source)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Apply source'))!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close source inspector"]')!.click())
  }
  function fillRecoveryQuota() {
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('draftmatter.recovery.v3:')) throw new DOMException('Recovery storage is full', 'QuotaExceededError')
      originalSetItem.call(this, key, value)
    })
  }

  it('restores an exactly scoped disk backup and filters foreign paths without assigning old global versions', async () => {
    const oldSource = paper('Verified older paper')
    vi.mocked(desktopHost.listDocumentRecoveries).mockResolvedValue([
      { id: 'verified-paper-backup', documentPath: 'paper.md', source: oldSource, savedAtMillis },
      { id: 'foreign-readme-backup', documentPath: 'README.md', source: paper('Foreign README backup'), savedAtMillis },
    ])
    const legacySource = paper('Unassigned paper from another project')
    saveRecoverySnapshot(localStorage, parsePortableDocument(legacySource, initialDraft).draft, 'paper.md', legacySource)
    const legacyBefore = localStorage.getItem('draftmatter.recovery.v1')
    const originals = { ...sources }
    await open()
    await history()
    await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older paper'))
    expect(desktopHost.listDocumentRecoveries).toHaveBeenCalledExactlyOnceWith(projectRoot, 'paper.md')
    expect(container.querySelector('.recovery-list')?.textContent).not.toContain('Foreign README backup')
    expect(container.querySelector('.recovery-list')?.textContent).not.toContain('Unassigned paper')
    const restore = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((button) => button.textContent?.includes('Verified older paper'))!
    await act(async () => restore.click())
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(sources['paper.md']).toBe(originals['paper.md'])
    await restoreSelected()
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Exact Verified older paper source')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)) })
    expect(desktopHost.saveDocument).toHaveBeenLastCalledWith(expect.objectContaining({ root: projectRoot, path: 'paper.md', content: oldSource, expectedHash: 'paper.md' }))
    expect(sources['paper.md']).toBe(oldSource)
    expect(sources['concept.md']).toBe(originals['concept.md'])
    expect(sources['README.md']).toBe(originals['README.md'])
    expect(readRecoverySnapshots(localStorage, { kind: 'desktop', projectRoot, documentPath: 'paper.md' }).some((version) => version.source === originals['paper.md'])).toBe(true)
    expect(localStorage.getItem('draftmatter.recovery.v1')).toBe(legacyBefore)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
    expect([...archives.values()].map((entry) => entry.kind)).toEqual(['before-restore', 'origin', 'restored'])
    await history()
    expect(container.querySelector('[data-history-select="disk:verified-paper-backup"]')).not.toBeNull()
    expect(container.querySelectorAll('.recovery-version-origin')).toHaveLength(4)
  })

  it('ignores a late native history result after switching to a different manuscript', async () => {
    let finishPaper!: (versions: DocumentRecoverySnapshot[]) => void
    const pendingPaper = new Promise<DocumentRecoverySnapshot[]>((resolve) => { finishPaper = resolve })
    vi.mocked(desktopHost.listDocumentRecoveries).mockImplementation(async (_root, path) => path === 'paper.md' ? pendingPaper : [
      { id: 'concept-backup', documentPath: 'concept.md', source: paper('Verified older concept'), savedAtMillis },
    ])
    await open()
    await history()
    expect(desktopHost.listDocumentRecoveries).toHaveBeenCalledWith(projectRoot, 'paper.md')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close recovery history"]')!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Switch manuscript…')!.click())
    await waitFor(() => expect(container.querySelector('[aria-label="Choose main manuscript"]')).not.toBeNull())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.manuscript-choice-list button')].find((button) => button.querySelector('strong')?.textContent === 'concept.md')!.click())
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('concept.md'))
    await history()
    await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older concept'))
    expect(desktopHost.listDocumentRecoveries).toHaveBeenLastCalledWith(projectRoot, 'concept.md')
    await act(async () => { finishPaper([{ id: 'late-paper', documentPath: 'paper.md', source: paper('Stale foreign paper'), savedAtMillis }]) })
    expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older concept')
    expect(container.querySelector('.recovery-list')?.textContent).not.toContain('Stale foreign paper')
    expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('concept.md')
    expect(sources['paper.md']).toBe(paper('Current paper'))
    expect(sources['concept.md']).toBe(paper('Current concept'))
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it.each(['native', 'local'] as const)('keeps the unsaved current source in a native safety copy when restoring a %s version with full browser storage', async (kind) => {
    const oldSource = paper('Verified older paper')
    vi.mocked(desktopHost.listDocumentRecoveries).mockResolvedValue(kind === 'native' ? [{ id: 'verified-paper-backup', documentPath: 'paper.md', source: oldSource, savedAtMillis }] : [])
    if (kind === 'local') saveRecoverySnapshot(localStorage, parsePortableDocument(oldSource, initialDraft).draft, 'paper.md', oldSource, '2026-11-01T10:00:00.000Z', undefined, { documentIdentity: { kind: 'desktop', projectRoot, documentPath: 'paper.md' } })
    const captured: DocumentRecoverySnapshot[] = []
    const createVersion = vi.mocked(desktopHost.createDocumentRecovery).getMockImplementation()!
    vi.mocked(desktopHost.createDocumentRecovery).mockImplementation(async (...args) => {
      const copy = await createVersion(...args)
      captured.push(copy)
      return copy
    })
    const legacySource = paper('Unassigned legacy manuscript')
    saveRecoverySnapshot(localStorage, parsePortableDocument(legacySource, initialDraft).draft, 'paper.md', legacySource)
    const legacyBefore = localStorage.getItem('draftmatter.recovery.v1')
    await open()
    const key = recoveryDocumentStorageKey({ kind: 'desktop', projectRoot, documentPath: 'paper.md' })
    const scopedBefore = localStorage.getItem(key)
    const unsavedSource = paper('My unsaved current manuscript')
    await editSource(unsavedSource)
    fillRecoveryQuota()
    await history()
    await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older paper'))
    const restore = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((button) => button.textContent?.includes('Verified older paper'))!
    await act(async () => restore.click())
    await restoreSelected()
    await waitFor(() => expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Exact Verified older paper source'))
    expect(desktopHost.createDocumentRecovery).toHaveBeenCalledTimes(3)
    expect(vi.mocked(desktopHost.createDocumentRecovery).mock.calls[0].slice(0, 3)).toEqual([projectRoot, 'paper.md', unsavedSource])
    expect(vi.mocked(desktopHost.createDocumentRecovery).mock.calls[0][4]?.kind).toBe('before-restore')
    expect(captured.map((entry) => entry.kind)).toEqual(['before-restore', 'origin', 'restored'])
    expect(captured[1].source).toBe(oldSource)
    expect(captured[2].source).toBe(oldSource)
    expect(captured[2].id).not.toBe(captured[1].id)
    expect(captured[0].source).toBe(unsavedSource)
    expect(localStorage.getItem(key)).toBe(scopedBefore)
    expect(localStorage.getItem('draftmatter.recovery.v1')).toBe(legacyBefore)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)) })
    expect(sources['paper.md']).toBe(oldSource)
    expect(sources['concept.md']).toBe(paper('Current concept'))
    expect(captured[0].source).toBe(unsavedSource)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('leaves the current editor and disk intact if both browser and native safety-copy writes fail', async () => {
    const oldSource = paper('Verified older paper')
    vi.mocked(desktopHost.listDocumentRecoveries).mockResolvedValue([{ id: 'verified-paper-backup', documentPath: 'paper.md', source: oldSource, savedAtMillis }])
    vi.mocked(desktopHost.createDocumentRecovery).mockRejectedValue(new Error('The recovery disk is full'))
    await open()
    const key = recoveryDocumentStorageKey({ kind: 'desktop', projectRoot, documentPath: 'paper.md' })
    const scopedBefore = localStorage.getItem(key)
    const unsavedSource = paper('Keep these unsaved manuscript changes')
    await editSource(unsavedSource)
    fillRecoveryQuota()
    await history()
    await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older paper'))
    const restore = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((button) => button.textContent?.includes('Verified older paper'))!
    await act(async () => restore.click())
    await restoreSelected()
    expect(desktopHost.createDocumentRecovery).toHaveBeenCalledExactlyOnceWith(projectRoot, 'paper.md', unsavedSource, undefined, { kind: 'before-restore' })
    expect(container.querySelector('[aria-label="Recovery history"]')).not.toBeNull()
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Keep these unsaved manuscript changes')
    expect(sources['paper.md']).toBe(paper('Current paper'))
    expect(sources['concept.md']).toBe(paper('Current concept'))
    expect(localStorage.getItem(key)).toBe(scopedBefore)
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('refuses a native safety copy whose returned content does not match the current editor', async () => {
    const oldSource = paper('Verified older paper')
    vi.mocked(desktopHost.listDocumentRecoveries).mockResolvedValue([{ id: 'verified-paper-backup', documentPath: 'paper.md', source: oldSource, savedAtMillis }])
    vi.mocked(desktopHost.createDocumentRecovery).mockResolvedValue({ id: 'invalid-copy', documentPath: 'paper.md', source: 'Unexpected different content', savedAtMillis })
    await open()
    await history()
    await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older paper'))
    const restore = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((button) => button.textContent?.includes('Verified older paper'))!
    await act(async () => restore.click())
    await restoreSelected()
    expect(container.querySelector('.toast')?.textContent).toContain('saved version could not be verified')
    expect(container.querySelector('[aria-label="Recovery history"]')).not.toBeNull()
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Exact Current paper source')
    expect(sources['paper.md']).toBe(paper('Current paper'))
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('does not replace an external edit arriving while the native safety copy is pending', async () => {
    const oldSource = paper('Verified older paper')
    vi.mocked(desktopHost.listDocumentRecoveries).mockResolvedValue([{ id: 'verified-paper-backup', documentPath: 'paper.md', source: oldSource, savedAtMillis }])
    let finishCopy!: (snapshot: DocumentRecoverySnapshot) => void
    vi.mocked(desktopHost.createDocumentRecovery).mockImplementation(() => new Promise((resolve) => { finishCopy = resolve }))
    await open()
    await history()
    await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain('Verified older paper'))
    const restore = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((button) => button.textContent?.includes('Verified older paper'))!
    await act(async () => restore.click())
    await restoreSelected()
    expect(desktopHost.createDocumentRecovery).toHaveBeenCalled()
    const externalSource = paper('Latest external edit')
    sources['paper.md'] = externalSource
    vi.mocked(desktopHost.documentStatus).mockResolvedValueOnce({ kind: 'modified', hash: 'external-revision', modifiedMs: 2 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1300)) })
    await waitFor(() => expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Latest external edit'))
    await act(async () => { finishCopy({ id: 'saved-earlier-copy', documentPath: 'paper.md', source: paper('Current paper'), savedAtMillis, kind: 'before-restore', sourceHash: `sha256:${createHash('sha256').update(paper('Current paper')).digest('hex')}` }) })
    expect(container.querySelector('.toast')?.textContent).toContain('manuscript changed while creating its safety copy')
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Latest external edit')
    expect(sources['paper.md']).toBe(externalSource)
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })
})
