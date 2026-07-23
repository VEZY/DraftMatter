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
    expect(semanticObjects.filter((object) => object.kind !== 'section')).toHaveLength(7)
    expect(semanticObjects.every((object) => !object.legacyMachineLabel)).toBe(true)
    expect(semanticObjects.filter((object) => object.kind !== 'section').every((object) => object.label === object.suggestedLabel)).toBe(true)
    expect(numberedManuscriptObjects(parsed.document).map((object) => [object.kind, object.label, object.number, object.caption])).toEqual([
      ['equation', 'eq-canopy-response', 1, 'Linear treatment-by-time response used for the synthetic prediction check.'],
      ['figure', 'fig-python-canopy', 1, 'Canopy area trajectories generated in Python. Points are treatment means; the synthetic series contains 24 plants per treatment.'],
      ['table', 'tbl-python-means', 1, 'Week-12 canopy summaries generated in Python.'],
      ['figure', 'fig-r-allocation', 2, 'Allocation contrasts generated in R. Points are drought-minus-control estimates and horizontal lines are 95% confidence intervals.'],
      ['table', 'tbl-r-coefficients', 2, 'Drought-minus-control allocation contrasts generated in R.'],
      ['figure', 'fig-julia-model', 3, 'Observed and predicted canopy response generated in Julia. Points show synthetic observations and the line shows fitted values.'],
      ['table', 'tbl-julia-predictions', 3, 'Observed and fitted canopy means generated in Julia.'],
    ])
    expect(semanticReferenceOccurrences(parsed.document).map((reference) => [reference.target, reference.status, semanticCrossReferenceLabel(parsed.document, reference.target)])).toEqual([
      ['eq-canopy-response', 'valid', 'Equation 1'],
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
      changes: [{ id: 'dm-alpha-suggestion', status: 'accepted', proposal: 'drought treatment reduced canopy expansion by 18.4%' }],
      threads: [{ id: 'dm-alpha-thread', status: 'resolved', messages: [
        'Please confirm that the ±3.0 cm² diagnostic threshold was fixed before the model check.',
        'Confirmed. I added the threshold to the analysis plan and retained it in the bundled protocol note.',
      ] }],
      decisions: [{ changeId: 'dm-alpha-suggestion', action: 'accepted' }],
    })

    const clean = buildReviewExportBundle(serialized).final
    expect(clean).toBeDefined()
    const cleanParsed = parseStructuredManuscript(clean!)
    expect(numberedManuscriptObjects(cleanParsed.document)).toEqual(numberedManuscriptObjects(reopened.document))
    expect(referenceIntegrityDiagnostics(cleanParsed.document)).toEqual([])
    expect(parseRetainedOutputs(clean!).outputs.map((output) => output.markdown)).toEqual(parseRetainedOutputs(serialized).outputs.map((output) => output.markdown))

    const citationLabels = { '[@vezy2024; @chen2025]': '(Vezy & Martin, 2024; Chen & Silva, 2025)' }
    const bibliography = [
      { id: 'vezy2024', value: 'Vezy, R., & Martin, A. (2024). Portable evidence chains in multilingual plant phenotyping.' },
      { id: 'chen2025', value: 'Chen, L., & Silva, M. (2025). Review-aware drought analysis in executable manuscripts.' },
    ]
    const html = renderNativeHtmlExport(clean!, { citationLabels, bibliography })
    const docx = new TextDecoder().decode(renderDocxExport(clean!, { citationLabels, bibliography }).bytes)

    for (const [label, visible] of [
      ['eq-canopy-response', 'Equation 1'],
      ['fig-python-canopy', 'Figure 1'],
      ['tbl-python-means', 'Table 1'],
      ['fig-r-allocation', 'Figure 2'],
      ['tbl-r-coefficients', 'Table 2'],
      ['fig-julia-model', 'Figure 3'],
      ['tbl-julia-predictions', 'Table 3'],
    ]) {
      expect(html).toContain(`href="#${label}">${visible}</a>`)
    }
    expect(html).toContain('<figcaption><strong>Figure 1.</strong> Canopy area trajectories generated in Python. Points are treatment means; the synthetic series contains 24 plants per treatment.</figcaption>')
    expect(html).toContain('<caption><strong>Table 3.</strong> Observed and fitted canopy means generated in Julia.</caption>')
    expect(html).toContain('The drought treatment reduced canopy expansion by 18.4%.')
    expect(html).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|println\(|@publish|\.dm-anchor|\.draftmatter-reviews|<script/)
    expect(docx).toContain('Ada Researcher; Lin Chen; Marta Silva')
    expect(docx).toContain('Canopy area trajectories generated in Python.')
    expect(docx).toContain('Observed and fitted canopy means generated in Julia.')
    expect(docx).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|println\(|@publish|\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
  })
})
