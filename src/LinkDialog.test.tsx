// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkDialog } from './LinkDialog'

describe('link insertion dialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('collects a safe destination and optional title without a native prompt', async () => {
    const close = vi.fn()
    const insert = vi.fn(() => true)
    await act(async () => root.render(<LinkDialog onClose={close} onInsert={insert} />))

    const destination = container.querySelector<HTMLInputElement>('[aria-labelledby="add-link-title"] input')!
    const title = container.querySelectorAll<HTMLInputElement>('input')[1]
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

    await act(async () => {
      inputSetter?.call(destination, 'javascript:alert(1)')
      destination.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unsafe')

    await act(async () => {
      inputSetter?.call(destination, 'notes/field-protocol.md')
      destination.dispatchEvent(new Event('input', { bubbles: true }))
      inputSetter?.call(title, 'Field protocol')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(insert).toHaveBeenCalledWith('notes/field-protocol.md', 'Field protocol')
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open and explains when no manuscript text was selected', async () => {
    const close = vi.fn()
    await act(async () => root.render(<LinkDialog onClose={close} onInsert={() => false} />))
    const destination = container.querySelector<HTMLInputElement>('input')!
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      inputSetter?.call(destination, 'https://example.org')
      destination.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(close).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Select the manuscript text')
  })
})
