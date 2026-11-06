// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { copyPlainText } from './clipboard'
import { manuscriptSchema } from './manuscriptSchema'

it('rejects forged node attributes in HTML clipboard context while accepting valid context', () => {
  const parsed: string[] = []
  const view = new EditorView(null, {
    state: EditorState.create({ schema: manuscriptSchema }),
    handlePaste: (_view, _event, slice) => {
      parsed.push(slice.content.firstChild!.type.name)
      return true
    },
  })
  try {
    for (const level of [2, ['img', { src: 'x', onerror: 'unexpected()' }]]) {
      const context = JSON.stringify(['heading', { level }])
      view.pasteHTML(`<p data-pm-slice='0 0 ${context}'>Pasted text</p>`, new Event('paste') as ClipboardEvent)
    }
    expect(parsed).toEqual(['heading', 'paragraph'])
  } finally {
    view.destroy()
  }
})

describe('portable clipboard writes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('uses the modern clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    await expect(copyPlainText('@fig-growth', { clipboard: { writeText }, document })).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('@fig-growth')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back to a temporary local textarea when a WebView rejects the modern API', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('not permitted'))
    const execute = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execute })

    await expect(copyPlainText('@tbl-results', { clipboard: { writeText }, document })).resolves.toBe(true)
    expect(execute).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
