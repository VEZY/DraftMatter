import { describe, expect, it } from 'vitest'
import { parseBibTeX } from './bibliography'
import { CITATION_INTAKE_MAX_BYTES, CITATION_INTAKE_MAX_RECORDS, previewCitationIntake } from './citationIntake'
import endnoteFixture from './fixtures/bibliography/multi-record.enw?raw'
import risFixture from './fixtures/bibliography/multi-record.ris?raw'
import { sampleCitations } from './sampleCitations'

describe('citation paste/drop intake', () => {
  it.each([
    ['bibtex', '@article{quiet2024, title={Quiet work}, author={Martin, Alice}, year={2024}}', 'quiet2024'],
    ['csl-json', JSON.stringify({ id: 'quiet-json', type: 'book', title: 'Quiet JSON', author: [{ family: 'Chen' }] }), 'quiet-json'],
    ['ris', risFixture, 'dupont2024canopy'],
    ['endnote', endnoteFixture, 'martin2023growth'],
  ] as const)('previews %s metadata offline without changing the payload', (format, payload, citekey) => {
    const preview = previewCitationIntake(payload)

    expect(preview.format).toBe(format)
    expect(preview.originalPayload).toBe(payload)
    expect(preview.records[0].record.citekey).toBe(citekey)
  })

  it('recognizes exact DOI text and URLs without pretending metadata is already available', () => {
    for (const payload of ['10.1016/j.envsoft.2019.104609', 'https://doi.org/10.1016/j.envsoft.2019.104609']) {
      expect(previewCitationIntake(payload)).toMatchObject({
        format: 'doi',
        doi: '10.1016/j.envsoft.2019.104609',
        originalPayload: payload,
        records: [],
        diagnostics: [expect.objectContaining({ code: 'citation-intake-doi-resolution-required' })],
      })
    }
  })

  it('suggests key and DOI duplicates without merging or selecting them', () => {
    const record = parseBibTeX('@article{vezy2024, title={A different title}, doi={10.1093/insilicoplants/diae012}}').records[0]
    const preview = previewCitationIntake('@article{vezy2024, title={A different title}, doi={10.1093/insilicoplants/diae012}}', sampleCitations)

    expect(record.title).toBe('A different title')
    expect(preview.records[0]).toMatchObject({ duplicateCitekeys: ['vezy2024'], selectedByDefault: false })
    expect(preview.records[0].record.title).toBe('A different title')
  })

  it('keeps malformed and oversized payloads available with actionable diagnostics', () => {
    const malformed = '{"id":'
    const invalid = previewCitationIntake(malformed)
    expect(invalid.originalPayload).toBe(malformed)
    expect(invalid.records).toEqual([])
    expect(invalid.diagnostics).toEqual([expect.objectContaining({ code: 'csl-invalid', level: 'error' })])

    const oversizedPayload = `@comment{${'x'.repeat(CITATION_INTAKE_MAX_BYTES)}}`
    const oversized = previewCitationIntake(oversizedPayload)
    expect(oversized.oversized).toBe(true)
    expect(oversized.originalPayload).toBe(oversizedPayload)
    expect(oversized.diagnostics).toEqual([expect.objectContaining({ code: 'citation-intake-oversized', level: 'error' })])
  })

  it('caps large multi-record previews without discarding the source', () => {
    const payload = Array.from({ length: CITATION_INTAKE_MAX_RECORDS + 2 }, (_, index) => `@article{item${index}, title={Item ${index}}}`).join('\n')
    const preview = previewCitationIntake(payload)

    expect(preview.records).toHaveLength(CITATION_INTAKE_MAX_RECORDS)
    expect(preview.originalPayload).toBe(payload)
    expect(preview.diagnostics).toContainEqual(expect.objectContaining({ code: 'citation-intake-record-limit', level: 'error' }))
  })
})
