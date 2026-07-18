// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { juliaTerminalCode, juliaTerminalPrompt, KernelConsole, stripTerminalControlSequences } from './KernelConsole'
import type { NormalizedExecutionResult } from './kernelExecution'

const statuses = { python: 'not-started', r: 'not-started', julia: 'not-started' } as const
const restartEpochs = { python: 0, r: 0, julia: 0 }

const result: NormalizedExecutionResult = {
  cellId: 'console-python-1',
  language: 'python',
  status: 'succeeded',
  streams: [{ sequence: 0, name: 'stdout', text: 'shared state\n' }],
  errors: [],
  mime: [{
    data: {
      'application/vnd.draftmatter.published-value+json': {
        version: 1,
        name: 'mean_height',
        value: 12.34,
        unit: 'cm',
        formatting: { digits: 1 },
      },
    },
    metadata: {},
  }],
  artifacts: [],
  environment: { language: 'python', identity: 'python3', fingerprint: `sha256:${'a'.repeat(64)}` },
  hashes: {
    code: `sha256:${'b'.repeat(64)}`,
    inputs: `sha256:${'c'.repeat(64)}`,
    environment: `sha256:${'a'.repeat(64)}`,
    result: `sha256:${'d'.repeat(64)}`,
  },
  provenance: { sessionGeneration: 1, executionSequence: 1 },
  startedAt: '2026-07-17T08:00:00.000Z',
  finishedAt: '2026-07-17T08:00:00.010Z',
  durationMs: 10,
}

describe('KernelConsole', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('maps Julia REPL modes to commands executed inside the shared kernel', () => {
    expect(juliaTerminalPrompt('pkg', 'DraftMatter')).toBe('(DraftMatter) pkg>')
    expect(juliaTerminalCode('pkg', 'status')).toBe('import Pkg; Pkg.REPLMode.pkgstr("status")')
    expect(juliaTerminalCode('shell', 'echo "$HOME"')).toBe('Base.repl_cmd(Core.eval(Main, :(Base.cmd_gen($(Base.shell_parse("echo \\"\\$HOME\\"")[1])))), stdout)')
    expect(juliaTerminalCode('help', 'DataFrame')).toBe('import REPL; REPL.helpmode(stdout, "DataFrame", Main)')
  })

  it('removes ANSI styling emitted by Julia Pkg before rendering it', () => {
    expect(stripTerminalControlSequences('\u001b[32m\u001b[1mStatus\u001b[22m\u001b[39m `Project.toml`'))
      .toBe('Status `Project.toml`')
  })

  it('runs multiline code in the active shared kernel and previews published values', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const execute = vi.fn(async () => result)
    const root = createRoot(host)
    await act(async () => {
      root.render(<KernelConsole
        languages={['python', 'r', 'julia']}
        statuses={statuses}
        restartEpochs={restartEpochs}
        onExecute={execute}
        onInterrupt={vi.fn()}
        onRestart={vi.fn()}
        onStatusChange={vi.fn()}
        onDirtyChange={vi.fn()}
        onPromoteSetup={vi.fn()}
        onClose={vi.fn()}
      />)
    })

    const input = host.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'mean_height = 12.34\npublish("mean_height", mean_height, unit="cm", digits=1)')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(execute).toHaveBeenCalledWith('python', expect.stringContaining('publish("mean_height"'))
    expect(host.textContent).toContain('shared state')
    expect(host.textContent).toContain('{{mean_height}}')
    expect(host.textContent).toContain('12.3 cm')
    expect(host.textContent).toContain('Interactive · clean run will restart this kernel')
    await act(async () => root.unmount())
  })

  it('shows project setup progress as a terminal tab', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<KernelConsole
        languages={['julia']}
        statuses={statuses}
        restartEpochs={restartEpochs}
        projectActivity={{ id: 'setup-1', title: 'Checking the Julia project', status: 'succeeded', output: '$ julia --project=.\nProject is ready.\n', language: 'julia' }}
        onExecute={async () => ({ ...result, language: 'julia' })}
        onInterrupt={vi.fn()}
        onRestart={vi.fn()}
        onStatusChange={vi.fn()}
        onDirtyChange={vi.fn()}
        onPromoteSetup={vi.fn()}
        onClose={vi.fn()}
      />)
    })

    expect(host.querySelector<HTMLButtonElement>('.kernel-project-tab')?.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('.kernel-project-activity')?.textContent).toContain('Checking the Julia project')
    expect(host.querySelector('.kernel-project-activity')?.textContent).toContain('Project is ready.')
    await act(async () => host.querySelector<HTMLButtonElement>('.kernel-project-activity-footer button')!.click())
    expect(host.textContent).toContain('Julia REPL · shared document kernel')
    await act(async () => root.unmount())
  })

  it('promotes the most recent command to a setup cell', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const promote = vi.fn()
    const root = createRoot(host)
    await act(async () => {
      root.render(<KernelConsole
        languages={['julia']}
        statuses={statuses}
        restartEpochs={restartEpochs}
        onExecute={async () => ({ ...result, language: 'julia' })}
        onInterrupt={vi.fn()}
        onRestart={vi.fn()}
        onStatusChange={vi.fn()}
        onDirtyChange={vi.fn()}
        onPromoteSetup={promote}
        onClose={vi.fn()}
      />)
    })
    expect(host.textContent).toContain('julia --project=.')
    expect(host.textContent).toContain('same live session as document cells')
    const input = host.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'using Statistics')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const setup = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Make setup cell')!
    await act(async () => setup.click())
    expect(promote).toHaveBeenCalledWith('julia', 'using Statistics')
    await act(async () => root.unmount())
  })

  it('switches into Julia Pkg mode with ] and returns with Backspace', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const execute = vi.fn(async () => ({
      ...result,
      language: 'julia' as const,
      streams: [{ sequence: 0, name: 'stdout' as const, text: '\u001b[32m\u001b[1mStatus\u001b[22m\u001b[39m `Project.toml`\n' }],
    }))
    const root = createRoot(host)
    await act(async () => {
      root.render(<KernelConsole
        languages={['julia']}
        projectLabel="draftmatter"
        statuses={statuses}
        restartEpochs={restartEpochs}
        onExecute={execute}
        onInterrupt={vi.fn()}
        onRestart={vi.fn()}
        onStatusChange={vi.fn()}
        onDirtyChange={vi.fn()}
        onPromoteSetup={vi.fn()}
        onClose={vi.fn()}
      />)
    })

    const input = host.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, ']')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.textContent).toContain('(draftmatter) pkg>')
    expect(input.placeholder).toBe('Type a Pkg command…')

    await act(async () => {
      setter.call(input, 'status')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(execute).toHaveBeenCalledWith('julia', 'import Pkg; Pkg.REPLMode.pkgstr("status")')
    expect(host.textContent).toContain('(draftmatter) pkg>status')
    expect(host.textContent).toContain('Status `Project.toml`')
    expect(host.textContent).not.toContain('\u001b')

    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })))
    expect(host.querySelector('.kernel-terminal-command')?.textContent).toContain('julia>')
    await act(async () => root.unmount())
  })
})
