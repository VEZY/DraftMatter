// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { BROWSER_ASSET_SCOPE_KEY } from './browserProjectAssets'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { parsePortableDocument, sourceHash } from './document'
import { initialDraft } from './sampleDraft'
import { readRecoverySnapshots, recoveryDocumentStorageKey, saveRecoverySnapshot, type RecoveryDocumentIdentity, type RecoverySnapshot } from './storage'

const sourceKey = 'draftmatter.structured-source.v1'
const projectRoot = '/research/history-preview-fixture'
const browserIdentity: Extract<RecoveryDocumentIdentity, { kind: 'browser' }> = { kind: 'browser', browserAssetScope: 'history-preview-browser', documentPath: 'paper.md' }
const desktopIdentity: Extract<RecoveryDocumentIdentity, { kind: 'desktop' }> = { kind: 'desktop', projectRoot, documentPath: 'paper.md' }
const paper = (title: string, result: string) => `---\ntitle: "${title}"\n---\n\n# Results\n\n${result}\n\nKeep this **formatting** and the hidden code.\n\n\`\`\`python {#saved-code .execute}\nprint("must not execute")\n\`\`\`\n`
const currentSource = paper('Current working article', 'Current result of 18 units.')
const olderSource = paper('Earlier article one', 'Older result of 12 units.')
const otherSource = paper('Earlier article two', 'Older result of 15 units.')

describe('browsing manuscript history without restoring it', () => {
  let root: Root
  let container: HTMLDivElement
  let previousAvailability: boolean
  let diskSource: string

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    previousAvailability = desktopHost.available
    diskSource = currentSource
    vi.spyOn(desktopHost, 'executeKernel').mockRejectedValue(new Error('History browsing cannot execute manuscript code'))
    vi.spyOn(desktopHost, 'probeRuntime').mockRejectedValue(new Error('History browsing cannot inspect language runtimes'))
    vi.spyOn(desktopHost, 'gitRestoreCheckpoint').mockRejectedValue(new Error('History browsing does not restore Git checkpoints'))
    vi.spyOn(desktopHost, 'listDocumentRecoveries').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listSavedDocumentVersions').mockResolvedValue([])
    let archiveIndex = 0
    vi.spyOn(desktopHost, 'createDocumentRecovery').mockImplementation(async (_root, path, content, _preservedId, options) => ({
      id: `preview-archive-${++archiveIndex}`, documentPath: path, source: content, savedAtMillis: Date.now(),
      sourceHash: sourceHash(content), bytes: new TextEncoder().encode(content).byteLength, ...options,
    }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => {
      diskSource = request.content
      return { path: request.path, hash: 'saved-paper', bytes: request.content.length, recoveryPath: null }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = previousAvailability
    localStorage.clear()
    vi.restoreAllMocks()
  })

  function seed(identity: RecoveryDocumentIdentity) {
    const versions: RecoverySnapshot[] = []
    for (const [index, source] of [olderSource, otherSource].entries()) {
      const entries = saveRecoverySnapshot(localStorage, parsePortableDocument(source, initialDraft).draft,
        'paper.md', source, `2026-11-01T10:0${index}:00.000Z`, identity.kind === 'browser' ? identity.browserAssetScope : undefined,
        { documentIdentity: identity })
      versions.push(entries[0])
    }
    return versions
  }

  async function waitFor(check: () => void) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { check(); return } catch { await act(async () => new Promise((resolve) => setTimeout(resolve, 10))) }
    }
    check()
  }
  async function pause(milliseconds: number) { await act(async () => new Promise((resolve) => setTimeout(resolve, milliseconds))) }
  function history() { return container.querySelector<HTMLElement>('[aria-label="Recovery history"]')! }
  function button(name: string, boundary: ParentNode = container) {
    return [...boundary.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)!
  }
  async function showHistory() { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click()) }
  async function select(title: string) {
    const version = [...history().querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((candidate) => candidate.textContent?.includes(title))!
    expect(version).toBeDefined()
    await act(async () => version.click())
  }
  async function tab(name: 'Preview' | 'Source' | 'Changes') {
    const selectedTab = [...history().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((candidate) => candidate.textContent === name)!
    await act(async () => selectedTab.click())
  }
  async function keepNamedVersion(label: string, selected = true) {
    await act(async () => button(selected ? 'Name & keep version' : 'Name current version', history()).click())
    const input = history().querySelector<HTMLInputElement>('form input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, label)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Keep named version', history()).click())
    await waitFor(() => expect(history().querySelector('form')).toBeNull())
  }
  function expectEditorUnchanged() {
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Current result of 18 units.')
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).not.toContain('Older result of 12 units.')
    expect(localStorage.getItem(sourceKey)).toBe(currentSource)
  }

  async function openBrowser() {
    desktopHost.available = false
    localStorage.setItem(sourceKey, currentSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    localStorage.setItem(BROWSER_ASSET_SCOPE_KEY, browserIdentity.browserAssetScope)
    localStorage.setItem('draftmatter.project-meta.v1', JSON.stringify({ filename: 'paper.md', projectName: 'History preview fixture' }))
    const versions = seed(browserIdentity)
    await act(async () => root.render(<App />))
    await waitFor(() => expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Current result of 18 units.'))
    // Settle the ordinary 380 ms draft autosave and 1.8 s recovery snapshot first.
    await pause(2_050)
    return versions
  }

  async function openDesktop() {
    desktopHost.available = true
    const project: ProjectSnapshot = {
      root: projectRoot,
      config: { schemaVersion: 1, name: 'History preview fixture', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
      documents: [{ path: 'paper.md', kind: 'manuscript', bytes: currentSource.length, modifiedMs: 1, hash: 'current-paper' }], bibliographies: [],
    }
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async () => ({ path: 'paper.md', content: diskSource, hash: 'current-paper', modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'current-paper', modifiedMs: 1 })
    seed(desktopIdentity)
    await act(async () => root.render(<App desktopProjectLaunch={project} />))
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('paper.md'))
    await pause(2_050)
  }

  it('previews several browser versions, source and changes without replacing the paper or writing any snapshot', async () => {
    const versions = await openBrowser()
    const beforeJournal = localStorage.getItem(recoveryDocumentStorageKey(browserIdentity))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    await showHistory()
    expect(history().querySelector('[data-history-select="current"]')?.getAttribute('aria-pressed')).toBe('true')
    await select('Earlier article one')
    expect(history().querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Older result of 12 units.')
    expect(history().querySelector('[contenteditable="true"]')).toBeNull()
    expect(button('Restore this version', history())).toBeDefined()
    expectEditorUnchanged()

    await tab('Source')
    expect(history().querySelector('[aria-label="Version source"]')?.textContent).toBe(olderSource)
    await tab('Changes')
    expect(history().querySelector('[aria-label="Changes from selected version to current manuscript"]')).not.toBeNull()
    expect(history().textContent).toContain('added')
    await select('Earlier article two')
    await tab('Preview')
    expect(history().querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Older result of 15 units.')
    expectEditorUnchanged()

    await act(async () => history().querySelector<HTMLButtonElement>('[data-history-select="current"]')!.click())
    expect(history().querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Current result of 18 units.')
    expect(button('Restore this version', history())).toBeUndefined()
    await act(async () => button('Back to current manuscript', history()).click())
    expect(container.querySelector('[aria-label="Recovery history"]')).toBeNull()
    expectEditorUnchanged()
    expect(localStorage.getItem(recoveryDocumentStorageKey(browserIdentity))).toBe(beforeJournal)
    expect(readRecoverySnapshots(localStorage, browserIdentity).filter((version) => versions.some((original) => original.id === version.id)).map((version) => version.id).sort()).toEqual(versions.map((version) => version.id).sort())
    expect(writes).not.toHaveBeenCalled()
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('keeps desktop files and undo state untouched while browsing, including global shortcuts in the modal', async () => {
    await openDesktop()
    const beforeJournal = localStorage.getItem(recoveryDocumentStorageKey(desktopIdentity))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    await showHistory()
    await select('Earlier article one')
    await tab('Source')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[role="search"][aria-label="Find in document"]')).toBeNull()
    expect(history().querySelector('[aria-label="Version source"]')?.textContent).toBe(olderSource)
    expectEditorUnchanged()
    await select('Earlier article two')
    await act(async () => button('Back to current manuscript', history()).click())
    expect(diskSource).toBe(currentSource)
    expect(localStorage.getItem(recoveryDocumentStorageKey(desktopIdentity))).toBe(beforeJournal)
    expect(writes).not.toHaveBeenCalled()
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('restores only through the separate explicit action, after read-only selection', async () => {
    await openDesktop()
    await showHistory()
    await select('Earlier article one')
    expectEditorUnchanged()
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    await act(async () => button('Restore this version', history()).click())
    await waitFor(() => expect(container.querySelector('[aria-label="Recovery history"]')).toBeNull())
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Older result of 12 units.')
    await waitFor(() => expect(diskSource).toBe(olderSource))
    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ root: projectRoot, path: 'paper.md', content: olderSource }))
    expect(vi.mocked(desktopHost.createDocumentRecovery).mock.calls.map((call) => call[4]?.kind)).toEqual(['before-restore', 'origin', 'restored'])
    expect(vi.mocked(desktopHost.createDocumentRecovery).mock.calls.map((call) => call[2])).toEqual([currentSource, olderSource, olderSource])
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('appends explicit saved versions without moving the preview or replacing older version identities', async () => {
    const originals = await openBrowser()
    await showHistory()
    await select('Earlier article one')
    await tab('Source')
    const selectedId = history().querySelector<HTMLButtonElement>('.recovery-list > button[aria-pressed="true"]')!.dataset.historySelect
    const before = readRecoverySnapshots(localStorage, browserIdentity)
    for (let index = 0; index < 2; index++) {
      await act(async () => button('Save version', history()).click())
      await waitFor(() => expect(readRecoverySnapshots(localStorage, browserIdentity).filter((version) => version.kind === 'manual')).toHaveLength(index + 1))
      expect(history().querySelector<HTMLButtonElement>('.recovery-list > button[aria-pressed="true"]')?.dataset.historySelect).toBe(selectedId)
      expect(history().querySelector('[aria-label="Version source"]')?.textContent).toBe(olderSource)
      expectEditorUnchanged()
    }
    const after = readRecoverySnapshots(localStorage, browserIdentity)
    const manual = after.filter((version) => version.kind === 'manual')
    expect(manual.map((version) => version.source)).toEqual([currentSource, currentSource])
    expect(new Set(manual.map((version) => version.id)).size).toBe(2)
    expect(after.filter((version) => originals.some((original) => original.id === version.id))).toEqual(before.filter((version) => originals.some((original) => original.id === version.id)))
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
  })

  it('keeps a restored original visible after eight later automatic snapshots and reopening history', async () => {
    const [original] = await openBrowser()
    await showHistory()
    await select(original.title)
    await act(async () => button('Restore this version', history()).click())
    await waitFor(() => expect(container.querySelector('[aria-label="Recovery history"]')).toBeNull())
    for (let index = 0; index < 8; index++) {
      const source = paper(`Later automatic version ${index}`, `New result ${index}.`)
      saveRecoverySnapshot(localStorage, parsePortableDocument(source, initialDraft).draft, 'paper.md', source,
        new Date(Date.now() + (index + 1) * 1000).toISOString(), browserIdentity.browserAssetScope,
        { documentIdentity: browserIdentity })
    }
    expect(readRecoverySnapshots(localStorage, browserIdentity).find((version) => version.id === original.id)).toEqual(original)
    await showHistory()
    const originalButton = [...history().querySelectorAll<HTMLButtonElement>('.recovery-list > button')]
      .find((candidate) => candidate.dataset.historySelect === original.id)
    expect(originalButton).toBeDefined()
    await act(async () => originalButton!.click())
    await tab('Source')
    expect(history().querySelector('[aria-label="Version source"]')?.textContent).toBe(original.source)
    expect(history().textContent).toContain('Later automatic version 7')
    expect(history().textContent).toContain('Before restoration')
    expect(history().textContent).toContain('Restored version')
  })

  it('keeps named browser versions and their original source date without restoring or changing the preview', async () => {
    const [original] = await openBrowser()
    await showHistory()
    await select(original.title)
    await keepNamedVersion('Before the co-author revisions')
    const named = readRecoverySnapshots(localStorage, browserIdentity).find((version) => version.label === 'Before the co-author revisions')!
    expect(named).toMatchObject({ kind: 'manual', source: original.source, savedAt: original.savedAt, restoredFromId: original.id })
    expect(named.id).not.toBe(original.id)
    expect(history().textContent).toContain('Before the co-author revisions')
    expect(history().textContent).toContain('Named · kept')
    expect(history().querySelector<HTMLButtonElement>('.recovery-list > button[aria-pressed="true"]')?.dataset.historySelect).toBe(original.id)
    expectEditorUnchanged()
    await keepNamedVersion('Current working milestone', false)
    expect(readRecoverySnapshots(localStorage, browserIdentity).find((version) => version.label === 'Current working milestone')?.source).toBe(currentSource)
    expectEditorUnchanged()
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
  })

  it('archives a named desktop source with its original date and reloads the label without modifying the file', async () => {
    await openDesktop()
    await showHistory()
    await select('Earlier article one')
    await keepNamedVersion('Before review')
    expect(desktopHost.createDocumentRecovery).toHaveBeenCalledExactlyOnceWith(projectRoot, 'paper.md', olderSource, undefined,
      expect.objectContaining({ kind: 'manual', label: 'Before review', originalSavedAtMillis: Date.parse('2026-11-01T10:00:00.000Z') }))
    expectEditorUnchanged()
    expect(diskSource).toBe(currentSource)
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    const copy = await vi.mocked(desktopHost.createDocumentRecovery).mock.results[0].value
    vi.mocked(desktopHost.listSavedDocumentVersions).mockResolvedValue([{ ...copy, kind: 'manual', sourceHash: copy.sourceHash!, bytes: copy.bytes!, title: 'Earlier article one' }])
    await act(async () => button('Back to current manuscript', history()).click())
    await showHistory()
    await waitFor(() => expect(history().textContent).toContain('Before review'))
    const namedButton = [...history().querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((candidate) => candidate.textContent?.includes('Before review'))!
    expect(namedButton.textContent).toContain(new Date('2026-11-01T10:00:00.000Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }))
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })
})
