// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { printNativeHtml, renderNativeHtmlExport } from './nativeHtmlExport'

describe('native PDF print handoff', () => {
  afterEach(() => {
    window.dispatchEvent(new Event('afterprint'))
    vi.restoreAllMocks()
  })

  it('prints the publication from the main window and cleans it up after printing', async () => {
    document.title = 'DraftMatter'
    document.body.innerHTML = '<main id="application">Editor</main>'
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    const html = renderNativeHtmlExport('---\ntitle: "Portable report"\n---\n\nPublication body.\n')

    await printNativeHtml(html)

    expect(print).toHaveBeenCalledOnce()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.title).toBe('Portable report')
    expect(document.querySelector('[data-draftmatter-print-root]')?.innerHTML).toContain('Publication body.')
    const style = document.querySelector<HTMLStyleElement>('[data-draftmatter-print-style]')
    expect(style?.media).toBe('print')
    expect(style?.textContent).toContain('body > *:not([data-draftmatter-print-root])')

    window.dispatchEvent(new Event('afterprint'))

    expect(document.querySelector('[data-draftmatter-print-root]')).toBeNull()
    expect(document.querySelector('[data-draftmatter-print-style]')).toBeNull()
    expect(document.title).toBe('DraftMatter')
  })

  it('uses a desktop print bridge and cleans up when that bridge fails', async () => {
    document.title = 'DraftMatter'
    document.body.innerHTML = '<main id="application">Editor</main>'
    const html = renderNativeHtmlExport('---\ntitle: "Portable report"\n---\n\nPublication body.\n')
    const requestPrint = vi.fn().mockRejectedValue(new Error('print unavailable'))

    await expect(printNativeHtml(html, requestPrint)).rejects.toThrow('print unavailable')

    expect(requestPrint).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-draftmatter-print-root]')).toBeNull()
    expect(document.querySelector('[data-draftmatter-print-style]')).toBeNull()
    expect(document.title).toBe('DraftMatter')
  })
})
