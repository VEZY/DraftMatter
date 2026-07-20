import { describe, expect, it } from 'vitest'
import { renderDocxExport } from './docxExport'

const article = `---
title: "Canopy response"
author:
  - Remi Vezy
---

# Canopy response

## Results

Leaf area declined by **18%** [@vezy2020].[^methods] The fitted value was {{fit_value}}. The relationship was $y = ax + b$; see @fig-response and @tbl-summary.

$$
R^2 = 0.91
$$ {#eq-fit .unnumbered}

![Response](figures/response.svg){#fig-response}

| Treatment | Area |
| :--- | ---: |
| Control | 100 |
| Drought | 82 |
: Treatment **summary**. {#tbl-summary .striped}

\`\`\`python {#fit .execute}
print("inert")
\`\`\`

<!-- dm-output:start cell="fit" run="sha256:test" -->
<!-- dm-published-value data="%7B%22version%22%3A1%2C%22name%22%3A%22fit_value%22%2C%22value%22%3A0.91%2C%22formatting%22%3A%7B%22digits%22%3A2%7D%2C%22rendered%22%3A%220.91%22%2C%22provenance%22%3A%7B%22cellId%22%3A%22fit%22%2C%22language%22%3A%22python%22%2C%22runHash%22%3A%22sha256%3Afit%22%2C%22codeHash%22%3A%22sha256%3Acode%22%2C%22environmentFingerprint%22%3A%22sha256%3Aenv%22%2C%22sessionGeneration%22%3A1%2C%22executionSequence%22%3A1%2C%22retainedOutputHashes%22%3A%5B%22sha256%3Afit%22%5D%7D%7D" -->
\`\`\`text
retained model output
\`\`\`
<!-- dm-output:end -->

[^methods]: Calibration details were checked against field measurements.
`

describe('native DOCX export', () => {
  it('builds deterministic clean OOXML with document styles and real tables', () => {
    const options = {
      citationLabels: { '[@vezy2020]': '(Vezy et al., 2020)' },
      bibliography: [{ id: 'vezy2020', value: 'Vezy, R. et al. (2020). Portable canopy science.' }],
    }
    const first = renderDocxExport(article, options)
    const second = renderDocxExport(article, options)
    const readable = new TextDecoder().decode(first.bytes)

    expect(first.bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    expect(first.bytes).toEqual(second.bytes)
    expect(readable).toContain('word/document.xml')
    expect(readable).toContain('word/styles.xml')
    expect(readable).toContain('word/footnotes.xml')
    expect(readable).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml')
    expect(readable).toContain('relationships/footnotes')
    expect(readable).toContain('Canopy response')
    expect(readable.match(/Canopy response/g)).toHaveLength(1)
    expect(readable).toContain('Remi Vezy')
    expect(readable).toContain('(Vezy et al., 2020)')
    expect(readable).toContain('References')
    expect(readable).toContain('Portable canopy science')
    expect(readable).not.toContain('[@vezy2020]')
    expect(readable).toContain('<w:footnoteReference w:id="1"/>')
    expect(readable).toContain('<w:footnote w:type="separator" w:id="-1">')
    expect(readable).toContain('<w:footnote w:type="continuationSeparator" w:id="0">')
    expect(readable).toContain('<w:footnote w:id="1">')
    expect(readable).toContain('Calibration details were checked against field measurements.')
    expect(readable).not.toContain('[^methods]')
    expect(readable).toContain('y = ax + b; see Figure 1 and Table 1')
    expect(readable).not.toContain('$y = ax + b$')
    expect(readable).not.toContain('@fig-response')
    expect(readable).toContain('R^2 = 0.91')
    expect(readable).not.toContain('{#eq-fit')
    expect(readable).toContain('<w:tbl>')
    expect(readable).toContain('<w:jc w:val="right"/>')
    expect(readable).toContain('Table 1. Treatment summary.')
    expect(readable).not.toContain('{#tbl-summary')
    expect(readable).toContain('The fitted value was 0.91.')
    expect(readable).not.toContain('print(&quot;inert&quot;)')
    expect(readable).toContain('retained model output')
    expect(readable).not.toContain('source · not executed during export')
    expect(readable).not.toContain('dm-published-value')
    expect(readable).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
    expect(first.diagnostics).toEqual([expect.objectContaining({ code: 'figure-reference', level: 'warning' })])
  })

  it('exports a one-column retained R table as a real Word table', () => {
    const readable = new TextDecoder().decode(renderDocxExport(`# Study

| a |
| --- |
| 1 |
| 2 |
| 3 |
: Generated table. {#tbl-result}
`).bytes)

    expect(readable).toContain('<w:tbl>')
    expect(readable).toContain('Table 1. Generated table.')
    expect(readable).toContain('<w:t xml:space="preserve">a</w:t>')
    expect(readable).toContain('<w:t xml:space="preserve">3</w:t>')
  })

  it('blocks review storage instead of representing it as tracked changes', () => {
    expect(() => renderDocxExport('Text\n\n::::: {.draftmatter-reviews .hidden}\n:::::\n')).toThrow(/clean DraftMatter projection/)
  })

  it('publishes structured author identities, affiliations, and document creators', () => {
    const result = renderDocxExport(`---
title: "Author metadata study"
author:
  - name: "Ada Researcher"
    orcid: 0000-0001-2345-6789
    affiliations:
      - Field Institute
      - Open Methods Lab
  - name: "Lin Reviewer"
    affiliations:
      - Field Institute
---

Publication body.
`)
    const readable = new TextDecoder().decode(result.bytes)

    expect(readable).toContain('<w:style w:type="paragraph" w:styleId="Affiliation">')
    expect(readable).toContain('Ada Researcher')
    expect(readable).toContain('(ORCID 0000-0001-2345-6789)')
    expect(readable).toContain('<w:vertAlign w:val="superscript"/><w:sz w:val="14"/>')
    expect(readable.match(/Field Institute/g)).toHaveLength(1)
    expect(readable).toContain('Open Methods Lab')
    expect(readable).toContain('<dc:creator>Ada Researcher; Lin Reviewer</dc:creator>')
  })

  it('carries inspector-authored semantics into DOCX while keeping computation source hidden', () => {
    const result = renderDocxExport(`## Results {#sec-results .unnumbered}

$$
y = ax + b
$$ {#eq-response .unnumbered}
: Response model.

![Accessible canopy response](figures/canopy.svg){#fig-canopy .unnumbered}
: Manual response figure.

| Group | Mean |
| --- | ---: |
| A | 12 |
: Summary table. {#tbl-summary .unnumbered}

\`\`\`julia {#cell-generated .execute output="figure"}
plot_response()
\`\`\`

<!-- dm-output:start cell="cell-generated" run="sha256:run" -->
![Accessible generated response](figures/generated.svg){#fig-generated .unnumbered}
: Reproducible response figure.
<!-- dm-output:end -->
`)
    const readable = new TextDecoder().decode(result.bytes)

    expect(readable).toContain('Response model.')
    expect(readable).toContain('Manual response figure. — figures/canopy.svg')
    expect(readable).toContain('Summary table.')
    expect(readable).toContain('Reproducible response figure. — figures/generated.svg')
    expect(readable).not.toContain('Figure 1.')
    expect(readable).not.toContain('Table 1.')
    expect(readable).not.toContain('(1)')
    expect(readable).not.toContain('plot_response()')
    expect(readable).not.toContain('dm-output:')
  })
})
