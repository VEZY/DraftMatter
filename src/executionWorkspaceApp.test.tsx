// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

const rootPath = '/research/shared-kernel-execution'
const source = `---
title: Shared kernel execution
---

# Analysis

\`\`\`python {#py-setup .execute role="setup"}
baseline = 40
\`\`\`

\`\`\`python {#py-value .execute output="text"}
print(baseline + 2)
\`\`\`

\`\`\`r {#r-model .execute output="text"}
print(42)
\`\`\`

\`\`\`julia {#jl-report .execute output="text"}
println(42)
\`\`\`
`

const project: ProjectSnapshot = {
  root: rootPath,
  config: {
    schemaVersion: 1, name: 'Shared kernel execution', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US',
    execution: { python: { kernel: 'python-fixture' }, r: { kernel: 'r-fixture' }, julia: { kernel: 'julia-fixture' } },
  },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'document-old' }],
  bibliographies: [],
}

async function settle(ms = 120) {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)) })
}

describe('shared Jupyter execution workspace', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean
  let executionSequence: number

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    previousAvailability = desktopHost.available
    desktopHost.available = true
    executionSequence = 0
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'setExecutionPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'probeRuntime').mockImplementation(async (language) => ({ language, health: 'available', executable: `/usr/bin/${language}`, version: `${language} test runtime` }))
    vi.spyOn(desktopHost, 'discoverJupyterKernels').mockResolvedValue({
      health: 'available', searchedLocations: ['/kernels'], kernels: [
        { name: 'python-fixture', displayName: 'Python fixture', language: 'python', health: 'available', resourceDir: '/kernels/python' },
        { name: 'r-fixture', displayName: 'R fixture', language: 'r', health: 'available', resourceDir: '/kernels/r' },
        { name: 'julia-fixture', displayName: 'Julia fixture', language: 'julia', health: 'available', resourceDir: '/kernels/julia' },
      ],
    })
    vi.spyOn(desktopHost, 'executionTrustStatus').mockResolvedValue({ trusted: true, scope: 'session', warning: 'trusted' })
    vi.spyOn(desktopHost, 'fingerprintExecutionInputs').mockResolvedValue([])
    vi.spyOn(desktopHost, 'executeKernel').mockImplementation(async (request) => ({
      status: 'ok',
      messages: request.attributes.role === 'setup' ? [] : [{ kind: 'stream', sequence: 0, name: 'stdout', text: `kernel:${request.cellId}\n` }],
      artifacts: [], environment: { identity: request.kernelName, version: 'fixture' },
      kernelRunId: `kernel-${request.cellId}`, executionCount: ++executionSequence, sessionGeneration: 1, executionSequence,
    }))
    vi.spyOn(desktopHost, 'interruptKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'restartKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'terminateKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'saveExecutionManifest').mockImplementation(async (request) => ({ path: `.draftmatter/execution/${request.cellId}.json`, content: request.content, hash: `manifest-${request.cellId}`, modifiedMs: 2 }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => ({ path: request.path, hash: 'document-new', bytes: request.content.length, recoveryPath: null }))

    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => { appRoot.render(<App />) })
    await settle(30)
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('runs setup before the first ordinary cell in the exact same selected kernel', async () => {
    const pythonCell = container.querySelector<HTMLElement>('.structured-code-cell[data-dm-id="py-value"]')!
    await act(async () => pythonCell.querySelector<HTMLButtonElement>('.structured-code-run')!.click())
    await settle()

    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => [request.cellId, request.kernelName])).toEqual([
      ['py-setup', 'python-fixture'], ['py-value', 'python-fixture'],
    ])
    expect(container.textContent).toContain('kernel:py-value')
  })

  it('clean-runs setup first, restarts every language kernel, and never materializes setup output', async () => {
    const cleanRun = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Clean run'))!
    await act(async () => cleanRun.click())
    await settle(220)

    expect(vi.mocked(desktopHost.restartKernel).mock.calls.map(([language]) => language)).toEqual(['python', 'r', 'julia'])
    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.cellId)).toEqual(['py-setup', 'py-value', 'r-model', 'jl-report'])
    const savedSources = vi.mocked(desktopHost.saveDocument).mock.calls.map(([request]) => request.content)
    expect(savedSources.join('\n')).not.toContain('dm-output:start cell="py-setup"')
  })

  it('shows only language environments and shared kernels', async () => {
    const environments = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Environments'))!
    await act(async () => environments.click())
    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-environment-title"]')!
    expect(dialog.textContent).toContain('shared Jupyter kernel, no notebook server')
  })
})
