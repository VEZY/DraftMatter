import { describe, expect, it } from 'vitest'
import { formatCitationCluster, mergeCitationRecords, parseBibTeX, parseCslJson, searchCitations } from './bibliography'
import { sampleCitations } from './sampleCitations'

describe('local bibliography', () => {
  it('parses braced and quoted BibTeX fields', () => {
    const result = parseBibTeX(`
@article{vezy2024,
  title = {Plant {modelling} as a reproducible practice},
  author = {Vezy, Remi and Coutellier, Loïc and Martin, Alice},
  year = "2024",
  journal = {in silico Plants},
  doi = {https://doi.org/10.1093/insilicoplants/diae012}
}`)

    expect(result.diagnostics).toEqual([])
    expect(result.records[0]).toMatchObject({
      citekey: 'vezy2024',
      title: 'Plant modelling as a reproducible practice',
      authors: ['Remi Vezy', 'Loïc Coutellier', 'Alice Martin'],
      year: '2024',
      doi: '10.1093/insilicoplants/diae012',
    })
  })

  it('parses CSL JSON records', () => {
    const result = parseCslJson(JSON.stringify([{ id: 'martin2023', type: 'article-journal', title: 'Growth coordination', author: [{ given: 'Alice', family: 'Martin' }], issued: { 'date-parts': [[2023]] } }]))
    expect(result.records[0]).toMatchObject({ citekey: 'martin2023', authors: ['Alice Martin'], year: '2023' })
  })

  it('deduplicates by citation key and DOI', () => {
    const duplicate = { ...sampleCitations[0], citekey: 'different-key' }
    expect(mergeCitationRecords(sampleCitations, [sampleCitations[0], duplicate])).toHaveLength(sampleCitations.length)
  })

  it('searches title, author, year, and identifiers', () => {
    expect(searchCitations(sampleCitations, 'Coutellier drought').map((record) => record.citekey)).toEqual(['coutellier2022'])
    expect(searchCitations(sampleCitations, '19208')[0].citekey).toBe('martin2023')
  })

  it('formats compact author-year clusters', () => {
    expect(formatCitationCluster(sampleCitations, ['vezy2024', 'martin2023'])).toBe('(Vezy et al., 2024; Martin & Chen, 2023)')
  })
})
