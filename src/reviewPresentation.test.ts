import { describe, expect, it } from 'vitest'
import { reviewProposalText } from './reviewPresentation'

describe('rendered review proposal labels', () => {
  it.each([
    ['**strong evidence**', 'strong evidence'],
    ['## Revised result', 'Revised result'],
    ['- first point\n- second point', 'first point second point'],
    ['[field protocol](https://example.test/protocol)', 'field protocol'],
    ['$x^2 + y^2$', 'x^2 + y^2'],
  ])('hides portable punctuation in %s', (source, expected) => {
    expect(reviewProposalText(source)).toBe(expected)
  })
})
