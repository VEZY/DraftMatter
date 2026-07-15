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

Leaf area declined by **18%** [@vezy2020].[^methods] See @fig-response, @tbl-summary, and the model $y = ax + b$.

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
    expect(html).toContain('<a class="cross-reference" href="#fig-response">Figure response</a>')
    expect(html).toContain('<a class="cross-reference" href="#tbl-summary">Table summary</a>')
    expect(html).not.toContain('>@fig-response<')
    expect(html).toContain('role="math"')
    expect(html).toContain('<div id="eq-fit" class="equation display-equation" data-tex="R^2 = 0.94" role="math">')
    expect(html).not.toContain('{#eq-fit')
    expect(html).toContain('<figure id="fig-response">')
    expect(html).toContain('<table id="tbl-summary"><caption>Treatment <strong>summary</strong>.</caption>')
    expect(html).toContain('<th style="text-align:right">Leaf area</th>')
    expect(html).not.toContain('{#tbl-summary')
    expect(html).toContain('not executed during export')
    expect(html).toContain('print(&quot;must remain inert&quot;)')
    expect(html).not.toMatch(/<script|\.dm-anchor|\.draftmatter-reviews/)
  })

  it('blocks reserved review data instead of leaking it', () => {
    expect(() => renderNativeHtmlExport('Text []{#a .dm-anchor data-anchor="a"}.')).toThrow(/clean DraftMatter projection/)
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
})
