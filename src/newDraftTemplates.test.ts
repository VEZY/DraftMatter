import { describe, expect, it } from 'vitest'
import { buildNewDraftSource, portableDraftId } from './newDraftTemplates'
import { parsePublicationMetadata } from './publicationMetadata'

describe('new draft templates', () => {
  it('creates a portable IMRaD manuscript with user-supplied metadata', () => {
    const source = buildNewDraftSource('imrad', {
      title: 'Canopy "recovery"',
      leadAuthor: 'Ada Researcher',
      additionalAuthors: ['Lin Reviewer'],
      language: 'fr',
      citationStyle: 'draftmatter-numeric',
    })

    expect(parsePublicationMetadata(source)).toMatchObject({
      title: 'Canopy "recovery"',
      authors: ['Ada Researcher', 'Lin Reviewer'],
    })
    expect(source).toContain('lang: fr')
    expect(source).toContain('citation-style: draftmatter-numeric')
    expect(source).toContain('## Introduction {#sec-introduction}')
    expect(source).toContain('## Methods {#sec-methods}')
    expect(source).toContain('## Results {#sec-results}')
    expect(source).toContain('## Discussion {#sec-discussion}')
  })

  it('keeps blank manuscripts minimal and produces safe portable IDs', () => {
    const source = buildNewDraftSource('blank', {
      title: 'Étude 2026',
      leadAuthor: 'Zoé Dupont',
      language: 'en',
      citationStyle: 'draftmatter-author-date',
    })
    expect(source).toContain('# Étude 2026')
    expect(source).not.toContain('## Introduction')
    expect(portableDraftId(' Étude 2026 / Canopy ')).toBe('etude-2026-canopy')
    expect(portableDraftId('2026')).toBe('manuscript')
  })
})
