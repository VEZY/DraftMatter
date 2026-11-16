// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { parsePortableDocument } from './document'
import { initialDraft } from './sampleDraft'
import { BROWSER_ASSET_SCOPE_KEY } from './browserProjectAssets'
import { readRecoverySnapshots, recoveryDocumentStorageKey, saveRecoverySnapshot, type KeyValueStorage, type RecoveryDocumentIdentity } from './storage'

const browserIdentity: Extract<RecoveryDocumentIdentity, { kind: 'browser' }> = { kind: 'browser', browserAssetScope: 'recovery-browser-fixture', documentPath: 'paper.qmd' }
const recoveryKey = recoveryDocumentStorageKey(browserIdentity)
const text = 'Measured canopy responses remained reproducible across repeated observations. '.repeat(100)
const paper = (version: string) => `---\ntitle: "${version}"\n---\n\n# ${version}\n\n${text}\n\nKeep ${version} exactly.\n`

function seedHistory() {
  const values = new Map<string, string>()
  const storage: KeyValueStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
  for (let index = 0; index < 8; index += 1) {
    const source = paper(`Version ${index}`)
    saveRecoverySnapshot(storage, parsePortableDocument(source, initialDraft).draft, 'paper.qmd', source, `2026-07-14T10:0${index}:00.000Z`, undefined, { documentIdentity: browserIdentity })
  }
  const entries = readRecoverySnapshots(storage, browserIdentity)
  // Stress a known document's journal in uncompacted form; this is not legacy attribution.
  localStorage.setItem(recoveryKey, JSON.stringify({ schemaVersion: 1, snapshots: entries }))
  return entries
}

function seedBrowserCopy(source: string) {
  localStorage.setItem('draftmatter.structured-source.v1', source)
  localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  localStorage.setItem(BROWSER_ASSET_SCOPE_KEY, browserIdentity.browserAssetScope)
  localStorage.setItem('draftmatter.project-meta.v1', JSON.stringify({ filename: browserIdentity.documentPath, projectName: 'Recovery fixture' }))
}

describe('recovery restoration with constrained local storage', () => {
  let root: Root
  let container: HTMLDivElement
  let available: boolean
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    available = desktopHost.available
    desktopHost.available = false
    vi.spyOn(desktopHost, 'listDocumentRecoveries').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listSavedDocumentVersions').mockResolvedValue([])
    vi.spyOn(desktopHost, 'createDocumentRecovery').mockImplementation(async (_root, path, source, _preserve, options) => ({ id: crypto.randomUUID(), documentPath: path, source, savedAtMillis: Date.now(), ...options, sourceHash: `saved:${source.length}`, bytes: source.length }))
    vi.spyOn(desktopHost, 'executeKernel').mockRejectedValue(new Error('No execution during recovery'))
    vi.spyOn(desktopHost, 'gitRestoreCheckpoint').mockRejectedValue(new Error('No Git during recovery'))
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

  it('restores the selected old source and keeps a safety copy of the current draft when the previous journal format would exceed quota', async () => {
    const entries = seedHistory()
    const target = entries.at(-1)!
    const currentSource = `${paper('Current editor copy')}\n${text.repeat(10)}`
    seedBrowserCopy(currentSource)
    await act(async () => root.render(<App />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)) })
    const byteSize = (key: string, value: string) => 2 * (key.length + value.length)
    const usedBytes = () => Object.keys(localStorage).reduce((total, key) => total + byteSize(key, localStorage.getItem(key)!), 0)
    // Allow the two new pinned event headers, while retaining too little room
    // for the old uncompacted journal to preserve the longer current draft.
    const limit = usedBytes() + 30_000
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      const previous = this.getItem(key)
      const nextSize = usedBytes() - (previous === null ? 0 : byteSize(key, previous)) + byteSize(key, value)
      if (nextSize > limit) throw new DOMException('Shared local storage quota exceeded', 'QuotaExceededError')
      originalSetItem.call(this, key, value)
    })
    // The longer current draft cannot fit in the previous format, even with its eight-version cap.
    expect(usedBytes() - byteSize(recoveryKey, localStorage.getItem(recoveryKey)!) + byteSize(recoveryKey, JSON.stringify({ schemaVersion: 1, snapshots: [{ ...entries[0], source: currentSource, draft: parsePortableDocument(currentSource, initialDraft).draft }, ...entries].slice(0, 8) }))).toBeGreaterThan(limit)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    const targetButton = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((button) => button.textContent?.includes(target.title))!
    await act(async () => targetButton.click())
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Current editor copy')
    await act(async () => container.querySelector<HTMLButtonElement>('.recovery-restore-version')!.click())
    const restored = readRecoverySnapshots(localStorage, browserIdentity)
    expect(restored[0].source).toBe(target.source)
    expect(restored[0].kind).toBe('restored')
    expect(restored[0].restoredFromId).toBe(target.id)
    expect(restored.some((entry) => entry.source === currentSource && entry.kind === 'before-restore')).toBe(true)
    expect(restored.find((entry) => entry.id === target.id)).toEqual(target)
    expect(container.querySelector('[aria-label="Recovery history"]')).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)) })
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toBe(target.source)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Keep Version 0 exactly.')
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('keeps the current manuscript and previous journal intact when no safety copy can be written', async () => {
    const entries = seedHistory()
    const currentSource = paper('Unsaved current draft')
    seedBrowserCopy(currentSource)
    await act(async () => root.render(<App />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)) })
    const before = localStorage.getItem(recoveryKey)
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === recoveryKey) throw new DOMException('Local storage is unavailable', 'QuotaExceededError')
      originalSetItem.call(this, key, value)
    })
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.recovery-list > button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.recovery-restore-version')!.click())
    expect(container.querySelector('[aria-label="Recovery history"]')).not.toBeNull()
    expect(container.textContent).toContain('Could not create a safety copy of the current draft')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toBe(currentSource)
    expect(localStorage.getItem(recoveryKey)).toBe(before)
    expect(readRecoverySnapshots(localStorage, browserIdentity)).toEqual(entries)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('shows and restores only the current document history when changing manuscript and project', async () => {
    desktopHost.available = true
    const rootA = '/research/recovery-project-a', rootB = '/research/recovery-project-b'
    const sources: Record<string, Record<string, string>> = {
      [rootA]: { 'paper.md': paper('Current paper A'), 'concept.md': paper('Current concept A'), 'README.md': paper('Current README A') },
      [rootB]: { 'paper.md': paper('Current paper B') },
    }
    const projects = new Map(Object.entries(sources).map(([projectRoot, files]) => [projectRoot, {
      root: projectRoot,
      config: { schemaVersion: 1, name: projectRoot, mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
      documents: Object.entries(files).map(([path, source]) => ({ path, kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: path })),
      bibliographies: [],
    } as ProjectSnapshot]))
    const oldVersions = [
      { root: rootA, path: 'README.md', title: 'Older README A' },
      { root: rootA, path: 'concept.md', title: 'Older concept A' },
      { root: rootA, path: 'paper.md', title: 'Older paper A' },
      { root: rootB, path: 'paper.md', title: 'Older paper B' },
    ]
    for (const version of oldVersions) {
      const source = paper(version.title)
      saveRecoverySnapshot(localStorage, parsePortableDocument(source, initialDraft).draft, version.path, source, '2026-07-14T10:00:00.000Z', undefined, { documentIdentity: { kind: 'desktop', projectRoot: version.root, documentPath: version.path } })
      saveRecoverySnapshot(localStorage, parsePortableDocument(paper(`Unassigned ${version.title}`), initialDraft).draft, version.path, paper(`Unassigned ${version.title}`))
    }
    const legacyBefore = localStorage.getItem('draftmatter.recovery.v1')
    vi.spyOn(desktopHost, 'openProject').mockImplementation(async (projectRoot) => projects.get(projectRoot)!)
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async (projectRoot, path) => ({ path, content: sources[projectRoot][path], hash: path, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'listProjectFiles').mockImplementation(async (projectRoot) => ({ files: projects.get(projectRoot)!.documents.map(({ path, bytes, modifiedMs }) => ({ path, bytes, modifiedMs })), truncated: false }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'documentStatus').mockImplementation(async (_projectRoot, path) => ({ kind: 'current', hash: path, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async ({ root: projectRoot, path, content }) => {
      sources[projectRoot][path] = content
      return { path, hash: path, bytes: content.length, recoveryPath: null }
    })
    vi.spyOn(desktopHost, 'setMainDocument').mockImplementation(async (projectRoot, path) => {
      const project = projects.get(projectRoot)!
      const next = { ...project, config: { ...project.config, mainDocument: path } }
      projects.set(projectRoot, next)
      return next
    })
    async function waitFor(check: () => void) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { check(); return } catch { await act(async () => new Promise((resolve) => setTimeout(resolve, 10))) }
      }
      check()
    }
    async function openHistory(expected: string, excluded: string[]) {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
      await waitFor(() => expect(container.querySelector('.recovery-list')?.textContent).toContain(expected))
      for (const label of ['Unassigned', ...excluded]) expect(container.querySelector('.recovery-list')?.textContent).not.toContain(label)
    }
    async function restore(title: string, projectRoot: string, path: string) {
      const button = [...container.querySelectorAll<HTMLButtonElement>('.recovery-list > button')].find((entry) => entry.textContent?.includes(title))!
      const before = sources[projectRoot][path]
      await act(async () => button.click())
      expect(sources[projectRoot][path]).toBe(before)
      await act(async () => container.querySelector<HTMLButtonElement>('.recovery-restore-version')!.click())
      expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain(`Keep ${title} exactly.`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)) })
      expect(sources[projectRoot][path]).toBe(paper(title))
    }
    await act(async () => root.render(<App key={rootA} desktopProjectLaunch={projects.get(rootA)!} selectedManuscriptPath="paper.md" />))
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('paper.md'))
    await openHistory('Older paper A', ['Older concept A', 'Older README A', 'Older paper B'])
    await restore('Older paper A', rootA, 'paper.md')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Switch manuscript…')!.click())
    await waitFor(() => expect(container.querySelector('[aria-label="Choose main manuscript"]')).not.toBeNull())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.manuscript-choice-list button')].find((button) => button.querySelector('strong')?.textContent === 'concept.md')!.click())
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('concept.md'))
    await openHistory('Older concept A', ['Older paper A', 'Older README A', 'Older paper B'])
    await restore('Older concept A', rootA, 'concept.md')
    expect(sources[rootA]['README.md']).toBe(paper('Current README A'))
    expect(sources[rootA]['paper.md']).toBe(paper('Older paper A'))
    expect(sources[rootB]['paper.md']).toBe(paper('Current paper B'))
    await act(async () => root.render(<App key={rootB} desktopProjectLaunch={projects.get(rootB)!} />))
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('paper.md'))
    await openHistory('Older paper B', ['Older paper A', 'Older concept A', 'Older README A'])
    await restore('Older paper B', rootB, 'paper.md')
    expect(sources[rootA]['paper.md']).toBe(paper('Older paper A'))
    expect(sources[rootA]['concept.md']).toBe(paper('Older concept A'))
    expect(localStorage.getItem('draftmatter.recovery.v1')).toBe(legacyBefore)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })
})
