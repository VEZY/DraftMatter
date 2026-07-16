import { describe, expect, it } from 'vitest'
import { renderDocxExport } from './docxExport'

const article = `---
title: "Canopy response"
author:
  - Remi Vezy
---

# Canopy response

## Results

Leaf area declined by **18%** [@vezy2020].[^methods] The relationship was $y = ax + b$; see @fig-response and @tbl-summary.

$$
R^2 = 0.91
$$ {#eq-fit .unnumbered}

![Response](figures/response.svg){#fig-response}

| Treatment | Area |
| :--- | ---: |
| Control | 100 |
| Drought | 82 |
: Treatment **summary**. {#tbl-summary .striped}

\`\`\`python
print("inert")
\`\`\`

<!-- dm-output:start cell="fit" run="sha256:test" -->
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
    expect(readable).toContain('y = ax + b; see Figure response and Table summary')
    expect(readable).not.toContain('$y = ax + b$')
    expect(readable).not.toContain('@fig-response')
    expect(readable).toContain('R^2 = 0.91')
    expect(readable).not.toContain('{#eq-fit')
    expect(readable).toContain('<w:tbl>')
    expect(readable).toContain('<w:jc w:val="right"/>')
    expect(readable).toContain('Table: Treatment summary.')
    expect(readable).not.toContain('{#tbl-summary')
    expect(readable).toContain('print(&quot;inert&quot;)')
    expect(readable).toContain('retained model output')
    expect(readable).not.toContain('source · not executed during export')
    expect(readable).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
    expect(first.diagnostics).toEqual([expect.objectContaining({ code: 'figure-reference', level: 'warning' })])
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
})
