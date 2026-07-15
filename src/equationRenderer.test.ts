import { describe, expect, it } from 'vitest'
import { renderEquation } from './equationRenderer'

describe('safe offline equation rendering', () => {
  it('renders deterministic visual HTML with accessible MathML', () => {
    const first = renderEquation(String.raw`R^2 = \frac{a}{b}`, true)
    const second = renderEquation(String.raw`R^2 = \frac{a}{b}`, true)
    expect(first).toEqual(second)
    expect(first.error).toBeUndefined()
    expect(first.html).toContain('class="katex-display"')
    expect(first.html).toContain('<math')
    expect(first.html).toContain('application/x-tex')
  })

  it('fails malformed input closed without exposing untrusted markup', () => {
    const malformed = renderEquation(String.raw`\frac{a}{`)
    expect(malformed).toEqual({ html: '', error: expect.stringContaining('could not be rendered') })

    const untrusted = renderEquation(String.raw`\href{javascript:alert(1)}{open}\includegraphics{file:///secret}`)
    expect(untrusted.html).toBe('')
    expect(untrusted.error).toContain('disabled')
    expect(untrusted.html).not.toContain('<script')
  })
})
