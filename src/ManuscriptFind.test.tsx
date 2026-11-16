// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManuscriptFind } from './ManuscriptFind'
import { DEFAULT_MANUSCRIPT_SEARCH_SETTINGS } from './manuscriptSearch'

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
  it('exposes the three pressed-state options and expands replacement without losing the query', async () => {
    const settings = vi.fn(), replace = vi.fn(), replaceAll = vi.fn(), next = vi.fn()
    await act(async () => root.render(<ManuscriptFind query="leaf" result={{ query: 'leaf', current: 1, total: 4, replaceable: 3, currentReplaceable: true }} settings={{ ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS }} onSettingsChange={settings} replacement="bud" onReplace={replace} onReplaceAll={replaceAll} onQueryChange={vi.fn()} onNext={next} onPrevious={vi.fn()} onClose={vi.fn()} />))
    for (const [label, option] of [['Match case', 'matchCase'], ['Whole words', 'wholeWord'], ['Use regular expression', 'regex']] as const) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      expect(button.getAttribute('aria-pressed')).toBe('false')
      await act(async () => button.click())
      expect(settings).toHaveBeenLastCalledWith({ ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, [option]: true })
    }
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show replace"]')!.click())
    expect(container.querySelector('[aria-label="Hide replace"]')?.getAttribute('aria-expanded')).toBe('true')
    const replacement = container.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!
    expect(replacement.value).toBe('bud')
    await act(async () => replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(replace).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled()
    const all = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Replace all')!
    await act(async () => all.click())
    expect(replaceAll).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Edit the title directly')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Find in document"]')!.value).toBe('leaf')
  })
  it('announces malformed regex and disables replacement on a protected current match', async () => {
    const props = { query: '[', onQueryChange: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn(), onClose: vi.fn(), onReplace: vi.fn(), onReplaceAll: vi.fn() }
    await act(async () => root.render(<ManuscriptFind {...props} result={{ query: '[', current: 0, total: 0, error: 'Invalid expression' }} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Invalid expression')
    expect(container.querySelector('input')?.getAttribute('aria-invalid')).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show replace"]')!.click())
    expect([...container.querySelectorAll<HTMLButtonElement>('.manuscript-replace-action')].every((button) => button.disabled)).toBe(true)
    await act(async () => root.render(<ManuscriptFind {...props} result={{ query: 'leaf', current: 1, total: 3, replaceable: 2, currentReplaceable: false }} />))
    expect(container.querySelector<HTMLButtonElement>('.manuscript-replace-action')!.disabled).toBe(true)
    expect(container.querySelectorAll<HTMLButtonElement>('.manuscript-replace-action')[1].disabled).toBe(false)
    await act(async () => root.render(<ManuscriptFind {...props} canReplace={false} result={{ query: 'leaf', current: 1, total: 3, replaceable: 2, currentReplaceable: true }} />))
    expect(container.querySelector<HTMLInputElement>('[aria-label="Replace with"]')!.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.manuscript-replace-action')].every((button) => button.disabled)).toBe(true)
  })
})
