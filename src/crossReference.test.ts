import { describe, expect, it } from 'vitest'
import { formatCrossReferenceTarget, isCrossReferenceTarget } from './crossReference'

describe('rendered cross-reference labels', () => {
  it.each([
    ['fig-canopy-response', 'Figure canopy response'],
    ['tbl-model_fit', 'Table model fit'],
    ['eq-growth.rate', 'Equation growth rate'],
    ['sec-methods:detail', 'Section methods detail'],
  ])('formats %s without exposing portable punctuation', (target, label) => {
    expect(formatCrossReferenceTarget(target)).toBe(label)
    expect(formatCrossReferenceTarget(`@${target}`)).toBe(label)
  })

  it('leaves non-reference text unchanged', () => {
    expect(formatCrossReferenceTarget('appendix-a')).toBe('appendix-a')
  })

  it('keeps sentence punctuation outside the portable target', () => {
    expect(isCrossReferenceTarget('fig-response')).toBe(true)
    expect(isCrossReferenceTarget('fig-response.')).toBe(false)
  })
})
