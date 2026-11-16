// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecoveryAutosave } from './useRecoveryAutosave'

describe('changed manuscript recovery capture', () => {
  let root: Root
  let container: HTMLDivElement
  const captured = vi.fn<(source: string) => boolean>()
  const capturedKeys = vi.fn<(key: string) => void>()
  function Fixture({ source, documentKey = 'paper-a', paused = false }: { source: string; documentKey?: string; paused?: boolean }) {
    useRecoveryAutosave({ documentKey, source, paused, onSnapshot: (value, key) => { capturedKeys(key); return captured(value) } })
    return null
  }
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    captured.mockReset().mockReturnValue(true)
    capturedKeys.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  async function render(source: string, paused = false, documentKey = 'paper-a') {
    await act(async () => root.render(<Fixture source={source} paused={paused} documentKey={documentKey} />))
  }
  async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)) }

  it('captures after a pause and creates nothing while unchanged or after an edit is undone', async () => {
    await render('Initial manuscript')
    await advance(1800)
    expect(captured.mock.calls).toEqual([['Initial manuscript']])
    await advance(120_000)
    await render('Initial manuscript')
    expect(captured).toHaveBeenCalledTimes(1)
    await render('Temporary edit')
    await advance(1000)
    await render('Initial manuscript')
    await advance(60_000)
    expect(captured).toHaveBeenCalledTimes(1)
  })

  it('captures fresh text within a minute even when typing never pauses for 1.8 seconds', async () => {
    for (let second = 0; second < 60; second++) {
      await render(`Typing ${second}`)
      await advance(1000)
    }
    expect(captured.mock.calls).toEqual([['Typing 59']])
    await render('Final sentence')
    await advance(1800)
    expect(captured.mock.calls).toEqual([['Typing 59'], ['Final sentence']])
    await advance(120_000)
    expect(captured).toHaveBeenCalledTimes(2)
  })

  it('never writes while browsing history and does not carry a deadline into a different paper', async () => {
    await render('Paper A')
    await advance(1000)
    await render('Paper A', true)
    await advance(120_000)
    expect(captured).not.toHaveBeenCalled()
    await render('Paper B', false, 'paper-b')
    await advance(1799)
    expect(captured).not.toHaveBeenCalled()
    await advance(1)
    expect(captured.mock.calls).toEqual([['Paper B']])
    expect(capturedKeys.mock.calls).toEqual([['paper-b']])
  })

  it('keeps the history pause safe on resume and does not loop on a capacity failure', async () => {
    captured.mockReturnValue(false)
    await render('Unsaved text', true)
    await advance(70_000)
    await render('Unsaved text')
    await advance(0)
    expect(captured.mock.calls).toEqual([['Unsaved text']])
    await advance(120_000)
    expect(captured).toHaveBeenCalledTimes(1)
    captured.mockReturnValue(true)
    await render('Another edit')
    await advance(1800)
    expect(captured).toHaveBeenLastCalledWith('Another edit')
  })
})
