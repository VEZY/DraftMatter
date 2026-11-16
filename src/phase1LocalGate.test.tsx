// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { DraftMatterApplication } from './DraftMatterApplication'
import { desktopHost, type DocumentRecoverySnapshot, type ProjectSnapshot } from './desktopHost'
import { readLocalProjectRecents } from './localProjectCatalogue'
import { readRecoverySnapshots } from './storage'

const projectParent = '/research'
const projectRoot = '/research/Portable research article'
const recoveryIdentity = { kind: 'desktop' as const, projectRoot, documentPath: 'paper.qmd' }
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
  let archivedVersions: DocumentRecoverySnapshot[]

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    persistedSource = originalSource
    persistedHash = 'document-1'
    archivedVersions = []
    previousAvailability = desktopHost.available
    desktopHost.available = true

    vi.spyOn(desktopHost, 'pickProjectFolder').mockResolvedValue(projectParent)
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
    vi.spyOn(desktopHost, 'listDocumentRecoveries').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listSavedDocumentVersions').mockImplementation(async () => archivedVersions.map(({ source: _source, ...entry }) => ({ ...entry, kind: entry.kind as 'manual', title: 'Phase 1 article', sourceHash: entry.sourceHash!, bytes: entry.bytes! })))
    vi.spyOn(desktopHost, 'readSavedDocumentVersion').mockImplementation(async (_root, _path, id) => archivedVersions.find((entry) => entry.id === id)!)
    vi.spyOn(desktopHost, 'createDocumentRecovery').mockImplementation(async (_root, path, source, _preserve, options) => {
      const entry = { id: `archive-${archivedVersions.length + 1}`, documentPath: path, source, savedAtMillis: Date.now(), ...options, sourceHash: `saved:${source.length}`, bytes: source.length }
      archivedVersions.push(entry)
      return entry
    })
    vi.spyOn(desktopHost, 'agentIntegrationStatus').mockResolvedValue({
      schemaVersion: 2,
      protocolVersion: '1.0',
      projectEnabled: true,
      instructionsReady: true,
      portableSkillReady: true,
      portableSkillFallback: true,
      manifestReady: true,
      installedSkillVersion: 1,
      localAdapters: [],
      repairCommand: 'draftmatter ai update --project-root . --apply',
      doctorCommand: 'draftmatter ai doctor --json --project-root .',
      notes: [],
    })
    vi.spyOn(desktopHost, 'executionTrustStatus').mockResolvedValue({
      trusted: false,
      scope: 'session',
      warning: 'Review this project before running code.',
    })
    vi.spyOn(desktopHost, 'assistantConnectionsStatus').mockResolvedValue({
      ok: true,
      scope: 'device',
      clients: [{
        client: 'codex',
        name: 'Codex',
        detected: true,
        executable: '/usr/local/bin/codex',
        connected: true,
        mcpInstalled: true,
        mcpCurrent: true,
        skillInstalled: true,
        skillCurrent: true,
        registrationScope: 'user',
        registrationMethod: 'global-config',
        projectLocalRequired: false,
        recommendedAction: 'none',
        configPath: '/users/test/.codex/config.toml',
        skillPath: '/users/test/.codex/skills/draftmatter-authoring',
        notes: [],
      }],
    })
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
    for (const method of ['gitStatus', 'gitInitialize', 'gitBranches', 'gitHistory', 'gitCheckpointDiff', 'gitRestoreCheckpoint'] as const) {
      vi.spyOn(desktopHost, method).mockRejectedValue(new Error('Git is managed outside DraftMatter'))
    }

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

  async function editSource(updatedSource: string) {
    if (!container.querySelector('.source-drawer')) await act(async () => buttonWithText(container, 'View source').click())
    await act(async () => buttonWithText(container, 'Edit source').click())
    const sourceEditor = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      textareaSetter?.call(sourceEditor, updatedSource)
      sourceEditor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonWithText(container, 'Apply source').click())
  }

  it('waits for the final desktop revision before navigating Home, even if another edit arrives during the write', async () => {
    const leave = vi.fn()
    let finishFirstWrite!: () => void
    const delayed = new Promise<void>((resolve) => { finishFirstWrite = resolve })
    vi.mocked(desktopHost.saveDocument).mockImplementationOnce(async (request) => {
      await delayed
      persistedSource = request.content
      persistedHash = 'intermediate'
      return { path: request.path, hash: persistedHash, bytes: persistedSource.length, recoveryPath: null }
    })
    await act(async () => appRoot.render(<App desktopProjectLaunch={project} onNavigateHome={leave} />))
    await flush()
    await editSource(editedSource)
    await act(async () => container.querySelector<HTMLElement>('[aria-label="DraftMatter home"]')!.click())
    expect(leave).not.toHaveBeenCalled()
    const finalSource = editedSource + '\nOne last observation.\n'
    await editSource(finalSource)
    await act(async () => { finishFirstWrite() })
    expect(persistedSource).toBe(finalSource)
    expect(desktopHost.saveDocument).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHash: 'intermediate' }))
    expect(leave).toHaveBeenCalledOnce()
  })

  it('keeps the editor and recoverable text when saving before Home fails', async () => {
    const leave = vi.fn()
    vi.mocked(desktopHost.saveDocument).mockRejectedValueOnce({ kind: 'conflict', message: 'The external copy changed.' })
    await act(async () => appRoot.render(<App desktopProjectLaunch={project} onNavigateHome={leave} />))
    await flush()
    await editSource(editedSource)
    await act(async () => container.querySelector<HTMLElement>('[aria-label="DraftMatter home"]')!.click())
    expect(leave).not.toHaveBeenCalled()
    expect(persistedSource).toBe(originalSource)
    expect(readRecoverySnapshots(localStorage, recoveryIdentity)[0].source).toBe(editedSource)
    expect(container.textContent).toContain('The external copy changed.')
  })

  it('opens the picked file from Home, supersedes the previous main document and reopens it from recents', async () => {
    window.history.replaceState({}, '', '/')
    const path = 'MAD_paper.md'
    const root = '/research/28-MAD'
    let snapshot: ProjectSnapshot = {
      ...project, root,
      config: { ...project.config, name: 'MAD', mainDocument: 'MAD_conceptual_framework.md' },
      documents: ['MAD_conceptual_framework.md', path].map((name) => ({ ...project.documents[0], path: name })),
    }
    const pick = vi.spyOn(desktopHost, 'pickManuscript').mockResolvedValueOnce(null).mockResolvedValue({ root, path })
    vi.mocked(desktopHost.openProject).mockImplementation(async () => snapshot)
    const remember = vi.spyOn(desktopHost, 'setMainDocument').mockImplementation(async (_root, mainDocument) => {
      snapshot = { ...snapshot, config: { ...snapshot.config, mainDocument } }
      return snapshot
    })
    const run = vi.spyOn(desktopHost, 'executeKernel')
    await act(async () => appRoot.render(<DraftMatterApplication />))
    const openPaper = () => act(async () => buttonWithText(container, 'Open existing paper').click())
    const waitForPaper = async () => {
      for (let i = 0; i < 100 && !container.querySelector('.active-manuscript'); i++) await flush(10)
      expect(container.querySelector('.active-manuscript strong')?.textContent).toBe(path)
      expect(container.querySelector('.manuscript-picker-dialog')).toBeNull()
    }

    await openPaper()
    expect(desktopHost.openProject).not.toHaveBeenCalled()
    await openPaper()
    await waitForPaper()
    expect(desktopHost.openProject).toHaveBeenCalledWith(root)
    expect(desktopHost.pickProjectFolder).not.toHaveBeenCalled()
    expect(desktopHost.readDocument).toHaveBeenCalledExactlyOnceWith(root, path)
    expect(remember).toHaveBeenCalledExactlyOnceWith(root, path)
    await act(async () => container.querySelector<HTMLElement>('[aria-label="DraftMatter home"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.home-local-open')!.click())
    await waitForPaper()
    expect(desktopHost.readDocument).toHaveBeenLastCalledWith(root, path)
    expect(pick).toHaveBeenCalledTimes(2)
    expect(remember).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    window.history.replaceState({}, '', '/')
  })

  it('chooses, switches and reopens a manuscript without editing its source or running its code', async () => {
    const papers = ['MAD_conceptual_framework.md', 'MAD_paper.md']
    let snapshot: ProjectSnapshot = {
      ...project,
      config: { ...project.config, name: 'MAD', mainDocument: '' },
      documents: papers.map((path) => ({ ...project.documents[0], path })),
    }
    const sources = ['# Framework\n', '# Main paper\n\n```python {#calculation .execute}\nprint(42)\n```\n']
    vi.mocked(desktopHost.openProject).mockImplementation(async () => snapshot)
    vi.mocked(desktopHost.readDocument).mockImplementation(async (_root, path) => ({
      path, content: sources[papers.indexOf(path)], hash: path, modifiedMs: 1,
    }))
    const choose = vi.spyOn(desktopHost, 'setMainDocument').mockImplementation(async (_root, mainDocument) => {
      snapshot = { ...snapshot, config: { ...snapshot.config, mainDocument } }
      return snapshot
    })
    const run = vi.spyOn(desktopHost, 'executeKernel')
    const probe = vi.spyOn(desktopHost, 'probeRuntime')
    const open = async () => {
      await act(async () => appRoot.render(<App desktopProjectLaunch={snapshot} />))
      await flush()
    }
    const click = async (label: string) => {
      await act(async () => buttonWithText(container, label).click())
      await vi.waitFor(() => expect(container.querySelector('.manuscript-picker-dialog [role="status"]')).toBeNull())
    }
    const expectPaper = (path: string, heading: string) => {
      expect(container.querySelector('.project-switcher-name small')?.textContent).toBe(path)
      expect(container.querySelector('.structured-manuscript-editor h1')?.textContent).toBe(heading)
      expect(container.querySelector('.outline-tree button span')?.textContent).toBe(heading)
      expect(readLocalProjectRecents(localStorage)[0].mainDocument).toBe(path)
    }

    await open()
    expect(container.querySelector('.manuscript-picker-dialog')).not.toBeNull()
    expect(container.querySelector('.app-shell')).toBeNull()
    expect(desktopHost.readDocument).not.toHaveBeenCalled()
    await click(papers[1])
    expectPaper(papers[1], 'Main paper')

    await click('Switch manuscript')
    choose.mockRejectedValueOnce(new Error('Could not save project configuration'))
    await click(papers[0])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save project configuration')
    expectPaper(papers[1], 'Main paper')
    await click(papers[0])
    expectPaper(papers[0], 'Framework')

    await act(async () => appRoot.unmount())
    appRoot = createRoot(container)
    await open()
    expect(container.querySelector('.manuscript-picker-dialog')).toBeNull()
    expectPaper(papers[0], 'Framework')
    await flush(400)
    expect(run).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()

    await editSource('# Edited framework\n')
    await click('Switch manuscript')
    vi.mocked(desktopHost.saveDocument).mockRejectedValueOnce({ kind: 'conflict', message: 'External edit' })
    await click(papers[1])
    expectPaper(papers[0], 'Edited framework')
    expect(choose).toHaveBeenCalledTimes(3)
    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ path: papers[0], content: '# Edited framework\n' }))
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
    await act(async () => createDialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => createDialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush(30)

    expect(desktopHost.pickProjectFolder).toHaveBeenCalledWith('Choose where to create the new project')
    expect(desktopHost.createProject).toHaveBeenCalledWith(projectParent, 'Portable research article', {
      name: 'Remi Vezy',
      affiliations: [],
    }, true)
    expect(container.querySelector('.structured-manuscript-editor h1')?.textContent).toBe('Phase 1 article')
    expect(localStorage.getItem('draftmatter.last-project-root.v1')).toBe(projectRoot)

    await editSource(editedSource)
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
    expect(readRecoverySnapshots(localStorage, recoveryIdentity).some((snapshot) => snapshot.source === originalSource)).toBe(true)
    const manualVersion = archivedVersions.find((version) => version.kind === 'manual' && version.source === editedSource)!
    expect(manualVersion).toBeDefined()

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
    expect(recoveryDialog.querySelector(`[data-history-select="saved:${manualVersion.id}"]`)).not.toBeNull()
    const originalVersion = readRecoverySnapshots(localStorage, recoveryIdentity).find((version) => version.source === originalSource)!
    expect(recoveryDialog.querySelector(`[data-history-select="${originalVersion.id}"]`)).not.toBeNull()
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

  it('shows separate assistant, project, trust, and network states without contacting a model', async () => {
    localStorage.setItem('draftmatter.last-project-root.v1', projectRoot)
    await act(async () => appRoot.render(<App />))
    await flush(50)

    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    await act(async () => buttonWithText(container, 'AI for this project').click())
    await flush()

    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="agent-integration-title"]')!
    expect(dialog.textContent).toContain('Assistant app')
    expect(dialog.textContent).toContain('Codex')
    expect(dialog.textContent).toContain('This project')
    expect(dialog.textContent).toContain('Assistant access allowed')
    expect(dialog.textContent).toContain('Run project code')
    expect(dialog.textContent).toContain('Ask first')
    expect(dialog.textContent).toContain('Search online sources')
    expect(dialog.textContent).not.toContain('Ready')
    expect(dialog.textContent).toContain('Connection details')
    expect(dialog.textContent).toContain('draftmatter ai doctor --json --project-root .')
    expect(desktopHost.agentIntegrationStatus).toHaveBeenCalledWith(projectRoot)
    expect(desktopHost.executionTrustStatus).toHaveBeenCalledWith(projectRoot)
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
    expect(readRecoverySnapshots(localStorage, recoveryIdentity).some((snapshot) => snapshot.source === editedSource)).toBe(true)
    expect(persistedSource).toBe(originalSource)

    await act(async () => buttonWithText(alert, 'Reload disk version').click())
    await flush(50)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('First observation.')
    expect(readRecoverySnapshots(localStorage, recoveryIdentity).some((snapshot) => snapshot.source === editedSource)).toBe(true)
  })

  it('opens local recovery from the History launcher and restores a saved version without managing Git', async () => {
    localStorage.setItem('draftmatter.last-project-root.v1', projectRoot)
    await act(async () => appRoot.render(<App />))
    await flush(50)
    await editSource(editedSource)
    await flush(1_000)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close source inspector"]')!.click())
    const writesBeforeHistory = vi.mocked(desktopHost.saveDocument).mock.calls.length

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    await flush()
    const history = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Recovery history"]')!
    expect(history).not.toBeNull()
    expect(history.textContent).toContain('Browsing leaves your manuscript unchanged.')
    expect(container.querySelector('.git-history-browser')).toBeNull()
    expect(container.textContent).not.toContain('Restore clean files')
    expect(desktopHost.saveDocument).toHaveBeenCalledTimes(writesBeforeHistory)
    expect(persistedSource).toBe(editedSource)

    const original = readRecoverySnapshots(localStorage, recoveryIdentity).find((snapshot) => snapshot.source === originalSource)!
    const restore = history.querySelector<HTMLButtonElement>(`[data-history-select="${original.id}"]`)!
    await act(async () => restore.click())
    expect(persistedSource).toBe(editedSource)
    expect(desktopHost.saveDocument).toHaveBeenCalledTimes(writesBeforeHistory)
    await act(async () => container.querySelector<HTMLButtonElement>('.recovery-restore-version')!.click())
    await flush(1_000)

    expect(persistedSource).toBe(originalSource)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('First observation.')
    expect(archivedVersions.some((snapshot) => snapshot.source === editedSource && snapshot.kind === 'before-restore')).toBe(true)
    expect(archivedVersions.some((snapshot) => snapshot.source === originalSource && snapshot.kind === 'restored')).toBe(true)
    for (const method of ['gitStatus', 'gitInitialize', 'gitBranches', 'gitHistory', 'gitCheckpointDiff', 'gitRestoreCheckpoint'] as const) {
      expect(desktopHost[method]).not.toHaveBeenCalled()
    }
  })
})
