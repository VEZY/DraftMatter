import { describe, expect, it } from 'vitest'
import { prepareCollaborationCheckpointSource, referencedBibliographyPaths } from './collaborationProjectSnapshot'
import type { CitationRecord } from './types'

const citations: CitationRecord[] = [{ citekey: 'smith2026', source: 'csl-json', type: 'article-journal', title: 'A shared paper', authors: ['Smith, Ada'] }]

describe('portable collaboration project checkpoints', () => {
  it('resolves bibliography paths relative to a nested manuscript while keeping them inside the project', () => {
    const source = '---\ntitle: Paper\nbibliography: [../references.bib, local.json]\n---\nBody.'
    expect(referencedBibliographyPaths(source, 'analyses/paper.qmd')).toEqual(['references.bib', 'analyses/local.json'])
    const prepared = prepareCollaborationCheckpointSource(source, citations, '../references.json')
    expect(prepared).toBe('---\ntitle: Paper\nbibliography: ../references.json\n---\nBody.')
    expect(referencedBibliographyPaths(prepared, 'analyses/paper.qmd')).toEqual(['references.json'])
    expect(() => referencedBibliographyPaths(source.replace('../references.bib', '../../private.bib'), 'analyses/paper.qmd')).toThrow(/inside the project/)
    expect(() => referencedBibliographyPaths(source.replace('../references.bib', '/private.bib'), 'analyses/paper.qmd')).toThrow(/inside the project/)
  })
  it.each(['\n', '\r\n', '\r'])('rewrites bibliography lists while preserving other metadata and body bytes (%j)', (ending) => {
    const before = ['---', 'title: "A: careful title # unchanged"', 'bibliography:', '  - old.bib', '  - "another, library.json" # bibliography comment', 'csl: custom-journal.csl', 'custom:', '  nested: [one, two]', '---', '', '# Paper', '', 'Evidence [@smith2026].', ''].join(ending)
    const expected = before.replace(['bibliography:', '  - old.bib', '  - "another, library.json" # bibliography comment'].join(ending), 'bibliography: references.json')
    const after = prepareCollaborationCheckpointSource(before, citations)
    expect(after).toBe(expected)
    expect(referencedBibliographyPaths(before)).toEqual(['old.bib', 'another, library.json'])
    expect(referencedBibliographyPaths(after)).toEqual(['references.json'])
    expect(prepareCollaborationCheckpointSource(after, citations)).toBe(after)
  })

  it('recognizes quoted scalars, flow lists, comments, indentationless lists, and normalized duplicates', () => {
    expect(referencedBibliographyPaths('---\nbibliography: "refs # one.bib" # retained metadata\n---\n')).toEqual(['refs # one.bib'])
    expect(referencedBibliographyPaths('---\nbibliography: ["one, part.bib", \'O\'\'Brien.json\', ./plain.bib, plain.bib, ] # comment\n---\n')).toEqual(['one, part.bib', "O'Brien.json", 'plain.bib'])
    expect(referencedBibliographyPaths('---\nbibliography:\n- one.bib\n# between entries\n- two.bib\ntitle: Paper\n---\n')).toEqual(['one.bib', 'two.bib'])
    expect(prepareCollaborationCheckpointSource('---\nbibliography: [one.bib, two.bib]\nauthor: Ada\n---\nBody.', citations)).toBe('---\nbibliography: references.json\nauthor: Ada\n---\nBody.')
  })

  it('adds an ordinary reference path without normalizing manuscript bytes', () => {
    const body = '# Paper\r\n\r\nOpaque body \\*syntax\\*.\r\n'
    expect(prepareCollaborationCheckpointSource(body, citations)).toBe(`---\r\nbibliography: references.json\r\n---\r\n\r\n${body}`)
    expect(prepareCollaborationCheckpointSource('---\ntitle: Paper\n---\nBody.', citations)).toBe('---\ntitle: Paper\nbibliography: references.json\n---\nBody.')
    expect(prepareCollaborationCheckpointSource('---\nbibliography: old.bib\n---\nBody.', [])).toBe('---\nbibliography: old.bib\n---\nBody.')
  })

  it.each(['{ files: [old.bib] }', '*bibliographyAlias', '&anchor old.bib', '|\n  old.bib', '[old.bib, {file: other.bib}]', '"unterminated.bib'])('fails closed on unsupported or ambiguous bibliography YAML: %s', (value) => {
    const source = `---\ntitle: Paper\nbibliography: ${value}\n---\nBody.`
    expect(() => prepareCollaborationCheckpointSource(source, citations)).toThrow(/cannot be safely rewritten/)
    expect(() => referencedBibliographyPaths(source)).toThrow(/cannot be safely rewritten/)
  })

  it('rejects duplicate fields, unclosed metadata, and bibliography paths escaping the project', () => {
    expect(() => prepareCollaborationCheckpointSource('---\nbibliography: one.bib\nbibliography: two.bib\n---\n', citations)).toThrow(/duplicate bibliography/)
    expect(() => prepareCollaborationCheckpointSource('---\ntitle: Incomplete\n', citations)).toThrow(/closing delimiter/)
    expect(() => referencedBibliographyPaths('---\nbibliography: ../outside.bib\n---\n')).toThrow(/inside the project/)
  })
})
