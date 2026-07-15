import { describe, expect, it } from 'vitest'
import { parseDisplayEquation } from './displayEquation'

describe('display equation parsing', () => {
  it('parses multiline and single-line labeled equations', () => {
    expect(parseDisplayEquation(['$$', 'E = mc^2', '$$ {#eq-mass .unnumbered}', 'After'], 0)).toEqual({
      tex: 'E = mc^2',
      label: 'eq-mass',
      sourceAttributes: '#eq-mass .unnumbered',
      end: 3,
      closed: true,
    })
    expect(parseDisplayEquation(['$$ y = ax + b $$ {#eq-fit}'], 0)).toEqual({
      tex: 'y = ax + b',
      label: 'eq-fit',
      sourceAttributes: '#eq-fit',
      end: 1,
      closed: true,
    })
  })

  it('reports an unclosed block without pretending it succeeded', () => {
    expect(parseDisplayEquation(['$$', 'E = mc^2', 'After'], 0)).toMatchObject({
      tex: 'E = mc^2\nAfter',
      end: 3,
      closed: false,
    })
  })
})
