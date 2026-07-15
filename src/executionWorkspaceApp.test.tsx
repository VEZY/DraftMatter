// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

const rootPath = '/research/multi-language-execution'
const source = `---
title: Multi-language execution
---

# Analysis

\`\`\`python {#py-prepare .execute output="text" inputs="data/observations.csv"}
print("python")
\`\`\`

\`\`\`r {#r-model .execute output="text"}
print("r")
\`\`\`

\`\`\`julia {#jl-report .execute output="text"}
println("julia")
\`\`\`
`

const project: ProjectSnapshot = {
  root: rootPath,
  config: { schemaVersion: 1, name: 'Multi-language execution', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'document-old' }],
  bibliographies: [],
}

describe('document execution workspace', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean
  let failingLanguage: string | undefined

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    previousAvailability = desktopHost.available
    desktopHost.available = true
    failingLanguage = undefined
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'probeRuntime').mockImplementation(async (language) => ({
      language,
      health: 'available',
      executable: `/usr/bin/${language}`,
      version: `${language} test runtime`,
    }))
    vi.spyOn(desktopHost, 'discoverJupyterKernels').mockResolvedValue({
      health: 'available',
      kernels: [{
        name: 'python-fixture',
        displayName: 'Python fixture kernel',
        language: 'python',
        health: 'available',
        resourceDir: '/kernels/python-fixture',
        executable: '/usr/bin/python',
      }],
      searchedLocations: ['/kernels'],
    })
    vi.spyOn(desktopHost, 'executionTrustStatus').mockResolvedValue({ trusted: true, scope: 'session', warning: 'trusted' })
    vi.spyOn(desktopHost, 'fingerprintExecutionInputs').mockResolvedValue([{ path: 'data/observations.csv', hash: `sha256:${'9'.repeat(64)}` }])
    vi.spyOn(desktopHost, 'executeDirect').mockImplementation(async (request) => ({
      exitCode: request.language === failingLanguage ? 1 : 0,
      interrupted: false,
      stdout: request.language === failingLanguage ? '' : `ran:${request.cellId}\n`,
      stderr: request.language === failingLanguage ? `${request.language} failed\n` : '',
      mime: request.language === failingLanguage ? [] : [{ data: { 'text/plain': `output:${request.cellId}` }, metadata: {} }],
      artifacts: [],
      environment: { identity: `/usr/bin/${request.language}`, version: `${request.language} test runtime`, details: { mode: 'script-artifact' } },
      providerRunId: `direct-${request.cellId}`,
    }))
    vi.spyOn(desktopHost, 'interruptDirect').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'restartDirect').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'terminateDirect').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'executeKernel').mockImplementation(async (request) => ({
      status: 'ok',
      messages: [
        { kind: 'stream', sequence: 0, name: 'stdout', text: `kernel:${request.cellId}\n` },
        { kind: 'display', sequence: 1, data: { 'text/plain': `kernel-output:${request.cellId}` }, metadata: {} },
      ],
      artifacts: [],
      environment: { identity: request.kernelName, version: 'Python 3.13', details: { mode: 'interactive-kernel' } },
      providerRunId: `kernel-${request.cellId}`,
      executionCount: 2,
    }))
    vi.spyOn(desktopHost, 'interruptKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'restartKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'terminateKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'saveExecutionManifest').mockImplementation(async (request) => ({
      path: `.draftmatter/execution/${request.cellId}.json`, content: request.content, hash: `manifest-${request.cellId}`, modifiedMs: 2,
    }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => ({
      path: request.path, hash: 'document-new', bytes: request.content.length, recoveryPath: null,
    }))

    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => {
      appRoot.render(<App />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('runs cells above in document order and certifies a clean all-language run', async () => {
    const juliaRow = [...container.querySelectorAll<HTMLElement>('.execution-cell-row')]
      .find((row) => row.textContent?.includes('jl-report'))!
    const runAbove = [...juliaRow.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Run above'))!

    await act(async () => {
      runAbove.click()
      await new Promise((resolve) => window.setTimeout(resolve, 120))
    })

    expect(vi.mocked(desktopHost.executeDirect).mock.calls.map(([request]) => request.cellId)).toEqual(['py-prepare', 'r-model'])
    expect(desktopHost.fingerprintExecutionInputs).toHaveBeenCalledWith(rootPath, ['data/observations.csv'])
    expect(desktopHost.executeDirect).toHaveBeenCalledWith(expect.objectContaining({
      cellId: 'py-prepare',
      inputs: [{ path: 'data/observations.csv', hash: `sha256:${'9'.repeat(64)}` }],
    }))
    expect(container.textContent).toContain('ran:py-prepare')
    expect(container.textContent).toContain('ran:r-model')
    expect(container.textContent).not.toContain('ran:jl-report')

    vi.mocked(desktopHost.executeDirect).mockClear()
    const cleanRun = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Clean run'))!
    await act(async () => {
      cleanRun.click()
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    expect(vi.mocked(desktopHost.restartDirect).mock.calls.map(([language]) => language)).toEqual(['python', 'r', 'julia'])
    expect(vi.mocked(desktopHost.executeDirect).mock.calls.map(([request]) => request.cellId)).toEqual(['py-prepare', 'r-model', 'jl-report'])
    expect([...container.querySelectorAll('.execution-cell-row .cell-status')].map((status) => status.textContent)).toEqual(['Current', 'Current', 'Current'])
    expect(container.textContent).toContain('Clean run certified · 3 outputs from one ordered run')

    const manifests = vi.mocked(desktopHost.saveExecutionManifest).mock.calls.slice(-3).map(([request]) => JSON.parse(request.content))
    expect(manifests.map((manifest) => [manifest.cellId, manifest.sequence])).toEqual([
      ['py-prepare', 0],
      ['r-model', 1],
      ['jl-report', 2],
    ])
    expect(new Set(manifests.map((manifest) => manifest.cleanRunId)).size).toBe(1)

    vi.mocked(desktopHost.restartDirect).mockClear()
    const environments = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Environments'))!
    await act(async () => environments.click())
    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-environment-title"]')!
    const juliaEnvironment = [...dialog.querySelectorAll<HTMLButtonElement>('.execution-environment-list > button')]
      .find((button) => button.textContent?.includes('Julia'))!
    await act(async () => juliaEnvironment.click())
    const restart = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Restart Julia'))!
    const terminate = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Terminate Julia'))!
    await act(async () => {
      restart.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      terminate.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(desktopHost.restartDirect).toHaveBeenCalledWith('julia')
    expect(desktopHost.terminateDirect).toHaveBeenCalledWith('julia')
  })

  it('keeps the last certified manuscript untouched when a later clean run fails', async () => {
    const cleanRun = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Clean run'))!
    await act(async () => {
      cleanRun.click()
      await new Promise((resolve) => window.setTimeout(resolve, 1050))
    })
    expect(container.textContent).toContain('Clean run certified · 3 outputs from one ordered run')

    vi.mocked(desktopHost.saveExecutionManifest).mockClear()
    failingLanguage = 'r'
    await act(async () => {
      cleanRun.click()
      await new Promise((resolve) => window.setTimeout(resolve, 900))
    })

    expect(desktopHost.executeDirect).toHaveBeenLastCalledWith(expect.objectContaining({ cellId: 'r-model', language: 'r' }))
    expect(container.textContent).toContain('previous outputs retained')
    expect(desktopHost.saveExecutionManifest).not.toHaveBeenCalled()
    expect(container.textContent).toContain('output:py-prepare')
    expect(container.textContent).toContain('output:r-model')
    expect(container.textContent).toContain('output:jl-report')
  })

  it('selects a healthy Jupyter kernel and routes execution through the typed kernel command', async () => {
    const environments = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Environments'))!
    await act(async () => {
      environments.click()
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-environment-title"]')!
    const provider = dialog.querySelector<HTMLSelectElement>('[aria-label="Execution provider"]')!
    const kernel = dialog.querySelector<HTMLSelectElement>('[aria-label="Jupyter kernel"]')!
    expect(kernel.value).toBe('python-fixture')
    expect(kernel.textContent).toContain('Python fixture kernel')

    await act(async () => {
      provider.value = 'kernel'
      provider.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(provider.value).toBe('kernel')
    vi.mocked(desktopHost.executeDirect).mockClear()
    vi.mocked(desktopHost.executeKernel).mockClear()

    const runPython = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Run Python'))!
    await act(async () => {
      runPython.click()
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    })

    expect(desktopHost.executeDirect).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).toHaveBeenCalledWith(expect.objectContaining({
      root: rootPath,
      cellId: 'py-prepare',
      language: 'python',
      kernelName: 'python-fixture',
    }))
    expect(container.textContent).toContain('kernel:py-prepare')
  })

  it('marks the affected language stale when a declared input changes on disk', async () => {
    const cleanRun = [...container.querySelectorAll<HTMLButtonElement>('.structured-execution-bar button')]
      .find((button) => button.textContent?.includes('Clean run'))!
    await act(async () => {
      cleanRun.click()
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    expect(container.textContent).toContain('Clean run certified · 3 outputs from one ordered run')

    vi.mocked(desktopHost.fingerprintExecutionInputs).mockResolvedValue([{ path: 'data/observations.csv', hash: `sha256:${'8'.repeat(64)}` }])
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600))
    })

    const statuses = [...container.querySelectorAll<HTMLElement>('.execution-cell-row')].map((row) => [
      row.querySelector('strong')?.textContent,
      row.querySelector('.cell-status')?.textContent,
    ])
    expect(statuses).toEqual([
      ['py-prepare', 'Stale'],
      ['r-model', 'Current'],
      ['jl-report', 'Current'],
    ])
    expect(container.textContent).not.toContain('Clean run certified · 3 outputs from one ordered run')
  })
})
