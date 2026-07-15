// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import endnoteFixture from './fixtures/bibliography/multi-record.enw?raw'
import risFixture from './fixtures/bibliography/multi-record.ris?raw'

function buttonContaining(container: ParentNode, text: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Button containing ${text} was not found.`)
  return button as HTMLButtonElement
}

async function openPicker() {
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
}

async function paste(target: Element, payload: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => payload } })
  await act(async () => target.dispatchEvent(event))
}

describe('rendered citation intake', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

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
  })

  it('previews a keyboard paste before explicitly staging selected records', async () => {
    await act(async () => root.render(<App />))
    await openPicker()

    const intake = container.querySelector('textarea[aria-label="Paste DOI, BibTeX, RIS/EndNote, or CSL JSON"]')!
    await paste(intake, risFixture)

    expect(container.querySelector('[aria-label="Citation import preview"]')).not.toBeNull()
    expect(container.querySelectorAll('.citation-preview-records input:checked')).toHaveLength(2)
    expect(container.querySelector('.citation-preview-head')?.textContent).toContain('original payload retained')
    expect(intake.textContent || (intake as HTMLTextAreaElement).value).toBe(risFixture)

    await act(async () => buttonContaining(container, 'Stage selected').click())
    expect(container.querySelector('[aria-label="Citation import preview"]')).toBeNull()
    expect(container.querySelectorAll('.source-result')).toHaveLength(5)
    expect(container.textContent).toContain('Réponses du couvert à la sécheresse')
  })

  it('previews dropped text and preserves malformed payloads for correction', async () => {
    await act(async () => root.render(<App />))
    await openPicker()
    const picker = container.querySelector('.citation-picker')!
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [], getData: () => '{"id":' } })
    await act(async () => picker.dispatchEvent(drop))

    expect(container.querySelector('.citation-preview-diagnostics')?.textContent).toContain('not valid JSON')
    expect((container.querySelector('.citation-intake-box textarea') as HTMLTextAreaElement).value).toBe('{"id":')
    expect(container.querySelectorAll('.citation-preview-records')).toHaveLength(0)
  })

  it('opens a dropped supported file as a preview instead of importing it immediately', async () => {
    await act(async () => root.render(<App />))
    await openPicker()
    const picker = container.querySelector('.citation-picker')!
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        files: [{ name: 'library.enw', size: endnoteFixture.length, text: async () => endnoteFixture }],
        getData: () => '',
      },
    })
    await act(async () => {
      picker.dispatchEvent(drop)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.querySelector('.citation-preview-head')?.textContent).toContain('EndNote preview')
    expect(container.textContent).toContain('Growth coordination under fluctuating water availability')
    expect(container.querySelectorAll('.source-result')).toHaveLength(3)
  })
})
