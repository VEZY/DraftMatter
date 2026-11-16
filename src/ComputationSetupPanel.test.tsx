// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputationSetupPanel, type ComputationRuntimeSummary } from './ComputationSetupPanel'

const runtimes: ComputationRuntimeSummary[] = [
  { language: 'python', label: 'Python', status: 'available', detail: 'Python 3' },
  { language: 'r', label: 'R', status: 'missing' },
  { language: 'julia', label: 'Julia', status: 'not-checked' },
]

describe('guided computation setup', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })

  it('offers a separate actionable Check for each language without automatic setup', async () => {
    const check = vi.fn(), prepare = vi.fn(), setup = vi.fn(), toggle = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel trusted runtimes={runtimes} onToggleLanguage={toggle} onCheckLanguage={check} onPrepareEnvironments={prepare} onCreateSetup={setup} />))
    expect(container.textContent).toContain('Installed only')
    expect(container.textContent).toContain('Not installed')
    expect(container.textContent).not.toContain('Not checked')
    expect(container.textContent).not.toContain('Project ready')
    expect(check).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Check Julia"]')!.click())
    expect(check).toHaveBeenCalledExactlyOnceWith('julia')
    expect(prepare).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Python environment options"]')!.click())
    expect(toggle).toHaveBeenCalledExactlyOnceWith('python')
    expect(container.querySelector('[aria-label="Execution environments and options"]')).toBeNull()
  })

  it('keeps execution and installation disabled before trust while documentation remains available', async () => {
    const check = vi.fn(), install = vi.fn(), run = vi.fn(), docs = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel runtimes={runtimes} onToggleLanguage={vi.fn()} onCheckLanguage={check} expandedLanguage="python"
      languageOptions={{ python: <button onClick={install}>Install Ruff</button> }}
      runControls={<button onClick={run}>Run Python</button>} onOpenDocumentation={docs}
      projectTrust={<button>Trust this project</button>}
    />))
    expect(container.querySelector('[aria-label="Check Python"]')?.matches(':disabled')).toBe(true)
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Install Ruff')?.matches(':disabled')).toBe(true)
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Run Python')?.matches(':disabled')).toBe(true)
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'How languages work')!.click())
    expect(docs).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('expands only the selected language in place and makes shared setup optional', async () => {
    const setup = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel trusted runtimes={[{ ...runtimes[0], status: 'ready' }, runtimes[1]]} onToggleLanguage={vi.fn()} onCheckLanguage={vi.fn()} expandedLanguage="r" languageOptions={{ python: <p>Python options</p>, r: <p>R options</p> }} onCreateSetup={setup} setupSource={[]} computedValueSource={[]} manuscriptSource={[]} />))
    expect(container.textContent).toContain('Kernel detected')
    expect(container.textContent).toContain('R options')
    expect(container.textContent).not.toContain('Python options')
    expect(container.querySelector('[aria-label="R environment options"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('#computation-shared-setup-heading')?.textContent).toBe('Shared setup Optional')
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Add shared setup')!
    await act(async () => add.click())
    expect(setup).toHaveBeenCalledOnce()
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).not.toEqual(expect.arrayContaining(['Add values', 'Add figure from code', 'Add reproducible table']))
  })

  it('keeps existing setup, calculations and run actions reachable without duplicating insertions', async () => {
    const run = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel trusted runtimes={runtimes} onToggleLanguage={vi.fn()} onCheckLanguage={vi.fn()} onCreateSetup={vi.fn()}
      setupSource={<textarea aria-label="Shared setup code" defaultValue="load shared data" />}
      computedValueSource={<textarea aria-label="Computed value calculation code" defaultValue="mean_height = 12" />}
      manuscriptSource={<button>Go to figure code</button>}
      runControls={<button onClick={run}>Run Python</button>}
      notices={<p role="status">All calculations are saved.</p>}
    />))
    expect(container.querySelector('[aria-label="Shared setup code"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Computed value calculation code"]')).not.toBeNull()
    expect(container.textContent).toContain('Insert → Computed value')
    expect(container.textContent).not.toContain('Add shared setup')
    expect(container.textContent).not.toContain('Published value')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Run project computations"] button')!.click())
    expect(run).toHaveBeenCalledOnce()
  })

  it('shows which language is being checked and blocks duplicate checks or preparation', async () => {
    await act(async () => root.render(<ComputationSetupPanel trusted runtimes={runtimes} discovering checkingLanguage="python" preparing onToggleLanguage={vi.fn()} onCheckLanguage={vi.fn()} onPrepareEnvironments={vi.fn()} />))
    expect(container.querySelectorAll('.computation-check-language.checking')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Check Python"]')?.textContent).toBe('Checking…')
    expect(container.querySelector('[aria-label="Check R"]')?.textContent).toBe('Check')
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Preparing environments…')?.disabled).toBe(true)
  })
})
