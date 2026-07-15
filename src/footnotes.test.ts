import { describe, expect, it } from 'vitest'
import { resolveFootnotes } from './footnotes'

describe('portable footnote resolution', () => {
  it('numbers references by first use and removes definitions from the body', () => {
    const resolved = resolveFootnotes('Claim[^methods] then result[^data]. Again[^methods].\n\n[^data]: Archived values.\n[^methods]: First line.\n  Continued details.\n')

    expect(resolved.numbers).toEqual({ methods: 1, data: 2 })
    expect(resolved.footnotes).toEqual([
      { label: 'methods', number: 1, content: 'First line. Continued details.', missing: false },
      { label: 'data', number: 2, content: 'Archived values.', missing: false },
    ])
    expect(resolved.body).toContain('Claim[^methods] then result[^data]. Again[^methods].')
    expect(resolved.body).not.toContain('[^methods]:')
  })

  it('keeps missing definitions explicit and omits uncited definitions from publication output', () => {
    const resolved = resolveFootnotes('Claim[^missing].\n\n[^unused]: Retained note.\n')
    expect(resolved.footnotes).toEqual([
      { label: 'missing', number: 1, content: 'Missing footnote definition for “missing”.', missing: true },
    ])
  })

  it('does not interpret fenced or inline code as footnote syntax', () => {
    const resolved = resolveFootnotes('`[^inline]` and a real note[^real].\n\n```text\n[^code]: literal definition\n[^code]\n```\n\n[^real]: Visible note.\n')
    expect(resolved.numbers).toEqual({ real: 1 })
    expect(resolved.footnotes).toEqual([
      { label: 'real', number: 1, content: 'Visible note.', missing: false },
    ])
    expect(resolved.body).toContain('[^code]: literal definition')
  })
})
