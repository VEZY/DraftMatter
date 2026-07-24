// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type JuliaEnvironment, type ProjectSnapshot } from './desktopHost'

const rootPath = '/research/shared-kernel-execution'
const source = `---
title: Shared kernel execution
---

# Analysis

Published result: {{a}}.

\`\`\`python {#py-setup .execute role="setup"}
baseline = 40
\`\`\`

\`\`\`python {#py-value .execute output="text"}
print(baseline + 2)
\`\`\`

\`\`\`r {#r-model .execute output="text"}
print(42)
\`\`\`

\`\`\`julia {#jl-report .execute output="values"}
a = 42
@publish a
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
    vi.spyOn(desktopHost, 'trustProjectForSession').mockResolvedValue({ trusted: true, scope: 'session', warning: 'trusted' })
    vi.spyOn(desktopHost, 'listJuliaPackages').mockResolvedValue({
      packages: [{ name: 'IJulia', version: '1.34.4', kind: 'package' }], projectFile: true, manifestFile: true,
    })
    vi.spyOn(desktopHost, 'addJuliaPackage').mockResolvedValue({
      packages: [{ name: 'DataFrames', version: '1.7.0', kind: 'package' }], projectFile: true, manifestFile: true,
    })
    vi.spyOn(desktopHost, 'removeJuliaPackage').mockResolvedValue({ packages: [], projectFile: true, manifestFile: true })
    vi.spyOn(desktopHost, 'probeCodeFormatter').mockImplementation(async (request) => ({
      language: request.language,
      package: request.language === 'python' ? 'Ruff' : 'styler',
      available: true,
      version: request.language === 'python' ? '0.12.0' : '1.10.3',
    }))
    vi.spyOn(desktopHost, 'installCodeFormatter').mockImplementation(async (request) => ({
      language: request.language,
      package: request.language === 'python' ? 'Ruff' : 'styler',
      available: true,
      version: request.language === 'python' ? '0.12.0' : '1.10.3',
    }))
    vi.spyOn(desktopHost, 'formatCode').mockImplementation(async (request) => ({ code: request.code, changed: false }))
    vi.spyOn(desktopHost, 'setupKernelIntegration').mockRejectedValue(new Error('Setup should not run when every detected environment is ready.'))
    vi.spyOn(desktopHost, 'fingerprintExecutionInputs').mockResolvedValue([])
    vi.spyOn(desktopHost, 'executeKernel').mockImplementation(async (request) => ({
      status: 'ok',
      messages: request.attributes.role === 'setup' ? [] : request.cellId === 'jl-report'
        ? [{
            kind: 'display', sequence: 0,
            data: { 'application/vnd.draftmatter.published-value+json': { version: 1, name: 'a', value: 42, formatting: {} } },
          }]
        : [{ kind: 'stream', sequence: 0, name: 'stdout', text: `kernel:${request.cellId}\n` }],
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
    expect(container.querySelector('.structured-code-cell[data-dm-id="py-setup"]')).toBeNull()
    expect(container.querySelector('.structured-panel-code-placeholder[data-dm-id="py-setup"]')).not.toBeNull()
    const pythonCell = container.querySelector<HTMLElement>('.structured-code-cell[data-dm-id="py-value"]')!
    await act(async () => pythonCell.querySelector<HTMLButtonElement>('.structured-code-run')!.click())
    await settle()

    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => [request.cellId, request.kernelName])).toEqual([
      ['py-setup', 'python-fixture'], ['py-value', 'python-fixture'],
    ])
    expect(container.textContent).toContain('kernel:py-value')
    if (!container.querySelector('[aria-label="Shared kernel terminal"]')) {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Open shared kernel terminal"]')!.click())
    }
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Python'))!.click())
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('ready')
  })

  it('runs preceding computations from the manuscript hover toolbar', async () => {
    const pythonCell = container.querySelector<HTMLElement>('.structured-code-cell[data-dm-id="py-value"]')!
    const runAbove = pythonCell.querySelector<HTMLButtonElement>('.structured-code-run-above')!
    expect(runAbove.hidden).toBe(false)
    expect(runAbove.disabled).toBe(false)

    await act(async () => runAbove.click())
    await settle()

    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.cellId)).toEqual(['py-setup'])
  })

  it('retains a one-letter Julia publication in the opened document', async () => {
    const published = container.querySelector<HTMLElement>('[data-dm-node="published-value"][data-name="a"]')!
    expect(published.dataset.status).toBe('missing')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const juliaCell = container.querySelector<HTMLElement>('.execution-cell-row[data-cell-id="jl-report"]')!
    expect(container.querySelector('.structured-code-cell[data-dm-id="jl-report"]')).toBeNull()
    await act(async () => juliaCell.querySelector<HTMLButtonElement>('.run-button')!.click())
    await settle()

    const resolved = container.querySelector<HTMLElement>('[data-dm-node="published-value"][data-name="a"]')!
    expect(resolved.dataset.status).toBe('current')
    expect(resolved.textContent).toBe('42')
    await settle(950)
    expect(vi.mocked(desktopHost.saveDocument).mock.calls.map(([request]) => request.content).join('\n')).toContain('dm-published-value')
  })

  it('edits setup and published-value source from the code panel', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const setupRow = container.querySelector<HTMLElement>('.execution-cell-row[data-cell-id="py-setup"]')!
    const codeView = CodeMirrorView.findFromDOM(setupRow.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => codeView.dispatch({ changes: { from: codeView.state.doc.length, insert: '\nthreshold = 2' } }))
    expect(setupRow.textContent).toContain('Unsaved source changes')

    await act(async () => [...setupRow.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save source')!.click())
    await settle(950)

    expect(vi.mocked(desktopHost.saveDocument).mock.calls.map(([request]) => request.content).join('\n')).toContain('threshold = 2')
    expect(setupRow.textContent).toContain('Saved in the project document')
    expect(container.querySelector('.structured-code-cell[data-dm-id="py-setup"]')).toBeNull()
  })

  it('adds a reproducible table from the code panel', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const addTable = [...container.querySelectorAll<HTMLButtonElement>('.code-workspace-toolbar button')]
      .find((button) => button.textContent?.includes('Add reproducible table'))!
    expect(addTable).toBeTruthy()
    await act(async () => addTable.click())

    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="insert-block-title"]')!
    expect(dialog.textContent).toContain('Add reproducible table')
    const language = dialog.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      language.value = 'julia'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    await settle(950)

    const savedSources = vi.mocked(desktopHost.saveDocument).mock.calls.map(([request]) => request.content)
    expect(savedSources.join('\n')).toMatch(/```julia \{#cell-julia-[^}]+ \.execute output="table" reference="tbl-result"\}/)
  })

  it('checks detected project languages automatically and restores remembered trust', async () => {
    await act(async () => appRoot.unmount())
    localStorage.setItem('draftmatter.trusted-project-roots.v1', JSON.stringify([rootPath]))
    vi.mocked(desktopHost.executionTrustStatus).mockReset().mockResolvedValue({ trusted: false, scope: 'session', warning: 'not trusted in the new host session' })
    vi.mocked(desktopHost.trustProjectForSession).mockClear()
    vi.mocked(desktopHost.listJuliaPackages).mockClear()
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App />))
    await settle(420)

    expect(desktopHost.trustProjectForSession).toHaveBeenCalledWith(rootPath, 'run-project-code-with-user-permissions')
    expect(desktopHost.listJuliaPackages).toHaveBeenCalledWith(rootPath, expect.any(String))
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-labelledby="execution-trust-title"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[aria-label="Shared kernel terminal"]')?.parentElement?.hidden).toBe(true)
    expect(container.querySelector('.rail-terminal-button')?.getAttribute('data-label')).toBe('Terminal · Ready')
  })

  it('keeps the quick citation launcher available in a desktop project', async () => {
    const launcher = container.querySelector<HTMLButtonElement>('.quick-cite')
    expect(launcher).not.toBeNull()
    expect(launcher?.disabled).toBe(false)

    await act(async () => launcher!.click())

    expect(container.querySelector('[role="dialog"][aria-label="Insert citation"]')).not.toBeNull()
  })

  it('repairs a Julia project when its local IJulia integration is missing', async () => {
    await act(async () => appRoot.unmount())
    vi.mocked(desktopHost.listJuliaPackages).mockReset().mockResolvedValue({
      packages: [{ name: 'CairoMakie', version: '0.15.6', kind: 'package' }],
      projectFile: true,
      manifestFile: true,
    })
    vi.mocked(desktopHost.setupKernelIntegration).mockReset().mockResolvedValue({
      language: 'julia',
      kernelName: 'julia-draftmatter-fixture',
      inventory: {
        health: 'available',
        searchedLocations: ['/kernels'],
        kernels: [{
          name: 'julia-draftmatter-fixture',
          displayName: 'Julia · DraftMatter',
          language: 'julia',
          health: 'available',
          resourceDir: '/kernels/julia-draftmatter',
          executable: '/usr/bin/julia',
        }],
      },
    })
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App />))
    await settle(520)

    expect(desktopHost.setupKernelIntegration).toHaveBeenCalledWith(
      rootPath,
      'julia',
      expect.any(String),
      expect.any(String),
    )
    expect(desktopHost.setExecutionPreferences).toHaveBeenCalledWith(
      rootPath,
      expect.objectContaining({
        julia: expect.objectContaining({ kernel: 'julia-draftmatter-fixture' }),
      }),
    )
  })

  it('keeps Julia package work in the background until the terminal is opened', async () => {
    await settle(420)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    let resolveAdd: (environment: JuliaEnvironment) => void = () => undefined
    vi.mocked(desktopHost.addJuliaPackage).mockImplementationOnce(() => new Promise((resolve) => { resolveAdd = resolve }))
    const packages = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Julia packages'))!
    await act(async () => packages.click())
    await settle(30)

    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="julia-packages-title"]')!
    const input = dialog.querySelector<HTMLInputElement>('[aria-label="Julia package name"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'DataFrames')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    await settle(30)

    expect(container.querySelector('[aria-labelledby="julia-packages-title"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[aria-label="Shared kernel terminal"]')?.parentElement?.hidden).toBe(true)
    const workingLauncher = container.querySelector<HTMLButtonElement>('.rail-terminal-button')!
    expect(workingLauncher.getAttribute('data-label')).toBe('Terminal · Working…')
    await act(async () => workingLauncher.click())
    const activity = container.querySelector<HTMLElement>('.kernel-project-activity')!
    expect(activity.textContent).toContain('Adding DataFrames')
    expect(activity.textContent).toContain('editor remains usable')
    expect(activity.textContent).toContain('julia --project=.')
    expect(desktopHost.addJuliaPackage).toHaveBeenCalledWith({ root: rootPath, name: 'DataFrames' }, expect.any(String))

    await act(async () => resolveAdd({
      packages: [
        { name: 'DataFrames', version: '1.7.0', kind: 'package' },
        { name: 'JuliaFormatter', version: '2.10.1', kind: 'package' },
      ],
      projectFile: true,
      manifestFile: true,
    }))
    await settle(120)
    const refreshedDialog = container.querySelector<HTMLElement>('[aria-labelledby="julia-packages-title"]')!
    expect(refreshedDialog).toBeTruthy()
    expect(refreshedDialog.textContent).toContain('JuliaFormatter')
    expect([...refreshedDialog.querySelectorAll('button')].some((button) => button.textContent === 'Add JuliaFormatter')).toBe(false)
    expect(container.querySelector('.kernel-project-activity')?.textContent).toContain('Ready')
    expect(container.querySelector<HTMLButtonElement>('.kernel-project-tab')?.getAttribute('aria-selected')).toBe('true')

    const openTerminal = container.querySelector<HTMLButtonElement>('.kernel-project-activity-footer button')!
    await act(async () => openTerminal.click())
    expect(container.querySelector('[aria-label="Shared kernel terminal"]')?.textContent).toContain('Julia REPL · shared document kernel')
    expect(container.querySelector('[aria-label="Shared kernel terminal"]')?.textContent).toContain('julia --project=.')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close kernel terminal"]')!.click())
    const terminalLauncher = container.querySelector<HTMLButtonElement>('.app-rail .rail-terminal-button')!
    expect(terminalLauncher.getAttribute('aria-label')).toContain('Open shared kernel terminal, Ready')
    expect(terminalLauncher.getAttribute('data-label')).toBe('Terminal · Ready')
    expect(terminalLauncher.getAttribute('data-status')).toBe('succeeded')
  })

  it('opens failed Julia manuscript cells in the terminal with their traceback', async () => {
    vi.mocked(desktopHost.executeKernel).mockImplementationOnce(async (request) => ({
      status: 'error',
      messages: [{
        kind: 'error', sequence: 0, name: 'MethodError',
        message: 'no method matching Figure(::Nothing)',
        traceback: ['Figure at Makie/src/figureplotting.jl:117', 'top-level scope at cell.jl:3'],
      }],
      artifacts: [], environment: { identity: request.kernelName, version: 'fixture' },
      kernelRunId: `kernel-${request.cellId}`, executionCount: ++executionSequence, sessionGeneration: 1, executionSequence,
    }))
    const openTerminal = container.querySelector<HTMLButtonElement>('[aria-label^="Open shared kernel terminal"]')
    if (!openTerminal) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close kernel terminal"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const juliaCell = container.querySelector<HTMLElement>('.execution-cell-row[data-cell-id="jl-report"]')!
    await act(async () => juliaCell.querySelector<HTMLButtonElement>('.run-button')!.click())
    await settle()

    const terminal = container.querySelector<HTMLElement>('[aria-label="Shared kernel terminal"]')!
    expect(terminal).toBeTruthy()
    expect(terminal.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Julia')
    expect(terminal.textContent).toContain('jl-report failed')
    expect(terminal.textContent).toContain('MethodError: no method matching Figure(::Nothing)')
    expect(terminal.textContent).toContain('Figure at Makie/src/figureplotting.jl:117')
    expect(container.querySelector('.toast')?.textContent).toContain('details opened in Terminal')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close kernel terminal"]')!.click())
    const reopen = container.querySelector<HTMLButtonElement>('[aria-label^="Open shared kernel terminal"]')!
    expect(reopen.getAttribute('aria-label')).toContain('Needs attention')
    await act(async () => reopen.click())
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Julia')
    expect(container.querySelector('[aria-label="Shared kernel terminal"]')?.textContent).toContain('Figure at Makie/src/figureplotting.jl:117')
  })

  it('clean-runs setup first, restarts every language kernel, and never materializes setup output', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const cleanRun = [...container.querySelectorAll<HTMLButtonElement>('.code-workspace-toolbar button')]
      .find((button) => button.textContent?.includes('Clean run'))!
    await act(async () => cleanRun.click())
    await settle(220)

    expect(vi.mocked(desktopHost.restartKernel).mock.calls.map(([language]) => language)).toEqual(['python', 'r', 'julia'])
    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.cellId)).toEqual(['py-setup', 'py-value', 'r-model', 'jl-report'])
    const savedSources = vi.mocked(desktopHost.saveDocument).mock.calls.map(([request]) => request.content)
    expect(savedSources.join('\n')).not.toContain('dm-output:start cell="py-setup"')
  })

  it('shows only language environments and shared kernels', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const environments = [...container.querySelectorAll<HTMLButtonElement>('.code-workspace-toolbar button')]
      .find((button) => button.textContent?.includes('Environments'))!
    await act(async () => environments.click())
    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-environment-title"]')!
    expect(dialog.textContent).toContain('shared Jupyter kernel, no notebook server')
  })

  it('keeps Python and R formatter packages outside the application bundle', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    const environments = [...container.querySelectorAll<HTMLButtonElement>('.code-workspace-toolbar button')]
      .find((button) => button.textContent?.includes('Environments'))!
    await act(async () => environments.click())
    await settle(140)

    let dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-environment-title"]')!
    expect(dialog.querySelector('.formatter-package-callout')?.textContent).toContain('Ruff 0.12.0 is available')
    expect(dialog.querySelector('.formatter-package-callout')?.textContent).toContain('Repair Ruff')
    await act(async () => dialog.querySelector<HTMLButtonElement>('.formatter-package-callout button')!.click())
    await settle(140)
    expect(desktopHost.installCodeFormatter).toHaveBeenCalledWith(
      expect.objectContaining({ root: rootPath, language: 'python' }),
      expect.any(String),
    )

    dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-environment-title"]')!
    const rRuntime = [...dialog.querySelectorAll<HTMLButtonElement>('.execution-environment-list button')]
      .find((button) => button.querySelector('strong')?.textContent === 'R')!
    await act(async () => rRuntime.click())
    await settle(140)
    expect(dialog.querySelector('.formatter-package-callout')?.textContent).toContain('styler 1.10.3 is available')
  })

  it('keeps terminal history and shared kernel status when the bottom panel closes', async () => {
    const open = container.querySelector<HTMLButtonElement>('[aria-label^="Open shared kernel terminal"]')
    if (open) await act(async () => open.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Python'))!.click())
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Python terminal input"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'shared_value = 42')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await settle()
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('ready')
    expect(container.textContent).toContain('Interactive · clean run will restart this kernel')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close kernel terminal"]')!.click())
    const reopen = container.querySelector<HTMLButtonElement>('[aria-label*="interactive state present"]')!
    expect(reopen).toBeTruthy()
    await act(async () => reopen.click())
    expect(container.textContent).toContain('shared_value = 42')
    expect(container.textContent).toContain('Interactive · clean run will restart this kernel')
  })
})
