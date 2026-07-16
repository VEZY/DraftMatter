// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InsertBlockDialog, type InsertBlockRequest } from './InsertBlockDialog'

describe('in-app block insertion dialog', () => {
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

  const type = async (input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('collects a section without relying on browser prompts', async () => {
    const requests: InsertBlockRequest[] = []
    const close = vi.fn()
    await act(async () => root.render(<InsertBlockDialog kind="section" onClose={close} onInsert={(request) => { requests.push(request); return true }} />))

    const title = container.querySelector<HTMLInputElement>('input[placeholder="Discussion"]')!
    const label = container.querySelector<HTMLInputElement>('input[placeholder="sec-discussion"]')!
    await type(title, 'Discussion')
    await type(label, '#sec-discussion')
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit())

    expect(requests).toEqual([{ kind: 'section', title: 'Discussion', level: 2, label: 'sec-discussion' }])
    expect(close).toHaveBeenCalledOnce()
  })

  it('validates cross-references and keeps the dialog open when insertion fails', async () => {
    const insert = vi.fn(() => false)
    const close = vi.fn()
    await act(async () => root.render(<InsertBlockDialog kind="cross-reference" onClose={close} onInsert={insert} />))

    const input = container.querySelector<HTMLInputElement>('input[placeholder="fig-growth"]')!
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    await type(input, '@fig-growth')
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())

    expect(insert).toHaveBeenCalledWith({ kind: 'cross-reference', target: 'fig-growth' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('current editor position')
    expect(close).not.toHaveBeenCalled()
  })
})
