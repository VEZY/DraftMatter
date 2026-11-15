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

  it('distinguishes a detected installation from a kernel and does no automatic setup', async () => {
    const configure = vi.fn(), prepare = vi.fn(), setup = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel runtimes={runtimes} onConfigureEnvironments={configure} onPrepareEnvironments={prepare} onCreateSetup={setup} />))
    expect(container.textContent).toContain('Installed only')
    expect(container.textContent).toContain('Not installed')
    expect(container.textContent).toContain('Not checked')
    expect(container.textContent).not.toContain('Project ready')
    expect(container.textContent).toContain('standalone calculation without creating a setup cell')
    expect(configure).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Execution environments and options"]')!.click())
    expect(configure).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('shows detected kernels as provisional and makes a shared setup explicitly optional', async () => {
    const setup = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel runtimes={[{ ...runtimes[0], status: 'ready' }]} onConfigureEnvironments={vi.fn()} onCreateSetup={setup} setupSource={[]} computedValueSource={[]} manuscriptSource={[]} />))
    expect(container.textContent).toContain('Kernel detected')
    expect(container.textContent).toContain('checked again when you run a calculation')
    expect(container.querySelector('#computation-shared-setup-heading')?.textContent).toBe('Shared setup Optional')
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Add shared setup')!
    await act(async () => add.click())
    expect(setup).toHaveBeenCalledOnce()
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).not.toEqual(expect.arrayContaining(['Add values', 'Add figure from code', 'Add reproducible table']))
  })

  it('keeps existing setup, calculations and run actions reachable without duplicating insertions', async () => {
    const run = vi.fn()
    await act(async () => root.render(<ComputationSetupPanel runtimes={runtimes} onConfigureEnvironments={vi.fn()} onCreateSetup={vi.fn()}
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

  it('reports in-progress checks and blocks duplicate environment preparation', async () => {
    await act(async () => root.render(<ComputationSetupPanel runtimes={runtimes} discovering preparing onConfigureEnvironments={vi.fn()} onPrepareEnvironments={vi.fn()} />))
    expect(container.querySelectorAll('.computation-runtime-status.checking')).toHaveLength(3)
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Preparing environments…')?.disabled).toBe(true)
  })
})
