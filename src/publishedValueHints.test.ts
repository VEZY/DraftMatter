import { describe, expect, it } from 'vitest'
import { extractExecutableCells } from './executionCells'
import { computedValueSource, inferPublishedValueLanguage, publishedValueSnippet, publishedValueUnavailableHint } from './publishedValueHints'
import type { ParsedPublishedValues, RetainedPublishedValue } from './publishedValues'

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
    expect(hint).toContain('Julia computed value calculation')
    expect(hint).toContain('@publish mean_height')
  })

  it('resolves a literal or a recorded dynamic publisher and explains missing or competing sources', () => {
    const extracted = extractExecutableCells([
      '~~~python {#docs .execute}', '# publish("height", 0)', `note = 'publish("height", 1)'`, '~~~',
      '~~~python {#model .execute}', 'publish("height", 3)', '~~~',
      '~~~python {#dynamic .execute}', 'publish(variable, 5)', '~~~',
    ].join('\n'))
    const docsOnly = { ...extracted, cells: extracted.cells.slice(0, 1) }
    const empty: ParsedPublishedValues = { values: {}, diagnostics: [] }
    const record = { provenance: { cellId: 'dynamic' } } as RetainedPublishedValue
    expect(computedValueSource('height', extracted, empty).cell?.id).toBe('model')
    expect(computedValueSource('height', docsOnly, empty, 'docs').cell?.id).toBe('docs')
    expect(computedValueSource('height', docsOnly, empty, 'model').cell).toBeUndefined()
    expect(computedValueSource('height', extracted, empty, 'docs').cell).toBeUndefined()
    const duplicateId = extractExecutableCells(['~~~python {#model .execute}', 'print(1)', '~~~', '~~~python {#model .execute}', 'publish("height", 3)', '~~~'].join('\n'))
    expect(computedValueSource('height', duplicateId, empty).message).toMatch(/duplicate identifier/)
    expect(computedValueSource('height', duplicateId, empty, 'model').cell).toBeUndefined()
    expect(computedValueSource('height', docsOnly, empty).message).toMatch(/No source/)
    expect(computedValueSource('other', extracted, { ...empty, values: { other: record } }).cell?.id).toBe('dynamic')
    expect(computedValueSource('other', docsOnly, { ...empty, values: { other: record } }).message).toMatch(/missing/)
    expect(computedValueSource('height', extracted, { ...empty, values: { height: record } }).message).toMatch(/More than one/)
    expect(computedValueSource('height', extracted, { values: {}, diagnostics: [{ code: 'published-value-duplicate-height', level: 'error', message: '' }] }).cell).toBeUndefined()
  })
})
