// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

const rootPath = '/research/prepare-computation'
const source = `---
title: Prepare computation
---

# Analysis

\`\`\`python {#analysis-setup .execute role="setup"}
baseline = 40
\`\`\`

\`\`\`python {#earlier-result .execute output="text"}
print(baseline)
\`\`\`

\`\`\`python {#requested-result .execute output="text"}
print(baseline + 2)
\`\`\`
`
const project: ProjectSnapshot = {
  root: rootPath,
  config: { schemaVersion: 1, name: 'Prepare computation', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'document-old' }],
  bibliographies: [],
}
const readyInventory = {
  health: 'available' as const,
  searchedLocations: ['/kernels'],
  kernels: [{ name: 'project-python', displayName: 'Python · DraftMatter', language: 'python' as const, health: 'available' as const, resourceDir: '/kernels/project-python' }],
}

async function settleUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('The expected computation preparation state did not appear.')
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)) })
  }
}

describe('prepare a computation from its first Run action', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean
  let prepared: boolean
  let trusted: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    previousAvailability = desktopHost.available
    desktopHost.available = true
    prepared = false
    trusted = false
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-new', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'setExecutionPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'document-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'probeRuntime').mockImplementation(async (language) => prepared && language === 'python'
      ? { language, health: 'available', executable: '/managed/python', version: 'Python fixture' }
      : { language, health: 'missing', message: `${language} is not installed.` })
    vi.spyOn(desktopHost, 'discoverJupyterKernels').mockImplementation(async () => prepared
      ? readyInventory
      : { health: 'missing', searchedLocations: [], kernels: [] })
    vi.spyOn(desktopHost, 'executionTrustStatus').mockImplementation(async () => ({ trusted, scope: 'session', warning: 'Local execution is not a sandbox.' }))
    vi.spyOn(desktopHost, 'trustProjectForSession').mockImplementation(async () => {
      trusted = true
      return { trusted, scope: 'session', warning: 'Local execution is not a sandbox.' }
    })
    vi.spyOn(desktopHost, 'setupKernelIntegration').mockImplementation(async () => {
      prepared = true
      return { language: 'python', kernelName: 'project-python', inventory: readyInventory }
    })
    vi.spyOn(desktopHost, 'terminateKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'fingerprintExecutionInputs').mockResolvedValue([])
    vi.spyOn(desktopHost, 'executeKernel').mockImplementation(async (request) => ({
      status: 'ok', messages: [{ kind: 'stream', sequence: 0, name: 'stdout', text: `completed:${request.cellId}\n` }],
      artifacts: [], environment: { identity: request.kernelName, version: 'fixture' },
      kernelRunId: `kernel-${request.cellId}`, sessionGeneration: 1, executionSequence: 1,
    }))
    vi.spyOn(desktopHost, 'saveExecutionManifest').mockImplementation(async (request) => ({ path: `.draftmatter/execution/${request.cellId}.json`, content: request.content, hash: 'manifest-new', modifiedMs: 2 }))
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => ({ path: request.path, hash: 'document-new', bytes: request.content.length, recoveryPath: null }))

    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => { appRoot.render(<App desktopProjectLaunch={project} />) })
    await settleUntil(() => Boolean(container.querySelector('[data-dm-id="requested-result"] .structured-code-run')))
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  async function requestRun() {
    const run = container.querySelector<HTMLButtonElement>('[data-dm-id="requested-result"] .structured-code-run')!
    await act(async () => run.click())
  }

  async function confirmPreparation() {
    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-trust-title"]')!
    await act(async () => dialog.querySelector<HTMLButtonElement>('.primary-button')!.click())
  }

  it('prepares only the requested language after trust, then runs setup and the original requested cell', async () => {
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    await requestRun()

    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-trust-title"]')!
    expect(dialog.textContent).toContain('download a managed Python')
    expect(dialog.textContent).toContain('run the computation you requested')
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()

    await confirmPreparation()
    await settleUntil(() => vi.mocked(desktopHost.executeKernel).mock.calls.length === 2)
    expect(desktopHost.setupKernelIntegration).toHaveBeenCalledWith(rootPath, 'python', undefined, expect.any(String))
    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => [request.cellId, request.kernelName])).toEqual([
      ['analysis-setup', 'project-python'], ['requested-result', 'project-python'],
    ])
    expect(desktopHost.trustProjectForSession).toHaveBeenCalledTimes(1)
  })

  it('keeps preparation available when the project is already trusted', async () => {
    trusted = true
    await requestRun()
    await settleUntil(() => vi.mocked(desktopHost.executeKernel).mock.calls.length === 2)
    expect(container.querySelector('[aria-labelledby="execution-trust-title"]')).toBeNull()
    expect(desktopHost.setupKernelIntegration).toHaveBeenCalledTimes(1)
    expect(desktopHost.trustProjectForSession).not.toHaveBeenCalled()
  })

  it('does not run manuscript code after preparation fails, and a new Run retries the requested cell', async () => {
    vi.mocked(desktopHost.setupKernelIntegration).mockRejectedValueOnce(new Error('Package download failed. Try again when connected.'))
    await requestRun()
    await confirmPreparation()
    await settleUntil(() => Boolean(container.textContent?.includes('Package download failed')))
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Code and computation"]')!.click())
    await requestRun()
    await settleUntil(() => vi.mocked(desktopHost.executeKernel).mock.calls.length === 2)
    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.cellId)).toEqual(['analysis-setup', 'requested-result'])
  })

  it('cancels the requested run when the preparation prompt is dismissed', async () => {
    await requestRun()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close execution trust dialog"]')!.click())
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const prepare = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Prepare project languages')!
    expect(prepare.disabled).toBe(true)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Trust this project')!.click())
    expect(container.querySelector('[aria-labelledby="execution-trust-title"]')?.textContent).toContain('Trust this project?')
    await confirmPreparation()
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    await act(async () => prepare.click())
    await settleUntil(() => vi.mocked(desktopHost.setupKernelIntegration).mock.calls.length === 1)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('explains that R must be installed instead of running an unprepared computation', async () => {
    await act(async () => appRoot.unmount())
    const rSource = '# Analysis\n\n```r {#requested-result .execute output="text"}\nprint(42)\n```\n'
    vi.mocked(desktopHost.readDocument).mockResolvedValue({ path: 'paper.qmd', content: rSource, hash: 'document-old', modifiedMs: 1 })
    trusted = true
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App desktopProjectLaunch={project} />))
    await settleUntil(() => Boolean(container.querySelector('[data-dm-id="requested-result"] .structured-code-run')))
    await requestRun()
    await settleUntil(() => Boolean(container.querySelector('[aria-label="R environment controls"]')))
    expect(container.textContent).toContain('Install R')
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })
})
