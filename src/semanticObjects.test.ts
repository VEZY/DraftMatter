import { describe, expect, it } from 'vitest'
import { parseStructuredManuscript, serializeStructuredManuscript } from './structuredManuscript'
import {
  friendlyObjectLabel,
  isLegacyMachineObjectLabel,
  semanticCrossReferenceLabel,
  semanticManuscriptObjects,
} from './semanticObjects'

describe('semantic manuscript object identities', () => {
  it('builds one ordered index for sections and numbered manuscript objects', () => {
    const source = `# Results {#sec-results}

## Growth response

![Canopy height](growth.svg)
: Growth response through time.

$$
y = ax + b
$$ {#eq-growth}

| Group | Mean |
| --- | ---: |
| A | 12 |
: Means. {#tbl-means}
`
    const document = parseStructuredManuscript(source).document
    expect(semanticManuscriptObjects(document).map((object) => ({
      kind: object.kind,
      label: object.label,
      suggestedLabel: object.suggestedLabel,
      displayNumber: object.displayNumber,
    }))).toEqual([
      { kind: 'section', label: 'sec-results', suggestedLabel: 'sec-results', displayNumber: '1' },
      { kind: 'section', label: undefined, suggestedLabel: 'sec-growth-response', displayNumber: '1.1' },
      { kind: 'figure', label: undefined, suggestedLabel: 'fig-growth-response-through-time', displayNumber: '1' },
      { kind: 'equation', label: 'eq-growth', suggestedLabel: 'eq-growth', displayNumber: '1' },
      { kind: 'table', label: 'tbl-means', suggestedLabel: 'tbl-means', displayNumber: '1' },
    ])
    expect(semanticCrossReferenceLabel(document, 'sec-results')).toBe('Section 1')
    expect(semanticCrossReferenceLabel(document, 'tbl-means')).toBe('Table 1')
  })

  it('creates readable deterministic collision suffixes without changing existing labels', () => {
    const used = ['fig-growth-response', 'fig-growth-response-2', 'tbl-existing']
    expect(friendlyObjectLabel('figure', 'Growth response', used)).toBe('fig-growth-response-3')
    expect(friendlyObjectLabel('figure', 'Crème brûlée response')).toBe('fig-creme-brulee-response')
    expect(friendlyObjectLabel('equation', 'R² = a / b')).toBe('eq-r2-a-b')
  })

  it('keeps persisted identities stable when duplicate captions are reordered and reopened', () => {
    const first = `# Results {#sec-results}

![First](first.svg){#fig-growth-response}
: Growth response.

![Second](second.svg){#fig-growth-response-2}
: Growth response.
`
    const reordered = `# Results {#sec-results}

![Second](second.svg){#fig-growth-response-2}
: Growth response.

![First](first.svg){#fig-growth-response}
: Growth response.
`
    const originalObjects = semanticManuscriptObjects(parseStructuredManuscript(first).document)
    const movedObjects = semanticManuscriptObjects(parseStructuredManuscript(reordered).document)

    expect(originalObjects.filter((object) => object.kind === 'figure').map((object) => object.label)).toEqual([
      'fig-growth-response',
      'fig-growth-response-2',
    ])
    expect(movedObjects.filter((object) => object.kind === 'figure').map((object) => object.label)).toEqual([
      'fig-growth-response-2',
      'fig-growth-response',
    ])
    expect(movedObjects.filter((object) => object.kind === 'figure').map((object) => object.displayNumber)).toEqual(['1', '2'])
  })

  it('keeps legacy machine labels portable and marks them for secondary UI treatment', () => {
    const source = `# Results

<!-- dm-output:start cell="cell-julia-359c1638-441c-4ae7-bc9b-93835c37ab9c" run="sha256:one" -->
![Generated](plot.svg){#fig-cell-julia-359c1638-441c-4ae7-bc9b-93835c37ab9c-result}
: Growth response.
<!-- dm-output:end -->
`
    const parsed = parseStructuredManuscript(source)
    const figure = semanticManuscriptObjects(parsed.document).find((object) => object.kind === 'figure')!
    expect(figure.label).toBe('fig-cell-julia-359c1638-441c-4ae7-bc9b-93835c37ab9c-result')
    expect(figure.suggestedLabel).toBe(figure.label)
    expect(figure.legacyMachineLabel).toBe(true)
    expect(isLegacyMachineObjectLabel(figure.label!)).toBe(true)
    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(source)
  })
})
