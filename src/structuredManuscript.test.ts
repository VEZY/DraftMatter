import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { manuscriptSchema } from './manuscriptSchema'
import { parseStructuredManuscript, serializeStructuredManuscript, structuredCitationClusters } from './structuredManuscript'

const portableFixtures = import.meta.glob<string>('./fixtures/portable/*.{md,qmd}', {
  eager: true,
  import: 'default',
  query: '?raw',
})

const representativeSource = `---
title: "Generic manuscript"
bibliography: references.bib
---

# Generic manuscript

Evidence with **strong text**, *emphasis*, [a link](https://example.test "Evidence"), $x^2$, [see @vezy2024, p. 18], @fig-growth, and a note[^methods].

> A rendered quotation.

- First item
- Second item

| Treatment | Mean |
| --- | ---: |
| Drought | 18 |

![Growth response](figures/growth.svg "Growth"){#fig-growth}
: Growth response over time.

$$
E = mc^2
$$

[^methods]: Calibration details.

\`\`\`python {#fig-growth-code .execute output="figure" produces="figures/growth.svg"}
print("growth")
\`\`\`

<!-- dm-output:start cell="fig-growth-code" run="sha256:demo" -->
![Growth response](figures/growth.svg)
<!-- dm-output:end -->

::: {#future-widget .future-extension}
Opaque **future** syntax.
:::

Biomass changed[]{#dm-comment-point .dm-anchor data-anchor="dm-comment-01" data-edge="point" data-affinity="after"}.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-comment-01 .dm-thread data-anchor="dm-comment-01" data-author="dm-a01" data-status="open"}
~~~{.dm-message}
Please report the confidence interval.
~~~
::::
:::: {#dm-a01 .dm-author data-name="Alice Martin"}
::::
:::::
`

function nodeTypes(document: ReturnType<typeof parseStructuredManuscript>['document']) {
  const types = new Set<string>([document.type.name])
  document.descendants((node) => {
    types.add(node.type.name)
    for (const mark of node.marks) types.add(mark.type.name)
    return true
  })
  return types
}

function replaceFirstText(document: ReturnType<typeof parseStructuredManuscript>['document'], before: string, after: string) {
  let position: number | undefined
  document.descendants((node, nodePosition) => {
    if (position === undefined && node.isText && node.text?.includes(before)) {
      position = nodePosition + node.text.indexOf(before)
      return false
    }
    return position === undefined
  })
  if (position === undefined) throw new Error(`Text ${before} was not found.`)
  const state = EditorState.create({ schema: manuscriptSchema, doc: document })
  return state.apply(state.tr.insertText(after, position, position + before.length)).doc
}

describe('generic structured manuscript bridge', () => {
  it('opens every portable fixture as a valid editor document without changing source bytes', () => {
    expect(Object.keys(portableFixtures)).toHaveLength(30)
    for (const [path, source] of Object.entries(portableFixtures)) {
      const parsed = parseStructuredManuscript(source)
      expect(() => parsed.document.check(), `${path} produced an invalid ProseMirror document`).not.toThrow()
      expect(serializeStructuredManuscript(parsed.document, parsed.metadata), `${path} changed before an edit`).toBe(source)
    }
  })

  it('parses every supported rendered block and inline semantic node', () => {
    const parsed = parseStructuredManuscript(representativeSource)
    const types = nodeTypes(parsed.document)

    expect(types).toEqual(new Set([
      'doc', 'heading', 'text', 'paragraph', 'strong', 'emphasis', 'link', 'equation_inline', 'citation', 'cross_reference',
      'footnote_reference', 'blockquote', 'bullet_list', 'list_item', 'table', 'table_row', 'table_header', 'table_cell',
      'figure', 'image', 'caption', 'equation_block', 'footnote_definition', 'code_cell', 'output_block', 'raw_block', 'review_anchor',
    ]))
    expect(parsed.metadata.frontmatter).toContain('bibliography: references.bib')
    expect(parsed.metadata.reviewSection).toContain('.draftmatter-reviews')
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    let reference: typeof parsed.document | undefined
    parsed.document.descendants((node) => {
      if (node.type === manuscriptSchema.nodes.cross_reference) reference = node
      return reference === undefined
    })
    expect(reference?.attrs).toMatchObject({ target: 'fig-growth', rendered: 'Figure growth' })
    expect(parsed.document.textContent).toContain('Figure growth')
  })

  it('hides heading attributes while preserving their anchor and exact portable source', () => {
    const source = '## Background {#sec-background .unnumbered}\n'
    const parsed = parseStructuredManuscript(source)

    expect(parsed.document.firstChild?.textContent).toBe('Background')
    expect(parsed.document.firstChild?.attrs).toMatchObject({ label: 'sec-background', sourceAttributes: '#sec-background .unnumbered' })
    expect(serializeStructuredManuscript(replaceFirstText(parsed.document, 'Background', 'Context'), parsed.metadata))
      .toBe('## Context {#sec-background .unnumbered}\n')

    const literal = parseStructuredManuscript('## Set {A}\n')
    expect(literal.document.firstChild?.textContent).toBe('Set {A}')
    expect(literal.document.firstChild?.attrs.sourceAttributes).toBeNull()
  })

  it('preserves figure attributes while exposing a semantic cross-reference target', () => {
    const source = '# Figures\n\nIntroductory text.\n\n![Canopy](figures/canopy.svg "Observed canopy"){#fig-canopy .wide data-credit="Field team"}\n: Canopy response over time.\n'
    const parsed = parseStructuredManuscript(source)
    const figure = parsed.document.lastChild
    const image = figure?.firstChild

    expect(image?.attrs).toMatchObject({
      src: 'figures/canopy.svg',
      alt: 'Canopy',
      title: 'Observed canopy',
      label: 'fig-canopy',
      sourceAttributes: '#fig-canopy .wide data-credit="Field team"',
    })
    const edited = replaceFirstText(parsed.document, 'Introductory', 'Updated')
    const saved = serializeStructuredManuscript(edited, parsed.metadata)
    expect(saved).toContain('![Canopy](figures/canopy.svg "Observed canopy"){#fig-canopy .wide data-credit="Field team"}')
    expect(parseStructuredManuscript(saved).document.lastChild?.firstChild?.attrs.sourceAttributes)
      .toBe('#fig-canopy .wide data-credit="Field team"')
  })

  it('round-trips table captions, labels, attributes, and column alignment after an edit', () => {
    const source = '# Tables\n\nSee @tbl-yield for the summary.\n\n| Treatment | Mean | Range |\n| :--- | ---: | :---: |\n| Dry | 18 | 16–20 |\n: Yield **summary**. {#tbl-yield .striped data-owner="Field team"}\n'
    const parsed = parseStructuredManuscript(source)
    const table = parsed.document.lastChild

    expect(table?.attrs).toMatchObject({
      captionMarkdown: 'Yield **summary**.',
      label: 'tbl-yield',
      sourceAttributes: '#tbl-yield .striped data-owner="Field team"',
    })
    expect([0, 1, 2].map((index) => table?.firstChild?.child(index).attrs.alignment)).toEqual(['left', 'right', 'center'])
    const edited = replaceFirstText(parsed.document, 'summary.', 'overview.')
    const saved = serializeStructuredManuscript(edited, parsed.metadata)
    expect(saved).toContain('| :--- | ---: | :---: |')
    expect(saved).toContain(': Yield **summary**. {#tbl-yield .striped data-owner="Field team"}')
    expect(saved).toContain('See @tbl-yield for the overview.')
    const reopened = parseStructuredManuscript(saved).document.lastChild
    expect([0, 1, 2].map((index) => reopened?.firstChild?.child(index).attrs.alignment)).toEqual(['left', 'right', 'center'])
  })

  it('reopens labeled display equations without consuming following manuscript blocks', () => {
    const source = '$$\nE = mc^2\n$$ {#eq-mass .unnumbered}\n\nParagraph after math.\n'
    const parsed = parseStructuredManuscript(source)

    expect(parsed.document.childCount).toBe(2)
    expect(parsed.document.firstChild?.type).toBe(manuscriptSchema.nodes.equation_block)
    expect(parsed.document.firstChild?.attrs).toMatchObject({
      tex: 'E = mc^2',
      label: 'eq-mass',
      sourceAttributes: '#eq-mass .unnumbered',
    })
    expect(parsed.document.lastChild?.textContent).toBe('Paragraph after math.')
    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(source)
  })

  it('preserves an unclosed display equation as raw source with a visible diagnostic', () => {
    const source = '$$\nE = mc^2\nParagraph that must not disappear.\n'
    const parsed = parseStructuredManuscript(source)

    expect(parsed.document.firstChild?.type).toBe(manuscriptSchema.nodes.raw_block)
    expect(parsed.document.firstChild?.attrs.raw).toBe(source)
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: 'equation-unclosed', level: 'warning' }))
  })

  it('enumerates citation clusters across arbitrary sections for CSL rendering and cache diagnostics', () => {
    expect(structuredCitationClusters(representativeSource)).toEqual([
      expect.objectContaining({
        items: [{ citekey: 'vezy2024', prefix: 'see', locator: 'p. 18' }],
        signature: '[see @vezy2024, p. 18]',
      }),
    ])
  })

  it('renders retained published values while preserving portable markup', () => {
    const retained = encodeURIComponent(JSON.stringify({
      version: 1, name: 'mean_area', value: 18.4, unit: 'cm²', formatting: { digits: 1 }, rendered: '18.4 cm²',
      provenance: { cellId: 'summary', language: 'python', runHash: 'sha256:run', codeHash: 'sha256:code', environmentFingerprint: 'sha256:env', sessionGeneration: 1, executionSequence: 1, retainedOutputHashes: ['sha256:run'] },
    }))
    const source = `Estimate: {{mean_area}}. Missing: {{confidence_interval}}.\n\n\`\`\`julia {#interval .execute output="values"}\n@publish confidence_interval digits=2\n\`\`\`\n\n<!-- dm-output:start cell="summary" run="sha256:run" -->\n<!-- dm-published-value data="${retained}" -->\n<!-- dm-output:end -->\n`
    const parsed = parseStructuredManuscript(source)
    const values: Array<Record<string, unknown>> = []
    parsed.document.descendants((node) => {
      if (node.type === manuscriptSchema.nodes.published_value) values.push(node.attrs)
      return true
    })

    expect(values).toEqual([
      expect.objectContaining({ name: 'mean_area', rendered: '18.4 cm²', cellId: 'summary', status: 'current' }),
      expect.objectContaining({ name: 'confidence_interval', rendered: 'Value unavailable', status: 'missing', language: 'julia' }),
    ])
    expect(parsed.document.textContent).toContain('Estimate: 18.4 cm². Missing: Value unavailable.')
    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(source)
  })

  it('returns an untouched manuscript byte-for-byte until a structured transaction changes it', () => {
    const parsed = parseStructuredManuscript(representativeSource)

    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(representativeSource)

    const edited = replaceFirstText(parsed.document, 'Evidence', 'Updated evidence')
    const saved = serializeStructuredManuscript(edited, parsed.metadata)
    const reopened = parseStructuredManuscript(saved)

    expect(saved).toContain('Updated evidence with **strong text**')
    expect(saved).toContain('@fig-growth')
    expect(saved).not.toContain('Figure growth')
    expect(saved).toContain('::: {#future-widget .future-extension}\nOpaque **future** syntax.\n:::')
    expect(saved).toContain('[]{#dm-comment-point .dm-anchor data-anchor="dm-comment-01" data-edge="point" data-affinity="after"}')
    expect(saved).toContain('::::: {.draftmatter-reviews .hidden data-schema="1"}')
    expect(reopened.document.textContent).toContain('Updated evidence')
    expect(nodeTypes(reopened.document)).toEqual(nodeTypes(parsed.document))
    expect(serializeStructuredManuscript(reopened.document, reopened.metadata)).toBe(saved)
  })

  it('preserves CRLF metadata and opaque raw bytes after a rendered edit', () => {
    const source = '---\r\ntitle: CRLF\r\n---\r\n\r\n# Heading\r\n\r\n::: {.future}\r\nOpaque payload.\r\n:::\r\n'
    const parsed = parseStructuredManuscript(source)
    const edited = replaceFirstText(parsed.document, 'Heading', 'Revised heading')
    const saved = serializeStructuredManuscript(edited, parsed.metadata)

    expect(saved).toContain('# Revised heading\r\n')
    expect(saved).toContain('::: {.future}\r\nOpaque payload.\r\n:::')
    expect(saved.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('preserves unknown review-anchor classes and attributes during unrelated edits', () => {
    const source = '# Reviewable\n\nClaim[]{#dm-point .dm-anchor .vendor-anchor data-anchor="dm-comment" data-edge="point" data-vendor="keep:exactly" aria-label="Review point"}.\n'
    const parsed = parseStructuredManuscript(source)
    const edited = replaceFirstText(parsed.document, 'Claim', 'Revised claim')
    const saved = serializeStructuredManuscript(edited, parsed.metadata)

    expect(saved).toContain('[]{#dm-point .dm-anchor .vendor-anchor data-anchor="dm-comment" data-edge="point" data-vendor="keep:exactly" aria-label="Review point"}')
  })

  it('keeps non-executable fences as visible preserved raw nodes', () => {
    const source = '```text\n[@literal] []{#literal .dm-anchor}\n```\n'
    const parsed = parseStructuredManuscript(source)

    expect(parsed.document.firstChild?.type).toBe(manuscriptSchema.nodes.raw_block)
    expect(parsed.document.firstChild?.attrs.raw).toBe(source)
    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(source)
  })
})
