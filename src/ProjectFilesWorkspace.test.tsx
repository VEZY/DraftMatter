// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFilesWorkspace, projectFilesManuscriptUsage } from './ProjectFilesWorkspace'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { CollaborationServiceClient } from './collaboration/serviceClient'
import { sharedImage } from './sharedEditor/projectResources'

vi.mock('./ProjectFilesPanel', () => ({ ProjectFilesPanel: ({ projectId }: { projectId: string }) => <div data-testid="data-files">Shared data versions for {projectId}</div> }))

const project: ProjectSnapshot = {
  root: '/research/article',
  config: { schemaVersion: 1, name: 'Article', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: 100, modifiedMs: 1, hash: 'paper-hash' }],
  bibliographies: [],
}

let container: HTMLDivElement
let root: Root
let originalAvailability: boolean

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  originalAvailability = desktopHost.available
  desktopHost.available = true
  vi.spyOn(desktopHost, 'listProjectFiles').mockResolvedValue({ files: [{ path: 'paper.qmd', bytes: 100, modifiedMs: 1 }, { path: 'figures/used.png', bytes: 4, modifiedMs: 1 }, { path: 'figures/unused.png', bytes: 5, modifiedMs: 1 }, { path: 'data/input.csv', bytes: 3, modifiedMs: 1 }], truncated: false })
  vi.spyOn(desktopHost, 'gitStatus').mockRejectedValue(new Error('Git is not installed'))
  vi.spyOn(desktopHost, 'gitInitialize').mockRejectedValue(new Error('Git is not installed'))
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  desktopHost.available = originalAvailability
  vi.restoreAllMocks()
})

function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}

describe('connected project files workspace', () => {
  it('lists local files and current figure numbers without requiring or probing Git', async () => {
    const insert = vi.fn()
    await act(async () => root.render(<ProjectFilesWorkspace project={project} currentManuscriptPath="paper.qmd" source="![A response](figures/used.png){#fig-response}" location="local" onClose={vi.fn()} onInsertFigure={insert} />))
    expect(desktopHost.listProjectFiles).toHaveBeenCalledWith('/research/article')
    expect(container.textContent).toContain('figures/unused.png')
    expect(container.textContent).toContain('data/input.csv')
    expect(container.textContent).toContain('Figure 1 · Image')
    expect(desktopHost.gitStatus).not.toHaveBeenCalled()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    expect(container.querySelector('.project-file-git')).toBeNull()
    await act(async () => button('Insert figures/unused.png as a figure').click())
    expect(insert).toHaveBeenCalledWith('figures/unused.png')
  })

  it('shows shared figure copies and connects the existing data-file panel', async () => {
    desktopHost.available = false
    const client = new CollaborationServiceClient('https://collaboration.example.test', async () => 'token')
    const image = sharedImage('figures/shared.svg', new TextEncoder().encode('<svg/>'))
    await act(async () => root.render(<ProjectFilesWorkspace project={null} currentManuscriptPath="paper.qmd" source="![Shared](figures/shared.svg)" location="online" sharedImages={[image]} collaborationFileContext={{ client, workspace: { id: 'workspace-1', name: 'Team', role: 'editor', createdAt: '2026-11-13T10:00:00Z' }, projectId: 'project-1', currentUserId: 'alice' }} onClose={vi.fn()} />))
    expect(container.textContent).toContain('figures/shared.svg')
    expect(container.textContent).toContain('inserted figures, and references are shared')
    expect(container.textContent).toContain('Shared data versions for project-1')
    expect(desktopHost.listProjectFiles).not.toHaveBeenCalled()
  })

  it('downloads the actual local image when an older online copy also exists', async () => {
    const localBytes = [137, 80, 78, 71]
    vi.spyOn(desktopHost, 'readProjectAssets').mockResolvedValue([{ path: 'figures/used.png', bytes: localBytes, mediaType: 'image/png' }])
    vi.spyOn(desktopHost, 'saveExportFile').mockResolvedValue({ path: '/saved/used.png', bytes: localBytes.length })
    const image = sharedImage('figures/used.png', new Uint8Array([1, 2]))
    await act(async () => root.render(<ProjectFilesWorkspace project={project} currentManuscriptPath="paper.qmd" source="![A response](figures/used.png)" sharedImages={[image]} location="local" onClose={vi.fn()} />))
    await act(async () => button('Download figures/used.png').click())
    expect(desktopHost.readProjectAssets).toHaveBeenCalledWith(project.root, ['figures/used.png'])
    expect(desktopHost.saveExportFile).toHaveBeenCalledWith({ suggestedName: 'used.png', bytes: localBytes })
    expect(container.textContent).toContain('Saved used.png.')
  })

  it('retains known manuscript entries and explains an unavailable full inventory', async () => {
    vi.mocked(desktopHost.listProjectFiles).mockRejectedValue({ message: 'The project folder is unavailable.' })
    await act(async () => root.render(<ProjectFilesWorkspace project={project} currentManuscriptPath="paper.qmd" source="# Paper" location="local" onClose={vi.fn()} />))
    expect(container.textContent).toContain('paper.qmd')
    expect(container.textContent).toContain('The project folder is unavailable.')
    expect(container.textContent).toContain('Other files in this folder may not be listed.')
  })

  it('keeps file names while recomputing figure numbers after reorder', () => {
    const first = '![First](figures/a.svg){#fig-first}\n\n![Second](figures/b.svg){#fig-second}\n'
    const reordered = '![Second](figures/b.svg){#fig-second}\n\n![First](figures/a.svg){#fig-first}\n'
    expect(projectFilesManuscriptUsage(first, 'paper.qmd').figureLabels).toEqual({ 'figures/a.svg': ['Figure 1'], 'figures/b.svg': ['Figure 2'] })
    expect(projectFilesManuscriptUsage(reordered, 'paper.qmd').figureLabels).toEqual({ 'figures/b.svg': ['Figure 1'], 'figures/a.svg': ['Figure 2'] })
  })

  it('counts generated results with ordinary figures and respects unnumbered images', () => {
    const source = '![Logo](figures/logo.svg){.unnumbered}\n\n![First](figures/a.svg){#fig-first}\n\n<!-- dm-output:start cell="result" run="sha256:test" -->\n![Generated](figures/result.svg){#fig-generated}\n<!-- dm-output:end -->\n'
    expect(projectFilesManuscriptUsage(source, 'paper.qmd').figureLabels).toEqual({ 'figures/logo.svg': ['Unnumbered figure'], 'figures/a.svg': ['Figure 1'], 'figures/result.svg': ['Figure 2'] })
  })
})
