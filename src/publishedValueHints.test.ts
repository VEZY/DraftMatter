import { describe, expect, it } from 'vitest'
import { extractExecutableCells } from './executionCells'
import { inferPublishedValueLanguage, publishedValueSnippet, publishedValueUnavailableHint } from './publishedValueHints'

describe('published value hints', () => {
  it('uses the exact publication syntax for each language', () => {
    expect(publishedValueSnippet('mean_height', 'python')).toBe('publish("mean_height", mean_height, unit="cm", digits=1)')
    expect(publishedValueSnippet('mean_height', 'r')).toBe('publish("mean_height", mean_height, unit = "cm", digits = 1)')
    expect(publishedValueSnippet('mean_height', 'julia')).toBe('@publish mean_height unit="cm" digits=1')
    expect(publishedValueSnippet('model.mean', 'julia')).toBe('publish("model.mean", value; unit="cm", digits=1)')
  })

  it('infers the producer from an explicit publication in a multilingual document', () => {
    const source = `
\`\`\`python {#py .execute output="values"}
publish("python_value", python_value)
\`\`\`

\`\`\`julia {#jl .execute output="values"}
@publish mean_height unit="cm" digits=1
\`\`\`
`
    const cells = extractExecutableCells(source).cells
    expect(inferPublishedValueLanguage('mean_height', cells)).toBe('julia')
    expect(inferPublishedValueLanguage('python_value', cells)).toBe('python')
    expect(inferPublishedValueLanguage('unknown', cells)).toBeUndefined()
  })

  it('explains how to publish and run an unresolved value', () => {
    const hint = publishedValueUnavailableHint('mean_height', 'julia')
    expect(hint).toContain('{{mean_height}} is unavailable')
    expect(hint).toContain('Julia values cell')
    expect(hint).toContain('@publish mean_height')
  })
})
