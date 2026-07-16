import { describe, expect, it } from 'vitest'
import { parsePublicationMetadata, removeDuplicateLeadingTitle, updatePublicationAuthors } from './publicationMetadata'

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
    expect(parsePublicationMetadata('---\nauthor: ["Researcher, Ada", "Lin #2"] # keep\n---\n').authors).toEqual([
      'Researcher, Ada',
      'Lin #2',
    ])
    expect(removeDuplicateLeadingTitle('\n# **Canopy** study {#title}\n\n## Results\n', 'Canopy study')).toBe('\n\n## Results\n')
    expect(removeDuplicateLeadingTitle('\n# A distinct section\n', 'Canopy study')).toBe('\n# A distinct section\n')
  })

  it('updates mapped author names while retaining affiliations and unrelated YAML bytes', () => {
    const source = `---\r
title: "Portable canopy study"\r
author:\r
  - name: "Ada Researcher" # corresponding\r
    orcid: 0000-0001-2345-6789\r
    affiliations:\r
      - Field Institute\r
  - Lin Reviewer\r
bibliography:\r
  - references.bib\r
format:\r
  html:\r
    toc: true\r
---\r
\r
# Portable canopy study\r
`

    const updated = updatePublicationAuthors(source, ['Ada Field', 'Lin Chen', 'Jo Newcomer'])

    expect(parsePublicationMetadata(updated).authors).toEqual(['Ada Field', 'Lin Chen', 'Jo Newcomer'])
    expect(updated).toContain('  - name: "Ada Field" # corresponding\r\n')
    expect(updated).toContain('    orcid: 0000-0001-2345-6789\r\n')
    expect(updated).toContain('      - Field Institute\r\n')
    expect(updated).toContain('  - "Lin Chen"\r\n')
    expect(updated).toContain('  - name: "Jo Newcomer"\r\n')
    expect(updated).toContain('bibliography:\r\n  - references.bib\r\nformat:\r\n  html:\r\n    toc: true\r\n')
    expect(parsePublicationMetadata(updated).body).toBe('\r\n# Portable canopy study\r\n')
  })

  it('does not transfer removed author details to a newly added person', () => {
    const source = `---
author:
  - name: "Ada Researcher"
    orcid: 0000-0001-2345-6789
  - "Lin Reviewer"
---
`

    const updated = updatePublicationAuthors(source, ['Lin Reviewer', 'Jo Newcomer'], [1, undefined])

    expect(parsePublicationMetadata(updated).authors).toEqual(['Lin Reviewer', 'Jo Newcomer'])
    expect(updated).not.toContain('0000-0001-2345-6789')
    expect(updated).toContain('  - "Lin Reviewer"\n')
    expect(updated).toContain('  - name: "Jo Newcomer"\n')
  })

  it('adds, removes, and creates author fields without rewriting the manuscript body', () => {
    const inline = '---\ntitle: Study\nauthor: [Ada, Lin] # editorial order\nbibliography: refs.bib\n---\n\n# Study\n'
    const one = updatePublicationAuthors(inline, ['Ada Revised'])
    expect(one).toContain('author: ["Ada Revised"] # editorial order\n')
    expect(parsePublicationMetadata(one).body).toBe('\n# Study\n')

    const removed = updatePublicationAuthors(one, [])
    expect(removed).not.toContain('author:')
    expect(removed).toContain('title: Study\nbibliography: refs.bib')

    const inserted = updatePublicationAuthors('---\ntitle: Study\n---\n\n# Study\n', ['Ada'])
    expect(inserted).toContain('title: Study\nauthor:\n  - "Ada"\n---')

    const created = updatePublicationAuthors('# Untitled study\n', ['Ada', 'Lin'])
    expect(created).toBe('---\nauthor:\n  - "Ada"\n  - "Lin"\n---\n\n# Untitled study\n')
    expect(parsePublicationMetadata(created)).toMatchObject({ authors: ['Ada', 'Lin'], body: '\n# Untitled study\n' })
  })

  it('refuses lossy edits to unsupported structured author names and invalid input', () => {
    const structured = '---\nauthor:\n  - name:\n      given: Ada\n      family: Researcher\n---\n'
    expect(() => updatePublicationAuthors(structured, ['Ada Researcher'])).toThrow(/source inspector/)
    expect(() => updatePublicationAuthors('# Study\n', ['Ada\nResearcher'])).toThrow(/one line/)
  })
})
