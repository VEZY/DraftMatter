import { describe, expect, it } from 'vitest'
import { renderDocxExport } from './docxExport'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { parseLosslessPortableSource } from './portableSource'
import { parseReviewMarkup } from './reviewMarkup'

function articleSizedFixture(pages = 90) {
  const sections = Array.from({ length: pages }, (_unused, index) => `## Section ${index + 1}

${`Canopy architecture and drought response remained measurable across cohort ${index + 1}. `.repeat(34)} [@vezy2020].

| Week | Control | Drought |
| ---: | ---: | ---: |
| ${index + 1} | ${100 + index} | ${82 + index} |
`).join('\n')
  return `---\ntitle: "Article-sized resilience fixture"\n---\n\n${sections}`
}

describe('DM-P5-07 article-sized performance gate', () => {
  it('keeps a 90-page semantic source and clean exports within recorded CI budgets', () => {
    const source = articleSizedFixture()
    expect(source.length).toBeGreaterThan(250_000)

    const parseStart = performance.now()
    const parsed = parseLosslessPortableSource(source)
    const review = parseReviewMarkup(source)
    const parseMs = performance.now() - parseStart

    const htmlStart = performance.now()
    const html = renderNativeHtmlExport(source)
    const htmlMs = performance.now() - htmlStart

    const docxStart = performance.now()
    const docx = renderDocxExport(source)
    const docxMs = performance.now() - docxStart

    expect(parsed.nodes.length).toBeGreaterThan(300)
    expect(review.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(html.length).toBeGreaterThan(250_000)
    expect(docx.bytes.byteLength).toBeGreaterThan(250_000)
    expect(parseMs, `portable parse took ${parseMs.toFixed(1)} ms`).toBeLessThan(2_500)
    expect(htmlMs, `native HTML took ${htmlMs.toFixed(1)} ms`).toBeLessThan(2_500)
    expect(docxMs, `native DOCX took ${docxMs.toFixed(1)} ms`).toBeLessThan(3_500)
  })
})
