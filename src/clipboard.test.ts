// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPlainText } from './clipboard'

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
