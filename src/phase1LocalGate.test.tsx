// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { readRecoverySnapshots } from './storage'

const projectParent = '/research'
const projectRoot = '/research/Portable research article'
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
    vi.spyOn(desktopHost, 'gitStatus').mockResolvedValue({
      gitAvailable: true,
      gitVersion: 'git version 2.50.0',
      repository: true,
      repositoryRoot: projectRoot,
      projectPrefix: '',
      branch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      entries: [],
    })
    vi.spyOn(desktopHost, 'gitBranches').mockResolvedValue({ current: 'main', detached: false, branches: [{ name: 'main', current: true }], remotes: [] })
    vi.spyOn(desktopHost, 'gitHistory').mockResolvedValue([{ hash: '1234567890abcdef1234567890abcdef12345678', shortHash: '12345678', authoredAt: '2026-07-16T10:00:00+02:00', author: 'Ada', message: 'Earlier draft' }])
    vi.spyOn(desktopHost, 'gitCheckpointDiff').mockResolvedValue({ hash: '1234567890abcdef1234567890abcdef12345678', text: '@@ -1 +1 @@\n-current\n+earlier\n', truncated: false, files: ['paper.qmd'] })
    vi.spyOn(desktopHost, 'gitRestoreCheckpoint').mockImplementation(async () => {
      persistedSource = externalSource
      persistedHash = 'checkpoint-restored'
      return {
        gitAvailable: true,
        gitVersion: 'git version 2.50.0',
        repository: true,
        repositoryRoot: projectRoot,
        projectPrefix: '',
        branch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        entries: [{ path: 'paper.qmd', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, conflicted: false, binary: false }],
      }
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
    expect(readRecoverySnapshots(localStorage)[0].source).toBe(editedSource)
    expect(container.textContent).toContain('The external copy changed.')
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
    expect(readRecoverySnapshots(localStorage).some((snapshot) => snapshot.source === editedSource)).toBe(true)
    expect(persistedSource).toBe(originalSource)

    await act(async () => buttonWithText(alert, 'Reload disk version').click())
    await flush(50)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('First observation.')
    expect(readRecoverySnapshots(localStorage).some((snapshot) => snapshot.source === editedSource)).toBe(true)
  })

  it('flushes the open manuscript and reloads an explicitly restored Git checkpoint', async () => {
    localStorage.setItem('draftmatter.last-project-root.v1', projectRoot)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => appRoot.render(<App />))
    await flush(50)

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    await flush()
    const history = container.querySelector<HTMLElement>('.git-history-browser')!
    await act(async () => buttonWithText(history, 'Rendered').click())
    await flush()
    await act(async () => buttonWithText(container, 'Restore clean files').click())
    await flush(50)

    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({
      root: projectRoot,
      path: 'paper.qmd',
      content: originalSource,
      expectedHash: 'document-1',
    }))
    expect(desktopHost.gitRestoreCheckpoint).toHaveBeenCalledWith({
      root: projectRoot,
      hash: '1234567890abcdef1234567890abcdef12345678',
      paths: ['paper.qmd'],
    })
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Changed safely in another editor.')
    expect(container.querySelector('.toast')?.textContent).toContain('Restored 1 file from 12345678')
  })
})
