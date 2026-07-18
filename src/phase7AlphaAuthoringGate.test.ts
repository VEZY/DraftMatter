/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderDocxExport } from './docxExport'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { numberedManuscriptObjects } from './numberedObjects'
import { parseRetainedPublishedValues } from './publishedValues'
import { referenceIntegrityDiagnostics, semanticReferenceOccurrences } from './referenceIntegrity'
import { parseRetainedOutputs } from './retainedOutputs'
import { buildReviewExportBundle } from './reviewExport'
import { parseReviewMarkup } from './reviewMarkup'
import { decideReviewChange, setReviewThreadStatus } from './reviewOperations'
import { semanticManuscriptObjects, semanticCrossReferenceLabel } from './semanticObjects'
import { parseStructuredManuscript, serializeStructuredManuscript } from './structuredManuscript'

const source = readFileSync(join(process.cwd(), 'src/fixtures/projects/alpha-article/paper.qmd'), 'utf8')

function authoringSnapshot(portableSource: string) {
  const parsed = parseStructuredManuscript(portableSource)
  const review = parseReviewMarkup(portableSource)
  return {
    objects: numberedManuscriptObjects(parsed.document).map((object) => ({
      kind: object.kind,
      label: object.label,
      number: object.number,
      caption: object.caption,
      unnumbered: object.unnumbered,
    })),
    references: semanticReferenceOccurrences(parsed.document).map((reference) => ({
      target: reference.target,
      status: reference.status,
      label: semanticCrossReferenceLabel(parsed.document, reference.target),
    })),
    outputs: parseRetainedOutputs(portableSource).outputs.map((output) => ({
      cellId: output.cellId,
      runHash: output.runHash,
      markdown: output.markdown,
    })),
    values: Object.fromEntries(Object.entries(parseRetainedPublishedValues(portableSource).values)
      .map(([name, value]) => [name, value.rendered])),
    reviews: {
      changes: review.changes.map((change) => ({ id: change.id, status: change.status, proposal: change.proposal })),
      threads: review.threads.map((thread) => ({ id: thread.id, status: thread.status, messages: thread.messages })),
      decisions: review.decisions.map((decision) => ({ changeId: decision.changeId, action: decision.action })),
    },
  }
}

describe('DM-P7-GATE alpha authoring workflow', () => {
  it('revises, exports, and reopens an article with matching friendly semantic state', () => {
    const originalDocument = parseReviewMarkup(source)
    const accepted = decideReviewChange(originalDocument, {
      changeId: 'dm-alpha-suggestion',
      action: 'accepted',
      authorId: 'dm-alpha-author',
      timestamp: '2026-07-18T09:00:00.000Z',
      decisionId: 'dm-alpha-decision',
    })
    const resolved = setReviewThreadStatus(
      accepted.document,
      'dm-alpha-thread',
      'resolved',
      '2026-07-18T09:01:00.000Z',
    )
    const revisedSource = resolved.document.source
    const parsed = parseStructuredManuscript(revisedSource)
    const semanticObjects = semanticManuscriptObjects(parsed.document)

    expect(referenceIntegrityDiagnostics(parsed.document)).toEqual([])
    expect(semanticObjects.filter((object) => object.kind !== 'section')).toHaveLength(6)
    expect(semanticObjects.every((object) => !object.legacyMachineLabel)).toBe(true)
    expect(semanticObjects.filter((object) => object.kind !== 'section').every((object) => object.label === object.suggestedLabel)).toBe(true)
    expect(numberedManuscriptObjects(parsed.document).map((object) => [object.kind, object.label, object.number, object.caption])).toEqual([
      ['figure', 'fig-python-canopy', 1, 'Python canopy trajectories across the measurement period.'],
      ['table', 'tbl-python-means', 1, 'Python treatment means.'],
      ['figure', 'fig-r-allocation', 2, 'R interval estimates for the allocation contrast.'],
      ['table', 'tbl-r-coefficients', 2, 'R model coefficients.'],
      ['figure', 'fig-julia-model', 3, 'Julia model fit against the observed canopy response.'],
      ['table', 'tbl-julia-predictions', 3, 'Julia grouped predictions.'],
    ])
    expect(semanticReferenceOccurrences(parsed.document).map((reference) => [reference.target, reference.status, semanticCrossReferenceLabel(parsed.document, reference.target)])).toEqual([
      ['fig-python-canopy', 'valid', 'Figure 1'],
      ['tbl-python-means', 'valid', 'Table 1'],
      ['fig-r-allocation', 'valid', 'Figure 2'],
      ['tbl-r-coefficients', 'valid', 'Table 2'],
      ['fig-julia-model', 'valid', 'Figure 3'],
      ['tbl-julia-predictions', 'valid', 'Table 3'],
    ])

    const serialized = serializeStructuredManuscript(parsed.document, parsed.metadata)
    expect(serialized).toBe(revisedSource)
    const reopened = parseStructuredManuscript(serialized)
    expect(serializeStructuredManuscript(reopened.document, reopened.metadata)).toBe(serialized)
    expect(authoringSnapshot(serialized)).toEqual(authoringSnapshot(revisedSource))
    expect(authoringSnapshot(serialized).reviews).toEqual({
      changes: [{ id: 'dm-alpha-suggestion', status: 'accepted', proposal: 'drought reduced mean canopy expansion by 18%' }],
      threads: [{ id: 'dm-alpha-thread', status: 'resolved', messages: ['Please retain the diagnostic threshold in the archived protocol.'] }],
      decisions: [{ changeId: 'dm-alpha-suggestion', action: 'accepted' }],
    })

    const clean = buildReviewExportBundle(serialized).final
    expect(clean).toBeDefined()
    const cleanParsed = parseStructuredManuscript(clean!)
    expect(numberedManuscriptObjects(cleanParsed.document)).toEqual(numberedManuscriptObjects(reopened.document))
    expect(referenceIntegrityDiagnostics(cleanParsed.document)).toEqual([])
    expect(parseRetainedOutputs(clean!).outputs.map((output) => output.markdown)).toEqual(parseRetainedOutputs(serialized).outputs.map((output) => output.markdown))

    const citationLabels = { '[@vezy2024; @chen2025]': '(Vezy & Martin, 2024; Chen, 2025)' }
    const bibliography = [
      { id: 'vezy2024', value: 'Vezy, R., & Martin, A. (2024). Reproducible canopy analysis across research environments.' },
      { id: 'chen2025', value: 'Chen, L. (2025). Portable evidence for drought-response synthesis.' },
    ]
    const html = renderNativeHtmlExport(clean!, { citationLabels, bibliography })
    const docx = new TextDecoder().decode(renderDocxExport(clean!, { citationLabels, bibliography }).bytes)

    for (const [label, visible] of [
      ['fig-python-canopy', 'Figure 1'],
      ['tbl-python-means', 'Table 1'],
      ['fig-r-allocation', 'Figure 2'],
      ['tbl-r-coefficients', 'Table 2'],
      ['fig-julia-model', 'Figure 3'],
      ['tbl-julia-predictions', 'Table 3'],
    ]) {
      expect(html).toContain(`href="#${label}">${visible}</a>`)
    }
    expect(html).toContain('<figcaption><strong>Figure 1.</strong> Python canopy trajectories across the measurement period.</figcaption>')
    expect(html).toContain('<caption><strong>Table 3.</strong> Julia grouped predictions.</caption>')
    expect(html).toContain('The drought reduced mean canopy expansion by 18%.')
    expect(html).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|println\(|@publish|\.dm-anchor|\.draftmatter-reviews|<script/)
    expect(docx).toContain('Ada Researcher; Lin Chen')
    expect(docx).toContain('Python canopy trajectories across the measurement period.')
    expect(docx).toContain('Julia grouped predictions.')
    expect(docx).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|println\(|@publish|\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
  })
})
