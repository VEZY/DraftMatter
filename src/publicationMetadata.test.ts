import { describe, expect, it } from 'vitest'
import { parsePublicationMetadata, removeDuplicateLeadingTitle } from './publicationMetadata'

describe('publication metadata', () => {
  it('reads scalar and mapped author lists without absorbing unrelated YAML arrays', () => {
    const parsed = parsePublicationMetadata(`---
title: "Portable canopy study"
author:
  - name: "Ada Researcher"
    affiliations:
      - Field Institute
  - Lin Reviewer
bibliography:
  - references.bib
---

# Portable canopy study
`)

    expect(parsed.title).toBe('Portable canopy study')
    expect(parsed.authors).toEqual(['Ada Researcher', 'Lin Reviewer'])
    expect(parsed.body).toContain('# Portable canopy study')
  })

  it('supports inline authors and removes only a matching leading manuscript title', () => {
    expect(parsePublicationMetadata('---\nauthor: [Ada Researcher, "Lin Reviewer"]\n---\n').authors).toEqual([
      'Ada Researcher',
      'Lin Reviewer',
    ])
    expect(removeDuplicateLeadingTitle('\n# **Canopy** study {#title}\n\n## Results\n', 'Canopy study')).toBe('\n\n## Results\n')
    expect(removeDuplicateLeadingTitle('\n# A distinct section\n', 'Canopy study')).toBe('\n# A distinct section\n')
  })
})
