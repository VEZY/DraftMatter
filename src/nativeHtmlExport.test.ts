import { describe, expect, it } from 'vitest'
import { renderNativeHtmlExport } from './nativeHtmlExport'

const cleanArticle = `---
title: "Quiet canopy study"
author:
  - Remi Vezy
  - Alice Martin
---

# Quiet canopy study

## Results {#results}

Leaf area declined by **18%** [@vezy2020].[^methods] The fitted value was {{fit_value}}. See @fig-response, @tbl-summary, and the model $y = ax + b$.

$$
R^2 = 0.94
$$ {#eq-fit .unnumbered}

![Leaf-area response](figures/response.svg){#fig-response}

| Treatment | Leaf area |
| :--- | ---: |
| Control | 100 |
| Drought | 82 |
: Treatment **summary**. {#tbl-summary .striped}

\`\`\`python {#fit .execute}
print("must remain inert")
\`\`\`

<!-- dm-output:start cell="fit" run="sha256:test" -->
<!-- dm-published-value data="%7B%22version%22%3A1%2C%22name%22%3A%22fit_value%22%2C%22value%22%3A0.94%2C%22formatting%22%3A%7B%22digits%22%3A2%7D%2C%22rendered%22%3A%220.94%22%2C%22provenance%22%3A%7B%22cellId%22%3A%22fit%22%2C%22language%22%3A%22python%22%2C%22runHash%22%3A%22sha256%3Afit%22%2C%22codeHash%22%3A%22sha256%3Acode%22%2C%22environmentFingerprint%22%3A%22sha256%3Aenv%22%2C%22sessionGeneration%22%3A1%2C%22executionSequence%22%3A1%2C%22retainedOutputHashes%22%3A%5B%22sha256%3Afit%22%5D%7D%7D" -->
\`\`\`text
retained model output
\`\`\`
<!-- dm-output:end -->

[^methods]: Calibration details were checked with **manual review**.
`

describe('native HTML export', () => {
  it('renders a representative clean article with semantic, script-free structure', () => {
    const html = renderNativeHtmlExport(cleanArticle, {
      bibliography: [{ id: 'vezy2020', value: 'Vezy et al. (2020). DynACof.' }],
    })

    expect(html).toContain('<title>Quiet canopy study</title>')
    expect(html).toContain('<p class="authors">Remi Vezy · Alice Martin</p>')
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).not.toContain('<main><h1')
    expect(html).toContain('<h2 id="results">Results</h2>')
    expect(html).toContain('data-citekeys="vezy2020"')
    expect(html).toContain('<sup id="fnref-methods"><a class="footnote-reference" href="#fn-methods" role="doc-noteref" aria-label="Footnote 1">1</a></sup>')
    expect(html).toContain('<section class="footnotes" role="doc-endnotes" aria-label="Footnotes">')
    expect(html).toContain('<li id="fn-methods">Calibration details were checked with <strong>manual review</strong>.')
    expect(html).not.toContain('[^methods]')
    expect(html).toContain('<a class="cross-reference" href="#fig-response">Figure 1</a>')
    expect(html).toContain('<a class="cross-reference" href="#tbl-summary">Table 1</a>')
    expect(html).not.toContain('>@fig-response<')
    expect(html).toContain('role="math"')
    expect(html).toContain('<div id="eq-fit" class="equation display-equation" data-tex="R^2 = 0.94" role="math">')
    expect(html).not.toContain('{#eq-fit')
    expect(html).toContain('<figure id="fig-response">')
    expect(html).toContain('<table id="tbl-summary"><caption><strong>Table 1.</strong> Treatment <strong>summary</strong>.</caption>')
    expect(html).toContain('<th style="text-align:right">Leaf area</th>')
    expect(html).not.toContain('{#tbl-summary')
    expect(html).toContain('The fitted value was 0.94.')
    expect(html).not.toContain('<pre class="source-code"><code class="language-python">')
    expect(html).not.toContain('must remain inert')
    expect(html).toContain('<pre class="execution-output"><samp>retained model output</samp></pre>')
    expect(html).not.toContain('source · not executed during export')
    expect(html).not.toContain('dm-published-value')
    expect(html).not.toContain('<figcaption>python source')
    expect(html).not.toMatch(/<script|\.dm-anchor|\.draftmatter-reviews/)
  })

  it('blocks reserved review data instead of leaking it', () => {
    expect(() => renderNativeHtmlExport('Text []{#a .dm-anchor data-anchor="a"}.')).toThrow(/clean DraftMatter projection/)
  })

  it('exports a one-column retained R table', () => {
    const html = renderNativeHtmlExport(`# Study

| a |
| --- |
| 1 |
| 2 |
| 3 |
: Generated table. {#tbl-result}
`)

    expect(html).toContain('<table id="tbl-result"><caption><strong>Table 1.</strong> Generated table.</caption>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>3</td>')
  })

  it('publishes ORCID identities and deduplicated affiliation references', () => {
    const html = renderNativeHtmlExport(`---
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

    expect(html).toContain('<meta name="citation_author" content="Ada Researcher">')
    expect(html).toContain('<meta name="citation_author_orcid" content="https://orcid.org/0000-0001-2345-6789">')
    expect(html).toContain('<a class="orcid" href="https://orcid.org/0000-0001-2345-6789"')
    expect(html).toContain('aria-label="Affiliations 1, 2"')
    expect(html).toContain('<li id="affiliation-1">Field Institute</li>')
    expect(html).toContain('<li id="affiliation-2">Open Methods Lab</li>')
    expect(html.match(/<li id="affiliation-\d+">Field Institute<\/li>/g)).toHaveLength(1)
  })

  it('escapes raw HTML and rejects active asset URLs', () => {
    const html = renderNativeHtmlExport('<script>alert(1)</script>\n\n![unsafe](javascript:alert(1))\n')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('src="javascript:')
  })

  it('preserves an unclosed display equation as escaped visible source', () => {
    const html = renderNativeHtmlExport('$$\nE = mc^2\nText after the missing close.\n')
    expect(html).toContain('aria-label="Unclosed display equation"')
    expect(html).toContain('Text after the missing close.')
  })

  it('keeps a missing footnote definition explicit', () => {
    const html = renderNativeHtmlExport('Claim[^missing].\n')
    expect(html).toContain('<li id="fn-missing" class="missing-footnote">Missing footnote definition for “missing”.')
    expect(html).not.toContain('[^missing]')
  })

  it('preserves inspector-authored captions, descriptions, labels, and display choices', () => {
    const html = renderNativeHtmlExport(`## Results {#sec-results .unnumbered}

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

    expect(html).toContain('<h2 id="sec-results">Results</h2>')
    expect(html).toContain('<div id="eq-response" class="equation display-equation"')
    expect(html).toContain('<figcaption>Response model.</figcaption>')
    expect(html).toContain('<figure id="fig-canopy"><img src="figures/canopy.svg" alt="Accessible canopy response"><figcaption>Manual response figure.</figcaption>')
    expect(html).toContain('<table id="tbl-summary"><caption>Summary table.</caption>')
    expect(html).toContain('<figure id="fig-generated"><img src="figures/generated.svg" alt="Accessible generated response"><figcaption>Reproducible response figure.</figcaption>')
    expect(html).not.toMatch(/<(?:strong|span)[^>]*>\s*(?:Figure|Table|Equation)\s+\d/)
    expect(html).not.toContain('plot_response()')
    expect(html).not.toContain('dm-output:')
  })
})
