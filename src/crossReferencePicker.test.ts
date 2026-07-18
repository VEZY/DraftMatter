import { describe, expect, it } from 'vitest'
import { crossReferenceChoices, groupedCrossReferenceChoices } from './crossReferencePicker'
import { semanticManuscriptObjects } from './semanticObjects'
import { parseStructuredManuscript } from './structuredManuscript'

const source = `# Results {#sec-results}

![Growth](growth.svg){#fig-growth}
: Growth response.

| Group | Mean |
| --- | ---: |
| A | 12 |
: Summary means. {#tbl-means}

$$
y = ax + b
$$ {#eq-model}
`

describe('semantic cross-reference choices', () => {
  it('groups objects by manuscript kind and shows current numbering and captions', () => {
    const groups = groupedCrossReferenceChoices(semanticManuscriptObjects(parseStructuredManuscript(source).document))
    expect(groups.map((group) => group.label)).toEqual(['Figures', 'Tables', 'Equations', 'Sections'])
    expect(groups.flatMap((group) => group.items).map((choice) => choice.text)).toEqual([
      'Figure 1 — Growth response.',
      'Table 1 — Summary means.',
      'Equation 1 — Display equation',
      'Section 1 — Results',
    ])
  })

  it('searches descriptions and kinds without exposing legacy machine targets in option text', () => {
    const legacy = semanticManuscriptObjects(parseStructuredManuscript(`${source}
<!-- dm-output:start cell="cell-julia-359c1638-441c-4ae7-bc9b-93835c37ab9c" run="sha256:one" -->
![Generated](plot.svg){#fig-cell-julia-359c1638-441c-4ae7-bc9b-93835c37ab9c-result}
: Canopy density.
<!-- dm-output:end -->
`).document)
    expect(crossReferenceChoices(legacy, 'canopy').map((choice) => choice.text)).toEqual([
      'Figure 2 — Canopy density. · Reproducible',
    ])
    expect(crossReferenceChoices(legacy, 'canopy')[0].text).not.toContain('359c1638')
    expect(crossReferenceChoices(legacy, 'table').map((choice) => choice.text)).toEqual(['Table 1 — Summary means.'])
  })
})
