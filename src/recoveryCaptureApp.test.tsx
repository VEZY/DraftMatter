// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { readRecoverySnapshots, recoveryDocumentStorageKey, type RecoveryDocumentIdentity } from './storage'

interface CaptureOptions {
  documentKey?: string
  source: string
  paused?: boolean
  onSnapshot: (source: string, documentKey: string) => boolean
}
const captureHook = vi.hoisted(() => ({ latest: undefined as CaptureOptions | undefined }))
vi.mock('./useRecoveryAutosave', () => ({
  useRecoveryAutosave: (options: CaptureOptions) => { captureHook.latest = options },
}))

const paper = (name: string) => `---\ntitle: "Capture ${name}"\n---\n\n# Results\n\nKeep the source of paper ${name} unchanged.\n`
const sources = { '/research/capture-a': paper('A'), '/research/capture-b': paper('B') }
const identity = (projectRoot: string): RecoveryDocumentIdentity => ({ kind: 'desktop', projectRoot, documentPath: 'paper.md' })
const project = (root: keyof typeof sources): ProjectSnapshot => ({
  root,
  config: { schemaVersion: 1, name: `Capture ${root.at(-1)}`, mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.md', kind: 'manuscript', bytes: sources[root].length, modifiedMs: 1, hash: `hash:${root}` }],
  bibliographies: [],
})

describe('App recovery capture guards before timer cleanup', () => {
  let root: Root
  let container: HTMLDivElement
  let previousAvailability: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    captureHook.latest = undefined
    previousAvailability = desktopHost.available
    desktopHost.available = true
    vi.spyOn(desktopHost, 'openProject').mockImplementation(async (path) => project(path as keyof typeof sources))
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async (path) => ({ path: 'paper.md', content: sources[path as keyof typeof sources], hash: `hash:${path}`, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'current-paper', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'listDocumentRecoveries').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listSavedDocumentVersions').mockResolvedValue([])
    vi.spyOn(desktopHost, 'createDocumentRecovery').mockRejectedValue(new Error('No native recovery write is expected for an unchanged, already-saved manuscript'))
    vi.spyOn(desktopHost, 'executeKernel').mockRejectedValue(new Error('Recovery cannot execute manuscript code'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
  })

  async function waitFor(check: () => void) {
    for (let index = 0; index < 100; index++) {
      try { check(); return } catch { await act(async () => new Promise((resolve) => setTimeout(resolve, 10))) }
    }
    check()
  }

  async function open(path: keyof typeof sources) {
    await act(async () => root.render(<App desktopProjectLaunch={project(path)} />))
    await waitFor(() => {
      expect(captureHook.latest?.documentKey).toBe(recoveryDocumentStorageKey(identity(path)))
      expect(captureHook.latest?.source).toBe(sources[path])
    })
    // Let the ordinary working-copy autosave settle before recording writes.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 420)))
    return captureHook.latest!
  }

  it('rejects a foreign document key and an obsolete source without journal or native writes', async () => {
    const capture = await open('/research/capture-a')
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    let foreign: boolean | undefined, obsolete: boolean | undefined
    await act(async () => {
      foreign = capture.onSnapshot(capture.source, recoveryDocumentStorageKey(identity('/research/capture-b')))
      obsolete = capture.onSnapshot(`${capture.source}\nAn obsolete editor buffer.`, capture.documentKey!)
    })
    expect(foreign).toBe(false)
    expect(obsolete).toBe(false)
    expect(writes).not.toHaveBeenCalled()
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('refuses capture from the updated callback while history is open', async () => {
    const capture = await open('/research/capture-a')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    await waitFor(() => expect(captureHook.latest?.paused).toBe(true))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    let accepted: boolean | undefined
    await act(async () => { accepted = captureHook.latest!.onSnapshot(capture.source, capture.documentKey!) })
    expect(accepted).toBe(false)
    expect(writes).not.toHaveBeenCalled()
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
  })

  it('accepts a valid current-document capture into its own journal', async () => {
    const capture = await open('/research/capture-a')
    const key = recoveryDocumentStorageKey(identity('/research/capture-a'))
    localStorage.removeItem(key)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    let accepted: boolean | undefined
    await act(async () => { accepted = capture.onSnapshot(capture.source, capture.documentKey!) })
    expect(accepted).toBe(true)
    expect(writes).toHaveBeenCalledWith(key, expect.any(String))
    expect(readRecoverySnapshots(localStorage, identity('/research/capture-a')).map((version) => version.source)).toEqual([capture.source])
    expect(readRecoverySnapshots(localStorage, identity('/research/capture-b'))).toEqual([])
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
  })

  it('rejects the old timer callback after a real project switch, before relying on hook cleanup', async () => {
    const stale = await open('/research/capture-a')
    const current = await open('/research/capture-b')
    const beforeA = localStorage.getItem(stale.documentKey!)
    const beforeB = localStorage.getItem(current.documentKey!)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    let accepted: boolean | undefined
    await act(async () => { accepted = stale.onSnapshot(stale.source, stale.documentKey!) })
    expect(accepted).toBe(false)
    expect(writes).not.toHaveBeenCalled()
    expect(localStorage.getItem(stale.documentKey!)).toBe(beforeA)
    expect(localStorage.getItem(current.documentKey!)).toBe(beforeB)
    expect(desktopHost.createDocumentRecovery).not.toHaveBeenCalled()
    expect(captureHook.latest!.source).toBe(sources['/research/capture-b'])
  })
})
