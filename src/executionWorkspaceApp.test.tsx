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

async function settleUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`)
    await settle(50)
  }
}

function pendingStep() {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => { finish = resolve })
  return { promise, finish }
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
        { name: 'python-fixture', displayName: 'Python · DraftMatter', language: 'python', health: 'available', resourceDir: '/kernels/python' },
        { name: 'r-fixture', displayName: 'R · DraftMatter', language: 'r', health: 'available', resourceDir: '/kernels/r' },
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
    await settleUntil(() => Boolean(container.querySelector('.structured-panel-code-placeholder[data-dm-id="py-setup"]')))
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  async function openCodeWorkspace() {
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!
    await act(async () => open.click())
    await settleUntil(() => Boolean(container.querySelector('.code-workspace-toolbar')))
  }

  async function prepareEnvironments() {
    await openCodeWorkspace()
    await settle()
    const trust = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Trust this project')
    if (trust) {
      await act(async () => trust.click())
      const confirm = container.querySelector<HTMLButtonElement>('[aria-labelledby="execution-trust-title"] .primary-button')!
      await act(async () => confirm.click())
    }
    const prepare = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Prepare project languages')!
    await act(async () => prepare.click())
  }

  it('keeps the chosen code workspace open during requested project setup', async () => {
    await act(async () => appRoot.unmount())

    const discoverKernels = vi.mocked(desktopHost.discoverJupyterKernels)
    const inventory = await discoverKernels()
    const discovery = pendingStep()
    discoverKernels.mockClear().mockImplementationOnce(async () => {
      await discovery.promise
      return inventory
    })
    const listPackages = vi.mocked(desktopHost.listJuliaPackages)
    const check = pendingStep()
    listPackages.mockClear().mockImplementationOnce(async () => {
      await check.promise
      return { projectFile: true, manifestFile: true, packages: [] }
    })
    const repairKernel = vi.mocked(desktopHost.setupKernelIntegration)
    const repair = pendingStep()
    repairKernel.mockImplementationOnce(async () => {
      await repair.promise
      return { language: 'julia', kernelName: 'julia-fixture', inventory }
    })
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App desktopProjectLaunch={project} />))
    await prepareEnvironments()
    await settleUntil(() => discoverKernels.mock.calls.length > 0)
    const workspace = container.querySelector('.code-workspace-toolbar')!
    await act(async () => discovery.finish())
    await settleUntil(() => listPackages.mock.calls.length > 0)
    expect(workspace.isConnected).toBe(true)
    await act(async () => check.finish())
    await settleUntil(() => repairKernel.mock.calls.length > 0)
    expect(workspace.isConnected).toBe(true)
    await act(async () => repair.finish())
    await settleUntil(() => container.querySelector('.rail-terminal-button')?.getAttribute('data-label') === 'Terminal · Ready')
    expect(workspace.isConnected).toBe(true)
    expect(container.querySelector('[aria-label="Check Python"]')).not.toBeNull()
  })

  it('keeps optional computation accessible through a compact tool with its state in the tooltip', () => {
    const codeWorkspace = container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!
    expect(codeWorkspace).not.toBeNull()
    expect(codeWorkspace.classList.contains('compact-tool')).toBe(true)
    expect(codeWorkspace.getAttribute('data-tooltip')).toBe('Code & computation · Needs run')
    expect(container.querySelector('[aria-label="Open command menu"]')?.textContent).toContain('Find a tool or action')
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
    expect(container.querySelector('[aria-label="Shared kernel terminal"] [role="tab"][aria-selected="true"]')?.textContent).toContain('ready')
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

    await openCodeWorkspace()
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

  async function openPythonValuePaper() {
    await act(async () => appRoot.unmount())
    localStorage.clear()
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    const cellSource = 'publish("measurement", 40)'
    const paper = [
      '# Measurements', '', 'First: {{measurement}}. Second: {{measurement}}.', '',
      '```python {#py-measure .execute output="values"}', cellSource, '```', '',
    ].join('\n')
    vi.mocked(desktopHost.readDocument).mockResolvedValue({ path: 'paper.qmd', content: paper, hash: 'measurement-original', modifiedMs: 1 })
    vi.mocked(desktopHost.formatCode).mockImplementation(async ({ code }) => ({ code: code.replace(/,\s*/g, ', '), changed: code.includes(',4') }))
    vi.mocked(desktopHost.executeKernel).mockImplementation(async (request) => {
      const value = request.code.match(/publish\("measurement", (\d+)\)/)?.[1]
      return {
        status: value ? 'ok' : 'error',
        messages: value
          ? [{ kind: 'display', sequence: 0, data: { 'application/vnd.draftmatter.published-value+json': { version: 1, name: 'measurement', value: Number(value), formatting: {} } } }]
          : [{ kind: 'error', sequence: 0, name: 'NameError', message: 'unknown is not defined', traceback: [] }],
        artifacts: [], environment: { identity: request.kernelName, version: 'fixture' },
        kernelRunId: 'kernel-measurement', executionCount: ++executionSequence, sessionGeneration: 1, executionSequence,
      }
    })
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App />))
    const occurrences = () => [...container.querySelectorAll<HTMLElement>('[data-dm-node="published-value"][data-name="measurement"]')]
    await settleUntil(() => occurrences().length === 2)
    return { occurrences, cellSource }
  }

  it('autosaves inline source across occurrences and keeps results until an explicit desktop run succeeds', async () => {
    const { occurrences, cellSource } = await openPythonValuePaper()
    const panel = () => container.querySelector<HTMLElement>('[aria-label="Computed value measurement"]')
    const status = (expected: string) => occurrences().length === 2 && occurrences().every((element) => element.dataset.status === expected)
    const values = () => occurrences().map((element) => element.textContent)
    const code = () => CodeMirrorView.findFromDOM(panel()!.querySelector<HTMLElement>('.cm-editor')!)!
    const open = async (index: number) => {
      await act(async () => occurrences()[index].click())
      await settleUntil(() => Boolean(panel()?.querySelector('.cm-editor')))
    }
    const run = async () => {
      const button = [...panel()!.querySelectorAll('button')].find((element) =>
        (element.getAttribute('aria-label') || element.textContent)?.trim() === 'Run')
      expect(button).toBeDefined()
      await act(async () => button!.click())
    }
    const replaceCode = (source: string) => {
      const editor = code()
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } })
    }
    const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    await open(1)
    expect(panel()?.textContent).toContain('2 occurrences')
    expect(code().state.doc.toString()).toBe(cellSource)
    await run()
    await settleUntil(() => status('current'))
    expect(values()).toEqual(['40', '40'])

    await open(0)
    expect(panel()?.textContent).not.toMatch(/Saved result|Unsaved source changes|Save source|Revert/i)
    const formatCallsBeforeTyping = vi.mocked(desktopHost.formatCode).mock.calls.length
    const nextSource = 'publish("measurement",41)'
    await act(async () => {
      replaceCode('publish("measurement",4)')
      const editor = code()
      editor.dispatch({ changes: { from: editor.state.doc.length - 1, insert: '1' } })
      escape()
    })
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(occurrences()[0])
    await settleUntil(() => status('stale'))
    expect(values()).toEqual(['40', '40'])
    await open(1)
    expect(code().state.doc.toString()).toBe(nextSource)
    await settleUntil(() => vi.mocked(desktopHost.saveDocument).mock.calls.some(([request]) =>
      request.path === 'paper.qmd' && request.content.includes(nextSource)))
    expect(vi.mocked(desktopHost.formatCode).mock.calls).toHaveLength(formatCallsBeforeTyping)
    expect(desktopHost.executeKernel).toHaveBeenCalledTimes(1)

    await run()
    await settleUntil(() => status('current') && values().every((value) => value === '41'))
    await open(0)
    await act(async () => replaceCode('publish("measurement", unknown)'))
    expect(desktopHost.executeKernel).toHaveBeenCalledTimes(2)
    await run()
    await settleUntil(() => status('failed'))
    expect(values()).toEqual(['41', '41'])
    await open(0)
    expect(code().state.doc.toString()).toBe('publish("measurement", unknown)')
    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.code)).toEqual([
      cellSource, 'publish("measurement", 41)', 'publish("measurement", unknown)',
    ])
  })

  it.each(['cell', 'all'])('retains the previous outputs when code is edited during a pending %s run', async (command) => {
    const { occurrences } = await openPythonValuePaper()
    await openCodeWorkspace()
    const row = container.querySelector<HTMLElement>('.execution-cell-row[data-cell-id="py-measure"]')!
    await act(async () => row.querySelector<HTMLButtonElement>('.run-button')!.click())
    await settleUntil(() => occurrences().every((element) => element.textContent === '40'))
    expect(desktopHost.saveExecutionManifest).toHaveBeenCalledTimes(1)
    const pending = pendingStep()
    const execute = vi.mocked(desktopHost.executeKernel).getMockImplementation()!
    vi.mocked(desktopHost.executeKernel).mockImplementationOnce(async (request) => {
      await pending.promise
      return execute({ ...request, code: 'publish("measurement", 99)' })
    })
    const button = command === 'cell' ? row.querySelector<HTMLButtonElement>('.run-button')!
      : [...container.querySelectorAll<HTMLButtonElement>('.computation-project-actions button')].find((item) => item.textContent === 'Run all cells')!
    await act(async () => button.click())
    await settleUntil(() => vi.mocked(desktopHost.executeKernel).mock.calls.length === 2)
    const details = row.querySelector<HTMLDetailsElement>('details')!
    if (!details.open) await act(async () => details.querySelector('summary')!.click())
    await settleUntil(() => Boolean(row.querySelector('.cm-editor')))
    const editor = CodeMirrorView.findFromDOM(row.querySelector<HTMLElement>('.cm-editor')!)!
    const edited = 'publish("measurement", 42)'
    await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: edited } }))
    const save = [...row.querySelectorAll('button')].find((item) => item.textContent === 'Save source')!
    await act(async () => save.click())
    await settleUntil(() => save.disabled)
    await act(async () => pending.finish())
    await settleUntil(() => container.querySelector('.code-workspace-drawer')?.textContent?.includes('The code changed during execution.') ?? false)
    expect(occurrences().map((element) => element.textContent)).toEqual(['40', '40'])
    expect(occurrences().every((element) => element.dataset.status !== 'current')).toBe(true)
    expect(desktopHost.saveExecutionManifest).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('All results are up to date.')
  })

  it('edits setup source in the code panel without exposing it in the manuscript', async () => {
    await openCodeWorkspace()
    const setupSelector = '.execution-cell-row[data-cell-id="py-setup"]'
    await settleUntil(() => Boolean(container.querySelector(`${setupSelector} .cm-editor`)))
    const setupRow = container.querySelector<HTMLElement>(setupSelector)!
    const codeView = CodeMirrorView.findFromDOM(setupRow.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => codeView.dispatch({ changes: { from: codeView.state.doc.length, insert: '\nthreshold = 2' } }))
    expect(setupRow.textContent).toContain('Unsaved source changes')
    expect(codeView.state.doc.toString()).toContain('threshold = 2')
    expect(container.querySelector('.structured-code-cell[data-dm-id="py-setup"]')).toBeNull()
  })

  it('adds a reproducible table through Insert instead of duplicating insertion controls in setup', async () => {
    await openCodeWorkspace()
    expect([...container.querySelectorAll<HTMLButtonElement>('.code-workspace-drawer button')].some((button) => button.textContent?.includes('Add reproducible table'))).toBe(false)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Code and computation"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.format-toolbar [aria-label="Insert"]')!.click())
    const addTable = [...container.querySelectorAll<HTMLButtonElement>('.toolbar-insert-menu button')].find((button) => button.textContent?.includes('Reproducible table'))!
    expect(addTable).toBeTruthy()
    await act(async () => addTable.click())

    await settleUntil(() => Boolean(container.querySelector('[aria-labelledby="insert-block-title"]')))
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

  it('creates a computed value calculation from its insertion dialog without requiring shared setup or running code', async () => {
    await act(async () => appRoot.unmount())
    const emptySource = '# Findings\n\nInsert a computed result here.\n'
    vi.mocked(desktopHost.readDocument).mockResolvedValue({ path: 'paper.qmd', content: emptySource, hash: 'document-old', modifiedMs: 1 })
    vi.mocked(desktopHost.executeKernel).mockClear()
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App />))
    await settleUntil(() => Boolean(container.querySelector('.structured-editor-content')?.textContent?.includes('Insert a computed result here.')))
    await act(async () => container.querySelector<HTMLButtonElement>('.format-toolbar [aria-label="Insert"]')!.click())
    const computed = [...container.querySelectorAll<HTMLButtonElement>('.toolbar-insert-menu button')].find((button) => button.textContent?.includes('Computed value'))!
    await act(async () => computed.click())
    let dialog = container.querySelector<HTMLElement>('[aria-labelledby="insert-block-title"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('Insert computed value')
    const create = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Create a calculation…')!
    await act(async () => create.click())
    dialog = container.querySelector<HTMLElement>('[aria-labelledby="insert-block-title"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('Create a value calculation')
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    await settle(950)
    expect(container.querySelector('.code-workspace-drawer')?.textContent).toContain('Computed values')
    const saved = vi.mocked(desktopHost.saveDocument).mock.calls.at(-1)![0].content
    expect(saved).toContain('output="values"')
    expect(saved).not.toContain('role="setup"')
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('waits for explicit setup even when the project has remembered trust', async () => {
    await act(async () => appRoot.unmount())
    localStorage.setItem('draftmatter.trusted-project-roots.v1', JSON.stringify([rootPath]))
    vi.mocked(desktopHost.executionTrustStatus).mockReset().mockResolvedValue({ trusted: false, scope: 'session', warning: 'not trusted in the new host session' })
    vi.mocked(desktopHost.trustProjectForSession).mockClear()
    vi.mocked(desktopHost.listJuliaPackages).mockClear()
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<App />))
    await settle(420)
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()
    expect(desktopHost.listJuliaPackages).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.trustProjectForSession).not.toHaveBeenCalled()
    await prepareEnvironments()
    await settleUntil(() => vi.mocked(desktopHost.listJuliaPackages).mock.calls.length > 0
      && container.querySelector('.rail-terminal-button')?.getAttribute('data-label') === 'Terminal · Ready')

    expect(desktopHost.trustProjectForSession).toHaveBeenCalledWith(rootPath, 'run-project-code-with-user-permissions')
    expect(desktopHost.listJuliaPackages).toHaveBeenCalledWith(rootPath, expect.any(String))
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-labelledby="execution-trust-title"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[aria-label="Shared kernel terminal"]')?.parentElement?.hidden).toBe(true)
    expect(container.querySelector('.rail-terminal-button')?.getAttribute('data-label')).toBe('Terminal · Ready')
  })

  it('keeps the citation launcher in the writing toolbar in a desktop project', async () => {
    const launcher = container.querySelector<HTMLButtonElement>('.toolbar-cite-button')
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
    await prepareEnvironments()
    await settleUntil(() => vi.mocked(desktopHost.setExecutionPreferences).mock.calls.some(([, preferences]) => preferences.julia?.kernel === 'julia-draftmatter-fixture'))

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
    await openCodeWorkspace()
    await checkLanguage('Julia')
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
    await openCodeWorkspace()
    const juliaCell = container.querySelector<HTMLElement>('.execution-cell-row[data-cell-id="jl-report"]')!
    await act(async () => juliaCell.querySelector<HTMLButtonElement>('.run-button')!.click())
    await settleUntil(() => container.querySelector('[aria-label="Shared kernel terminal"]')?.textContent?.includes('jl-report failed') ?? false)

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
    expect(container.querySelector('[aria-label="Shared kernel terminal"] [role="tab"][aria-selected="true"]')?.textContent).toContain('Julia')
    expect(container.querySelector('[aria-label="Shared kernel terminal"]')?.textContent).toContain('Figure at Makie/src/figureplotting.jl:117')
  })

  it('clean-runs setup first, restarts every language kernel, and never materializes setup output', async () => {
    await openCodeWorkspace()
    const findCleanRun = () => [...container.querySelectorAll<HTMLButtonElement>('.computation-project-actions button')]
      .find((button) => button.textContent?.includes('Run all cells'))
    await settleUntil(() => Boolean(findCleanRun()))
    const cleanRun = findCleanRun()!
    expect(cleanRun.title).toBe('Start fresh sessions and run every code cell to update computed values, figures, and tables.')
    expect(container.textContent).not.toContain('All results are up to date.')
    await act(async () => cleanRun.click())
    await settleUntil(() => container.querySelector('.run-all-feedback')?.textContent?.includes('All results are up to date.') ?? false)
    expect(container.querySelector('.run-all-feedback')?.textContent).toContain('4 succeeded · 0 failed · 0 skipped')

    expect(vi.mocked(desktopHost.restartKernel).mock.calls.map(([language]) => language)).toEqual(['python', 'r', 'julia'])
    expect(vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.cellId)).toEqual(['py-setup', 'py-value', 'r-model', 'jl-report'])
    await settleUntil(() => vi.mocked(desktopHost.saveDocument).mock.calls.some(([request]) => request.content.includes('dm-output:start')))
    const savedSources = vi.mocked(desktopHost.saveDocument).mock.calls.map(([request]) => request.content)
    expect(savedSources.join('\n')).not.toContain('dm-output:start cell="py-setup"')

    const setupRow = container.querySelector<HTMLElement>('.execution-cell-row[data-cell-id="py-setup"]')!
    const editor = CodeMirrorView.findFromDOM(setupRow.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\nbaseline = 41' } }))
    const save = [...setupRow.querySelectorAll('button')].find((button) => button.textContent?.includes('Save source'))!
    await act(async () => save.click())
    await settleUntil(() => !container.textContent?.includes('All results are up to date.'))
  })

  it('uses the same run from export and opens the cell that failed', async () => {
    vi.mocked(desktopHost.executeKernel).mockRejectedValueOnce(new Error('Fixture computation failed'))
    const exportButton = container.querySelector<HTMLButtonElement>('button[aria-label="Export"]')!
    await act(async () => exportButton.click())
    const run = [...container.querySelectorAll<HTMLButtonElement>('.export-menu button')].find((button) => button.textContent === 'Run all cells')!
    expect(run.title).toBe('Start fresh sessions and run every code cell to update computed values, figures, and tables.')
    await act(async () => run.click())
    await settleUntil(() => Boolean(container.querySelector('.export-menu .run-all-feedback button')))
    const feedback = container.querySelector('.export-menu .run-all-feedback')!
    expect(feedback.textContent).toContain('0 succeeded · 1 failed · 3 skipped')
    expect(feedback.textContent).not.toContain('up to date')
    expect(desktopHost.executeKernel).toHaveBeenCalledTimes(1)
    const goTo = feedback.querySelector('button')!
    expect(goTo.textContent).toContain('py-setup')
    await act(async () => goTo.click())
    await settleUntil(() => Boolean(container.querySelector('.code-workspace-drawer .execution-cell-row[data-cell-id="py-setup"] details[open]')))
    expect(container.querySelector('.export-menu')).toBeNull()
    expect(container.querySelector('.code-workspace-drawer')?.textContent).toContain('Fixture computation failed')
  })

  it('runs the selected toolbar scope and defaults to the clean run of all cells', async () => {
    const controls = container.querySelector('.topbar-run-cells')!
    const play = controls.querySelector<HTMLButtonElement>('.run-cells-play')!
    const scope = controls.querySelector<HTMLButtonElement>('.run-cells-scope')!
    const executed = () => vi.mocked(desktopHost.executeKernel).mock.calls.map(([request]) => request.cellId)

    expect(play.getAttribute('aria-label')).toBe('Run all cells')
    await act(async () => scope.click())
    const options = controls.querySelector('[aria-label="Cells to run"]')!
    expect([...options.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['All cells', 'Python', 'R', 'Julia'])
    expect(options.querySelector('[aria-pressed="true"]')?.textContent).toBe('All cells')
    await act(async () => [...options.querySelectorAll('button')].find((button) => button.textContent === 'Julia')!.click())
    expect(controls.querySelector('.run-cells-options')).toBeNull()
    expect(play.getAttribute('aria-label')).toBe('Run all Julia cells')
    expect(executed()).toEqual([])
    await act(async () => play.click())
    await settleUntil(() => executed().length === 1 && !play.disabled)
    expect(executed()).toEqual(['jl-report'])
    expect(desktopHost.restartKernel).not.toHaveBeenCalled()

    await act(async () => scope.click())
    await act(async () => controls.querySelector<HTMLButtonElement>('.run-cells-options button')!.click())
    await act(async () => play.click())
    await settleUntil(() => executed().length === 5 && !play.disabled)
    expect(executed().slice(1)).toEqual(['py-setup', 'py-value', 'r-model', 'jl-report'])
    expect(vi.mocked(desktopHost.restartKernel).mock.calls.map(([language]) => language)).toEqual(['python', 'r', 'julia'])
  })

  async function checkLanguage(label: 'Python' | 'R' | 'Julia') {
    await openCodeWorkspace()
    await settleUntil(() => !container.querySelector<HTMLButtonElement>(`[aria-label="Check ${label}"]`)!.disabled)
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Check ${label}"]`)!.click())
    await settleUntil(() => container.querySelector(`[aria-label="Check ${label}"]`)?.textContent === 'Check')
  }

  it('checks only the requested language and shows its options inline without running manuscript code', async () => {
    await checkLanguage('Python')
    expect(vi.mocked(desktopHost.probeRuntime).mock.calls.map(([language]) => language)).toEqual(['python'])
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-labelledby="execution-environment-title"]')).toBeNull()
    expect(container.querySelector('[aria-label="Python environment controls"]')?.textContent).toContain('Python · DraftMatter')
    expect(container.querySelector('[aria-label="Python Jupyter kernel"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="R Jupyter kernel"]')).toBeNull()
    expect(container.querySelector('[aria-label="R environment options"]')?.textContent).not.toContain('Kernel detected')
    expect(container.querySelector('[aria-label="Julia environment options"]')?.textContent).not.toContain('Kernel detected')
  })

  it('keeps language checks and setup locked until a separate trust confirmation, which runs nothing', async () => {
    let trusted = false
    vi.mocked(desktopHost.executionTrustStatus).mockImplementation(async () => ({ trusted, scope: 'session', warning: 'Local code can read files.' }))
    vi.mocked(desktopHost.trustProjectForSession).mockImplementation(async () => { trusted = true; return { trusted, scope: 'session', warning: 'trusted' } })
    await openCodeWorkspace()
    await settle()
    const check = container.querySelector<HTMLButtonElement>('[aria-label="Check Python"]')!
    expect(check.disabled).toBe(true)
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Trust this project')!.click())
    expect(container.querySelector('[aria-labelledby="execution-trust-title"] h2')?.textContent).toBe('Trust this project?')
    expect(desktopHost.trustProjectForSession).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-labelledby="execution-trust-title"] .primary-button')!.click())
    expect(check.disabled).toBe(false)
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()
    expect(desktopHost.discoverJupyterKernels).not.toHaveBeenCalled()
    expect(desktopHost.setupKernelIntegration).not.toHaveBeenCalled()
    expect(desktopHost.installCodeFormatter).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    await act(async () => check.click())
    await settleUntil(() => container.querySelector('[aria-label="Python Jupyter kernel"]') !== null)
    expect(vi.mocked(desktopHost.probeRuntime).mock.calls.map(([language]) => language)).toEqual(['python'])
  })

  it('installs formatters from the selected language options with concise environment-specific labels', async () => {
    await checkLanguage('Python')
    let options = container.querySelector<HTMLElement>('[aria-label="Python environment controls"]')!
    await settleUntil(() => options.textContent?.includes('Ruff 0.12.0 is available') ?? false)
    expect(options.textContent).not.toContain('bundled')
    const repair = [...options.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Repair Ruff')!
    await act(async () => repair.click())
    await settleUntil(() => vi.mocked(desktopHost.installCodeFormatter).mock.calls.length === 1)
    expect(desktopHost.installCodeFormatter).toHaveBeenCalledWith(expect.objectContaining({ root: rootPath, language: 'python' }), expect.any(String))
    await checkLanguage('R')
    options = container.querySelector<HTMLElement>('[aria-label="R environment controls"]')!
    await settleUntil(() => options.textContent?.includes('styler 1.10.3 is available') ?? false)
    expect(options.textContent).not.toContain('bundled')
    expect([...options.querySelectorAll('button')].map((button) => button.textContent)).toEqual(expect.arrayContaining(['Restart R', 'Terminate R']))
    expect(options.textContent).not.toContain('Restart Python')
  })

  it('installs JuliaFormatter directly without opening package management or executing manuscript cells', async () => {
    vi.mocked(desktopHost.addJuliaPackage).mockResolvedValueOnce({ packages: [{ name: 'JuliaFormatter', version: '2.10.1', kind: 'package' }], projectFile: true, manifestFile: true })
    await checkLanguage('Julia')
    const options = container.querySelector<HTMLElement>('[aria-label="Julia environment controls"]')!
    expect(options.textContent).toContain('Install JuliaFormatter into the selected environment.')
    expect(options.textContent).not.toContain('application size')
    await act(async () => [...options.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Install JuliaFormatter')!.click())
    await settleUntil(() => options.textContent?.includes('JuliaFormatter is available') ?? false)
    expect(desktopHost.addJuliaPackage).toHaveBeenCalledWith({ root: rootPath, name: 'JuliaFormatter' }, expect.any(String))
    expect(container.querySelector('[aria-labelledby="julia-packages-title"]')).toBeNull()
    expect(desktopHost.listJuliaPackages).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('ignores a second Check while the first request is still verifying project trust', async () => {
    await openCodeWorkspace()
    await settleUntil(() => !container.querySelector<HTMLButtonElement>('[aria-label="Check Python"]')!.disabled)
    const gate = pendingStep()
    const trustCalls = vi.mocked(desktopHost.executionTrustStatus).mock.calls.length
    vi.mocked(desktopHost.executionTrustStatus).mockImplementationOnce(async () => {
      await gate.promise
      return { trusted: true, scope: 'session', warning: 'trusted' }
    })
    const check = container.querySelector<HTMLButtonElement>('[aria-label="Check Python"]')!
    await act(async () => { check.click(); check.click() })
    expect(desktopHost.executionTrustStatus).toHaveBeenCalledTimes(trustCalls + 1)
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()
    expect(check.disabled).toBe(true)
    await act(async () => gate.finish())
    await settleUntil(() => !check.disabled)
    expect(vi.mocked(desktopHost.probeRuntime).mock.calls.map(([language]) => language)).toEqual(['python'])
  })

  it('can retry a failed language probe without affecting the other languages or manuscript', async () => {
    vi.mocked(desktopHost.probeRuntime).mockRejectedValueOnce(new Error('The Python interpreter could not be checked.'))
    vi.mocked(desktopHost.discoverJupyterKernels).mockResolvedValueOnce({ health: 'missing', kernels: [], searchedLocations: [] })
    await checkLanguage('Python')
    expect(container.querySelector('[aria-label="Python environment options"]')?.textContent).toContain('Needs attention')
    expect(container.textContent).toContain('The Python interpreter could not be checked.')
    await checkLanguage('Python')
    expect(container.querySelector('[aria-label="Python environment options"]')?.textContent).toContain('Kernel detected')
    expect(vi.mocked(desktopHost.probeRuntime).mock.calls.map(([language]) => language)).toEqual(['python', 'python'])
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('locks language controls immediately after project trust is forgotten', async () => {
    vi.spyOn(desktopHost, 'revokeProjectTrust').mockResolvedValue({ trusted: false, scope: 'session', warning: 'not trusted' })
    await checkLanguage('Python')
    const forget = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Forget project trust')!
    await act(async () => forget.click())
    expect(desktopHost.revokeProjectTrust).toHaveBeenCalledWith(rootPath)
    expect(container.querySelector('[aria-label="Check Python"]')?.matches(':disabled')).toBe(true)
    expect(container.querySelector('[aria-label="Python Jupyter kernel"]')?.matches(':disabled')).toBe(true)
    expect(container.querySelector('[aria-label="Python environment controls"] button')?.matches(':disabled')).toBe(true)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('keeps terminal history and shared kernel status when the bottom panel closes', async () => {
    const open = container.querySelector<HTMLButtonElement>('[aria-label^="Open shared kernel terminal"]')
    if (open) await act(async () => open.click())
    const findPythonTab = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Python'))
    await settleUntil(() => Boolean(findPythonTab()))
    await act(async () => findPythonTab()!.click())
    await settleUntil(() => Boolean(container.querySelector('[aria-label="Python terminal input"]')))
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Python terminal input"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'shared_value = 42')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await settle()
    expect(container.querySelector('[aria-label="Shared kernel terminal"] [role="tab"][aria-selected="true"]')?.textContent).toContain('ready')
    expect(container.textContent).toContain('Interactive · Run all cells will restart this kernel')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close kernel terminal"]')!.click())
    const reopen = container.querySelector<HTMLButtonElement>('[aria-label*="interactive state present"]')!
    expect(reopen).toBeTruthy()
    await act(async () => reopen.click())
    expect(container.textContent).toContain('shared_value = 42')
    expect(container.textContent).toContain('Interactive · Run all cells will restart this kernel')
  })
})
