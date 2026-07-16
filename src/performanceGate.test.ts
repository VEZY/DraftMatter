import { describe, expect, it } from 'vitest'
import { renderDocxExport } from './docxExport'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { articleSizedFixture } from './performanceFixture'
import { parseLosslessPortableSource } from './portableSource'
import { parseReviewMarkup } from './reviewMarkup'

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
