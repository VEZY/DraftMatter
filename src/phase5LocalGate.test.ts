import { describe, expect, it } from 'vitest'
import { parsePortableDocument, sourceHash, validateCleanProjection } from './document'
import { renderDocxExport } from './docxExport'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { reviewedProjection } from './projections'
import { buildReviewExportBundle } from './reviewExport'
import { parseReviewMarkup } from './reviewMarkup'
import { initialDraft } from './sampleDraft'

describe('DM-P5-GATE local MVP dogfood path', () => {
  it('reopens portable state and exports one resolved clean projection to every native format', () => {
    const portable = reviewedProjection(initialDraft)
    const reopened = parsePortableDocument(portable, initialDraft)
    const review = parseReviewMarkup(portable)

    expect(reopened.draft.citationKeys).toEqual(['vezy2024'])
    expect(portable).toContain('[@coutellier2022]')
    expect(reopened.executableCells).toEqual([expect.objectContaining({ id: 'fig-canopy', language: 'python' })])
    expect(portable).toContain('<!-- dm-output:start cell="fig-canopy"')
    expect(review.changes).toHaveLength(2)
    expect(review.threads).toHaveLength(1)
    expect(review.authors).toHaveLength(2)

    const exported = buildReviewExportBundle(portable, ['dm-c01'])
    expect(exported.finalProjection.ok).toBe(true)
    expect(exported.final).toBeDefined()
    const cleanMarkdown = exported.final!
    expect(cleanMarkdown).toContain('reduced leaf area by 18%')
    expect(validateCleanProjection(cleanMarkdown)).toEqual([])
    expect(cleanMarkdown).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|data-anchor=/)

    const html = renderNativeHtmlExport(cleanMarkdown, {
      title: reopened.draft.title,
      bibliography: [{ id: 'vezy2020dynacof', value: 'Vezy et al. (2020). DynACof.' }],
    })
    const docx = renderDocxExport(cleanMarkdown)
    const docxText = new TextDecoder().decode(docx.bytes)

    expect(html).toContain('<!doctype html>')
    expect(html).toContain('@media print')
    expect(html).toContain('fig-canopy-result')
    expect(html).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<script/)
    expect(docxText).toContain('word/document.xml')
    expect(docxText).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
    expect(sourceHash(cleanMarkdown)).toBe(sourceHash(buildReviewExportBundle(portable, ['dm-c01']).final!))

    const cleanReopen = parsePortableDocument(cleanMarkdown, initialDraft)
    expect(cleanReopen.draft.title).toBe(reopened.draft.title)
    expect(cleanReopen.draft.citationKeys).toEqual(reopened.draft.citationKeys)
    expect(cleanReopen.executableCells.map((cell) => cell.id)).toEqual(reopened.executableCells.map((cell) => cell.id))
  })
})
