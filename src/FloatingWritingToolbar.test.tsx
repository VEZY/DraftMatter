// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatingWritingToolbar, readWritingToolbarPreferences, writingToolbarPosition, WRITING_TOOLBAR_KEY, type WritingToolbarPreferences } from './FloatingWritingToolbar'

let container: HTMLDivElement
let root: Root
const defaults: WritingToolbarPreferences = { pinned: false, dock: 'center', x: 8, y: 72 }

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const shell = () => container.querySelector<HTMLElement>('.floating-writing-toolbar-shell')!
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === name || item.textContent === name)!
async function render(expanded = false) {
  await act(async () => root.render(<FloatingWritingToolbar expanded={expanded}><button type="button">Cite</button></FloatingWritingToolbar>))
}
async function pointer(type: string, options: { clientX?: number; clientY?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  await act(async () => button('Move writing tools').dispatchEvent(event))
}

describe('floating writing tools', () => {
  it('starts hidden, reveals on hover or keyboard focus, and stays revealed for an open child menu', async () => {
    await render()
    expect(shell().dataset.visible).toBe('false')
    expect(button('Show writing tools')).not.toBeNull()
    await pointer('pointerover')
    expect(shell().dataset.visible).toBe('true')
    await act(async () => shell().dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
    expect(shell().dataset.visible).toBe('false')
    await act(async () => button('Cite').focus())
    expect(shell().dataset.visible).toBe('true')
    await act(async () => button('Cite').blur())
    expect(shell().dataset.visible).toBe('false')
    await render(true)
    expect(shell().dataset.visible).toBe('true')
    await render(false)
    expect(shell().dataset.visible).toBe('false')
  })

  it('pins the toolbar visibly across pointer exit and restores the preference on reopening', async () => {
    await render()
    await act(async () => button('Pin writing tools').click())
    expect(shell().dataset.pinned).toBe('true')
    expect(shell().dataset.visible).toBe('true')
    expect(button('Unpin writing tools').getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem(WRITING_TOOLBAR_KEY)!).pinned).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(shell().dataset.visible).toBe('true')
    await act(async () => button('Unpin writing tools').click())
    expect(shell().dataset.visible).toBe('false')
    expect(JSON.parse(localStorage.getItem(WRITING_TOOLBAR_KEY)!).pinned).toBe(false)
  })

  it('moves only by its handle, snaps to an edge, and restores the previous placement after pointer cancellation', async () => {
    await render()
    const initialTop = shell().style.top
    await pointer('pointerdown', { clientX: 300, clientY: 100 })
    await pointer('pointermove', { clientX: 150, clientY: 180 })
    expect(shell().dataset.dock).toBe('free')
    expect(Number.parseFloat(shell().style.top)).toBe(Number.parseFloat(initialTop) + 80)
    await pointer('pointerup', { clientX: 10, clientY: 180 })
    expect(shell().dataset.dock).toBe('left')
    expect(shell().style.left).toBe('8px')
    const saved = localStorage.getItem(WRITING_TOOLBAR_KEY)
    await pointer('pointerdown', { clientX: 10, clientY: 180 })
    await pointer('pointermove', { clientX: 300, clientY: 250 })
    expect(shell().dataset.dock).toBe('free')
    await pointer('pointercancel')
    expect(shell().dataset.dock).toBe('left')
    expect(localStorage.getItem(WRITING_TOOLBAR_KEY)).toBe(saved)
  })

  it('offers docking and arbitrary movement through the keyboard without dragging manuscript text', async () => {
    await render()
    await act(async () => button('Move writing tools').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })))
    expect(shell().dataset.dock).toBe('free')
    await act(async () => button('Position writing tools').click())
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('Dock left')
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement?.textContent).toBe('Center at top')
    await act(async () => button('Dock right').click())
    expect(shell().dataset.dock).toBe('right')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button('Position writing tools'))
    await act(async () => button('Move writing tools').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(shell().dataset.dock).toBe('center')
  })

  it('does not repeat layout reads when the parent manuscript rerenders', async () => {
    await render()
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    for (let index = 0; index < 5; index++) await render()
    expect(geometry).not.toHaveBeenCalled()
  })
})

describe('writing toolbar preference and viewport boundaries', () => {
  const viewport = { width: 900, height: 600, toolbarWidth: 300, toolbarHeight: 42, editorLeft: 200, editorTop: 58, editorWidth: 700 }

  it('accepts only complete finite settings and tolerates unavailable storage', () => {
    expect(readWritingToolbarPreferences({ getItem: () => '{broken' })).toEqual(defaults)
    expect(readWritingToolbarPreferences({ getItem: () => JSON.stringify({ pinned: true, dock: 'free', x: 1e9, y: 20 }) })).toEqual(defaults)
    expect(readWritingToolbarPreferences({ getItem: () => JSON.stringify({ pinned: true, dock: 'url(javascript:bad)', x: 10, y: 20 }) })).toEqual(defaults)
    expect(readWritingToolbarPreferences({ getItem: () => { throw new Error('blocked') } })).toEqual(defaults)
    expect(readWritingToolbarPreferences({ getItem: () => JSON.stringify({ pinned: true, dock: 'free', x: 20, y: 30 }) })).toEqual({ pinned: true, dock: 'free', x: 20, y: 30 })
  })

  it('clamps restored or moved coordinates and anchors each dock to the current window', () => {
    expect(writingToolbarPosition({ ...defaults, dock: 'free', x: -100, y: 10000 }, viewport)).toEqual({ x: 8, y: 528 })
    expect(writingToolbarPosition({ ...defaults, dock: 'right' }, viewport)).toEqual({ x: 592, y: 72 })
    expect(writingToolbarPosition(defaults, viewport)).toEqual({ x: 400, y: 70 })
    expect(writingToolbarPosition({ ...defaults, dock: 'right' }, { ...viewport, width: 390, toolbarWidth: 374 })).toEqual({ x: 8, y: 72 })
    expect(writingToolbarPosition({ ...defaults, dock: 'free', x: 400, y: 500 }, { ...viewport, width: 390, toolbarWidth: 374, height: 400 })).toEqual({ x: 8, y: 328 })
  })
})
