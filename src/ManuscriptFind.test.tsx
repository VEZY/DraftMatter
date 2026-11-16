// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManuscriptFind } from './ManuscriptFind'

describe('document find bar', () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.body.appendChild(document.createElement('div')); root = createRoot(container) })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })
  it('focuses the query, reports matches and supports Enter, Shift+Enter and Escape without submitting the document', async () => {
    const query = vi.fn(), next = vi.fn(), previous = vi.fn(), close = vi.fn()
    await act(async () => root.render(<ManuscriptFind query="leaf" result={{ query: 'leaf', current: 2, total: 4 }} onQueryChange={query} onNext={next} onPrevious={previous} onClose={close} />))
    const input = container.querySelector('input')!
    expect(document.activeElement).toBe(input)
    expect(container.querySelector('output')?.textContent).toBe('2 of 4')
    for (const [key, shift] of [['Enter', false], ['Enter', true], ['Escape', false]] as const) await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true })))
    expect(next).toHaveBeenCalledOnce(); expect(previous).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    expect(next).toHaveBeenCalledOnce()
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
    expect(close).toHaveBeenCalledOnce()
  })
})
