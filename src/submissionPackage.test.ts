import { describe, expect, it } from 'vitest'
import { analyzeSubmission, buildSubmissionPackage, submissionProjectAssetPaths } from './submissionPackage'
import type { CitationRecord } from './types'

const source = `---
title: "Canopy response"
author:
  - name: Ada Researcher
    orcid: 0000-0002-1825-0097
    affiliations:
      - Field Institute
keywords: [canopy, drought]
---

## Abstract

We tested a reproducible canopy response.

## Results

Leaf area declined [@field2026].

![Canopy response](figures/canopy.svg){#fig-canopy}

## Data availability

Data are archived with the project.

## Competing interests

The authors declare no competing interests.

\`\`\`python {#analysis .execute}
raise RuntimeError("must not ship")
\`\`\`
`

const citation: CitationRecord = {
  citekey: 'field2026',
  type: 'article-journal',
  title: 'Field canopy measurements',
  authors: ['Ari Field'],
  year: '2026',
  container: 'Plant Journal',
  source: 'csl-json',
}

const options = {
  journal: 'Journal of Field Synthesis',
  articleType: 'Research article',
  correspondingAuthor: 'Ada Researcher',
  correspondingEmail: 'ada@example.org',
  reviewModel: 'identified' as const,
}

describe('journal submission package', () => {
  it('analyses portable submission metadata and project figures', () => {
    const analysis = analyzeSubmission(source, [citation], options)
    expect(analysis.errors).toBe(0)
    expect(analysis.title).toBe('Canopy response')
    expect(analysis.abstract).toContain('reproducible canopy response')
    expect(analysis.keywords).toEqual(['canopy', 'drought'])
    expect(analysis.citedKeys).toEqual(['field2026'])
    expect(analysis.figures).toEqual([expect.objectContaining({ source: 'figures/canopy.svg', packagedPath: 'figures/Figure1-canopy.svg' })])
    expect(submissionProjectAssetPaths(source)).toEqual(['figures/canopy.svg'])
  })

  it('builds a deterministic clean package with editable manuscript, metadata, references, and figures', () => {
    const input = {
      source,
      baseName: 'canopy-paper.qmd',
      options,
      citations: [citation],
      assets: [{ path: 'figures/canopy.svg', bytes: new TextEncoder().encode('<svg/>') }],
      docx: {
        citationLabels: { '[@field2026]': '(Field, 2026)' },
        bibliography: [{ id: 'field2026', value: 'Field, A. (2026). Field canopy measurements.' }],
      },
    }
    const first = buildSubmissionPackage(input)
    const second = buildSubmissionPackage(input)
    const readable = new TextDecoder().decode(first.bytes)

    expect(first.filename).toBe('canopy-paper-submission.zip')
    expect(first.bytes).toEqual(second.bytes)
    expect(first.files).toEqual(expect.arrayContaining([
      'README.txt',
      'manifest.json',
      'manuscript.docx',
      'submission-summary.html',
      'source/manuscript.qmd',
      'references/references.json',
      'figures/Figure1-canopy.svg',
    ]))
    expect(readable).toContain('Journal of Field Synthesis')
    expect(readable).toContain('figures/Figure1-canopy.svg')
    expect(readable).toContain('Field canopy measurements')
    expect(readable).not.toContain('must not ship')
    expect(readable).not.toContain('.draftmatter-reviews')
  })

  it('creates an anonymous manuscript copy without removing authors from the submission summary', () => {
    const result = buildSubmissionPackage({
      source,
      baseName: 'anonymous',
      options: { ...options, reviewModel: 'double-anonymous' },
      citations: [citation],
      assets: [{ path: 'figures/canopy.svg', bytes: new TextEncoder().encode('<svg/>') }],
    })
    const readable = new TextDecoder().decode(result.bytes)
    const manuscriptStart = readable.indexOf('source/manuscript.qmd')
    expect(readable).toContain('Ada Researcher')
    expect(readable.slice(manuscriptStart)).not.toContain('author:')
  })

  it('blocks remote figures and incomplete submission identity', () => {
    const remote = source.replace('figures/canopy.svg', 'https://example.org/canopy.svg')
    const analysis = analyzeSubmission(remote, [citation], { ...options, journal: '', correspondingEmail: 'invalid' })
    expect(analysis.errors).toBeGreaterThanOrEqual(3)
    expect(() => buildSubmissionPackage({ source: remote, baseName: 'paper', options: { ...options, journal: '', correspondingEmail: 'invalid' }, citations: [citation] })).toThrow(/blocking readiness/)
  })
})
