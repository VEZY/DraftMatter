import { describe, expect, it } from 'vitest'
import { numberedCrossReferenceLabel, numberedManuscriptObjects, retainedOutputPresentation } from './numberedObjects'
import { parseStructuredManuscript, serializeStructuredManuscript } from './structuredManuscript'

const source = `# Results

![Observed canopy](figures/canopy.svg){#fig-canopy}
: Observed canopy response.

$$
y = ax + b
$$ {#eq-model}
: Fitted response model.

| Group | Mean |
| --- | ---: |
| A | 12 |
: Summary values. {#tbl-summary .unnumbered}

\`\`\`julia {#fig-generated .execute output="figure"}
scatter(1:10)
\`\`\`

<!-- dm-output:start cell="fig-generated" run="sha256:one" -->
![Generated response](figures/generated.svg){#fig-generated-result}
: Reproducible model response.
<!-- dm-output:end -->
`

describe('numbered manuscript objects', () => {
  it('numbers each object kind independently in document order and respects .unnumbered', () => {
    const document = parseStructuredManuscript(source).document
    expect(numberedManuscriptObjects(document).map(({ kind, label, number, caption, unnumbered }) => ({ kind, label, number, caption, unnumbered }))).toEqual([
      { kind: 'figure', label: 'fig-canopy', number: 1, caption: 'Observed canopy response.', unnumbered: false },
      { kind: 'equation', label: 'eq-model', number: 1, caption: 'Fitted response model.', unnumbered: false },
      { kind: 'table', label: 'tbl-summary', number: undefined, caption: 'Summary values.', unnumbered: true },
      { kind: 'figure', label: 'fig-generated-result', number: 2, caption: 'Reproducible model response.', unnumbered: false },
    ])
    expect(numberedCrossReferenceLabel(document, 'fig-generated-result')).toBe('Figure 2')
    expect(numberedCrossReferenceLabel(document, 'eq-model')).toBe('Equation 1')
    expect(numberedCrossReferenceLabel(document, 'tbl-summary')).toBe('Table summary')
  })

  it('round-trips the portable display-equation caption line', () => {
    const parsed = parseStructuredManuscript(source)
    const equation = parsed.document.content.content.find((node) => node.type.name === 'equation_block')!
    expect(equation.attrs.captionMarkdown).toBe('Fitted response model.')
    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(source)
  })

  it('recognizes CairoMakie HTML wrappers as retained figures', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII='
    expect(retainedOutputPresentation(`<img width=600 src="data:image/png;base64, ${png}">`, 'markdown')).toEqual({
      kind: 'image',
      unnumbered: false,
    })
  })
})
