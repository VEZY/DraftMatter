// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

const rootPath = '/research/canopy-execution'
const source = reviewedProjection(initialDraft)
const project: ProjectSnapshot = {
  root: rootPath,
  config: { schemaVersion: 1, name: 'Canopy execution', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'document-old' }],
  bibliographies: [],
}

describe('rendered local execution workflow', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    previousAvailability = desktopHost.available
    desktopHost.available = true
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'setExecutionPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'probeRuntime').mockImplementation(async (language) => language === 'python'
      ? { language, health: 'available', executable: '/usr/bin/python3', version: 'Python 3.12.4' }
      : { language, health: 'missing', message: `${language} is not installed.` })
    vi.spyOn(desktopHost, 'discoverJupyterKernels').mockResolvedValue({
      health: 'available', searchedLocations: ['/kernels'],
      kernels: [{ name: 'python-fixture', displayName: 'Python · DraftMatter', language: 'python', health: 'available', resourceDir: '/kernels/python-fixture' }],
    })
    vi.spyOn(desktopHost, 'executionTrustStatus')
      .mockResolvedValueOnce({ trusted: false, scope: 'session', warning: 'Project code has the user permissions. Local execution is not a sandbox.' })
      .mockResolvedValue({ trusted: true, scope: 'session', warning: 'Project code has the user permissions. Local execution is not a sandbox.' })
    vi.spyOn(desktopHost, 'trustProjectForSession').mockResolvedValue({ trusted: true, scope: 'session', warning: 'trusted' })
    vi.spyOn(desktopHost, 'inspectExecutionArtifacts').mockResolvedValue([{ path: 'figures/generated/fig-canopy.svg', hash: `sha256:${'a'.repeat(64)}` }])
    vi.spyOn(desktopHost, 'executeKernel').mockResolvedValue({
      status: 'ok',
      messages: [{ kind: 'stream', sequence: 0, name: 'stdout', text: 'Wrote figures/generated/fig-canopy.svg\n' }],
      artifacts: [{ path: 'figures/generated/fig-canopy.svg', bytes: 620, hash: `sha256:${'a'.repeat(64)}`, mediaType: 'image/svg+xml' }],
      environment: { identity: 'python-fixture', version: 'Python 3.12.4' },
      kernelRunId: 'kernel-rendered-1', sessionGeneration: 1, executionSequence: 1,
    })
    vi.spyOn(desktopHost, 'saveExecutionManifest').mockImplementation(async (request) => ({
      path: `.draftmatter/execution/${request.cellId}.json`, content: request.content, hash: 'manifest-new', modifiedMs: 2,
    }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => ({
      path: request.path, hash: 'document-new', bytes: request.content.length, recoveryPath: null,
    }))

    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => {
      appRoot.render(<App />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('prepares detected code after one project-trust prompt, then executes and materializes the result', async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    const trustDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="execution-trust-title"]')!
    expect(trustDialog.textContent).toContain('Local execution is not a sandbox')
    expect(trustDialog.textContent).toContain('Trust and prepare this project')

    await act(async () => {
      [...trustDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Trust project and continue'))!.click()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 80))
    })

    expect(desktopHost.trustProjectForSession).toHaveBeenCalledWith(rootPath, 'run-project-code-with-user-permissions')
    expect(JSON.parse(localStorage.getItem('draftmatter.trusted-project-roots.v1') ?? '[]')).toContain(rootPath)
    expect(desktopHost.probeRuntime).toHaveBeenCalledTimes(3)
    expect(desktopHost.setExecutionPreferences).toHaveBeenCalled()

    const run = container.querySelector<HTMLButtonElement>('[aria-label="Run Reproducible figure (python)"]')!
    await act(async () => run.click())
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 80))
    })

    expect(desktopHost.executeKernel).toHaveBeenCalledWith(expect.objectContaining({
      root: rootPath,
      cellId: 'fig-canopy',
      language: 'python',
      attributes: expect.objectContaining({ produces: 'figures/generated/fig-canopy.svg' }),
      inputs: [],
    }))
    expect(desktopHost.saveExecutionManifest).toHaveBeenCalledWith(expect.objectContaining({
      root: rootPath,
      cellId: 'fig-canopy',
      content: expect.stringContaining('kernel-rendered-1'),
      expectedHash: null,
    }))
    expect(desktopHost.inspectExecutionArtifacts).toHaveBeenCalledWith(rootPath, ['figures/generated/fig-canopy.svg'])
    expect(container.querySelector('.structured-cell-status')?.textContent).toBe('Current')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    expect(container.querySelector('.code-workspace-drawer')?.textContent).toContain('Wrote figures/generated/fig-canopy.svg')

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 950))
    })
    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({
      root: rootPath,
      path: 'paper.qmd',
      content: expect.stringMatching(/dm-output:start cell="fig-canopy" run="sha256:[a-f0-9]{64}"/),
      expectedHash: 'document-old',
    }))

    vi.mocked(desktopHost.inspectExecutionArtifacts).mockResolvedValue([{ path: 'figures/generated/fig-canopy.svg', hash: `sha256:${'b'.repeat(64)}` }])
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600))
    })
    expect(container.querySelector('.cell-status')?.textContent).toBe('Stale')
    expect(container.textContent).toContain('A generated artifact changed outside DraftMatter.')
  }, 10_000)
})
