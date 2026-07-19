// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InsertBlockDialog, type InsertBlockRequest } from './InsertBlockDialog'
import { semanticManuscriptObjects } from './semanticObjects'
import { parseStructuredManuscript } from './structuredManuscript'

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

  it('collects the language for a reproducible table', async () => {
    const requests: InsertBlockRequest[] = []
    const close = vi.fn()
    await act(async () => root.render(<InsertBlockDialog kind="table-cell" onClose={close} onInsert={(request) => { requests.push(request); return true }} />))

    const language = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      language.value = 'julia'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit())

    expect(requests).toEqual([{ kind: 'table-cell', language: 'julia' }])
    expect(close).toHaveBeenCalledOnce()
  })

  it('searches grouped manuscript objects by keyboard and keeps the dialog open when insertion fails', async () => {
    const insert = vi.fn(() => false)
    const close = vi.fn()
    const semanticObjects = semanticManuscriptObjects(parseStructuredManuscript(`# Results {#sec-results}

![Growth](growth.svg){#fig-growth}
: Growth response.

| Group | Mean |
| --- | ---: |
| A | 12 |
: Summary means. {#tbl-means}

$$
y = ax + b
$$ {#eq-model}
`).document)
    await act(async () => root.render(<InsertBlockDialog kind="cross-reference" onClose={close} onInsert={insert} semanticObjects={semanticObjects} />))

    const input = container.querySelector<HTMLInputElement>('input[placeholder^="Search figures"]')!
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    expect([...container.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['Figures', 'Tables', 'Equations', 'Sections'])
    expect([...container.querySelectorAll('option')].map((option) => option.textContent)).toEqual(expect.arrayContaining([
      'Figure 1 — Growth response.',
      'Table 1 — Summary means.',
      'Equation 1 — Display equation',
      'Section 1 — Results',
    ]))
    await type(input, 'growth')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(submit.disabled).toBe(false)
    expect(document.activeElement).toBe(container.querySelector('select[aria-label="Cross-reference target"]'))
    await act(async () => submit.click())

    const figure = semanticObjects.find((object) => object.kind === 'figure')!
    expect(insert).toHaveBeenCalledWith({ kind: 'cross-reference', target: 'fig-growth', targetNodeId: figure.nodeId })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('current editor position')
    expect(close).not.toHaveBeenCalled()
  })

  it.each([
    ['table', 'Table 1'],
    ['equation', 'Equation 1'],
    ['section', 'Section 1'],
  ] as const)('inserts a %s reference by choosing its rendered identity instead of typing a label', async (kind, prefix) => {
    const insert = vi.fn(() => true)
    const close = vi.fn()
    const semanticObjects = semanticManuscriptObjects(parseStructuredManuscript(`# Results {#sec-results}

![Growth](growth.svg){#fig-growth}
: Growth response.

| Group | Mean |
| --- | ---: |
| A | 12 |
: Summary means. {#tbl-means}

$$
y = ax + b
$$ {#eq-model}
`).document)
    await act(async () => root.render(<InsertBlockDialog kind="cross-reference" onClose={close} onInsert={insert} semanticObjects={semanticObjects} />))

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Cross-reference target"]')!
    const option = [...select.options].find((candidate) => candidate.textContent?.startsWith(prefix))!
    await act(async () => {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit())

    const object = semanticObjects.find((candidate) => candidate.kind === kind)!
    expect(insert).toHaveBeenCalledWith({
      kind: 'cross-reference',
      target: object.label,
      targetNodeId: object.nodeId,
    })
    expect(close).toHaveBeenCalledOnce()
  })
})
