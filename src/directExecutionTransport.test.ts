import { describe, expect, it, vi } from 'vitest'
import type { ExecutionRequest, RawDirectExecution } from './executionProvider'
import { createDesktopDirectExecutionTransport, type DirectExecutionHost } from './directExecutionTransport'

const request: ExecutionRequest = {
  cellId: 'table-growth',
  language: 'r',
  code: 'write.csv(data.frame(x=1), "tables/growth.csv")',
  workingDirectory: '/project',
  attributes: { produces: 'tables/growth.csv' },
  inputs: [{ path: 'data/input.csv', hash: `sha256:${'a'.repeat(64)}` }],
}

const raw: RawDirectExecution = {
  exitCode: 0,
  interrupted: false,
  stdout: '',
  stderr: '',
  errors: [],
  mime: [],
  artifacts: [{ path: 'tables/growth.csv', bytes: 8, hash: `sha256:${'b'.repeat(64)}`, mediaType: 'text/csv' }],
  environment: { identity: '/runtime/Rscript', version: 'R scripting front-end version 4.5.1', details: { mode: 'script-artifact' } },
  providerRunId: 'direct:fixture',
}

function host(available = true): DirectExecutionHost {
  return {
    available,
    executeDirect: vi.fn(async () => raw),
    interruptDirect: vi.fn(async () => true),
    restartDirect: vi.fn(async () => false),
    terminateDirect: vi.fn(async () => false),
  }
}

describe('desktop direct execution transport', () => {
  it('maps only the typed execution request to the native host', async () => {
    const desktop = host()
    const transport = createDesktopDirectExecutionTransport(desktop)

    await expect(transport.execute(request)).resolves.toEqual(raw)
    expect(desktop.executeDirect).toHaveBeenCalledWith({
      root: '/project',
      cellId: 'table-growth',
      language: 'r',
      code: request.code,
      attributes: { produces: 'tables/growth.csv' },
      inputs: request.inputs,
    })
  })

  it('turns an abort signal into a native interrupt', async () => {
    const desktop = host()
    let finish: ((value: RawDirectExecution) => void) | undefined
    vi.mocked(desktop.executeDirect).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const transport = createDesktopDirectExecutionTransport(desktop)
    const controller = new AbortController()
    const execution = transport.execute(request, controller.signal)
    await vi.waitFor(() => expect(desktop.executeDirect).toHaveBeenCalled())

    controller.abort()
    await vi.waitFor(() => expect(desktop.interruptDirect).toHaveBeenCalledWith('r'))
    finish?.(raw)
    await execution
  })

  it('never invokes a process command in browser mode', async () => {
    const browser = host(false)
    const transport = createDesktopDirectExecutionTransport(browser)

    await expect(transport.execute(request)).rejects.toThrow('outside the desktop app')
    await transport.interrupt('python')
    await transport.restart('r')
    await transport.terminate('julia')
    expect(browser.executeDirect).not.toHaveBeenCalled()
    expect(browser.interruptDirect).not.toHaveBeenCalled()
    expect(browser.restartDirect).not.toHaveBeenCalled()
    expect(browser.terminateDirect).not.toHaveBeenCalled()
  })
})
