import { describe, expect, it } from 'vitest'
import {
  insertPortableSource,
  parseLosslessPortableSource,
  replacePortableSemanticNode,
  serializeLosslessPortableSource,
  type PortableSemanticNodeKind,
} from './portableSource'

interface SemanticExample {
  kind: PortableSemanticNodeKind
  source: string
  id: string
  replacement: string
}

const semanticExamples: SemanticExample[] = [
  {
    kind: 'citation',
    source: 'Evidence [@created2026].\n',
    id: 'citation:1',
    replacement: '[@martin2023; @vezy2024]',
  },
  {
    kind: 'code-cell',
    source: '```python {#cell-stable .execute output="figure"}\nprint("before")\n```\n',
    id: 'code:cell-stable',
    replacement: '```python {#cell-stable .execute output="figure"}\nprint("after")\n```\n',
  },
  {
    kind: 'output',
    source: '<!-- dm-output:start cell="cell-stable" run="sha256:before" -->\nOld output.\n<!-- dm-output:end -->\n',
    id: 'output:cell-stable',
    replacement: '<!-- dm-output:start cell="cell-stable" run="sha256:after" -->\nNew output.\n<!-- dm-output:end -->\n',
  },
  {
    kind: 'review-anchor',
    source: '[]{#dm-marker-stable .dm-anchor data-anchor="dm-range-stable" data-edge="start"}\n',
    id: 'anchor:dm-marker-stable',
    replacement: '[]{#dm-marker-stable .dm-anchor data-anchor="dm-range-stable" data-edge="point"}',
  },
  {
    kind: 'raw-markdown',
    source: '::: {#raw-stable .future-extension}\nOpaque payload.\n:::\n',
    id: 'raw:raw-stable',
    replacement: '::: {#raw-stable .future-extension}\nEdited opaque payload.\n:::\n',
  },
]

describe('portable semantic source transactions', () => {
  it.each(semanticExamples)('creates, saves, and reopens a $kind node with a stable ID', (example) => {
    const empty = parseLosslessPortableSource('')
    const created = insertPortableSource(empty, 0, example.source)
    const node = created.semanticNodes.find((candidate) => candidate.kind === example.kind)
    const saved = serializeLosslessPortableSource(created)
    const reopened = parseLosslessPortableSource(saved)

    expect(node).toMatchObject({ id: example.id, kind: example.kind })
    expect(saved).toBe(example.source)
    expect(reopened.semanticNodes.find((candidate) => candidate.id === example.id)).toEqual(node)
  })

  it.each(semanticExamples)('edits a $kind node without changing unrelated source bytes', (example) => {
    const prefix = 'Unrelated prefix.\n'
    const suffix = 'Unrelated suffix.\n'
    const original = parseLosslessPortableSource(`${prefix}${example.source}${suffix}`)
    const originalNode = original.semanticNodes.find((candidate) => candidate.id === example.id)

    expect(originalNode).toBeDefined()
    const edited = replacePortableSemanticNode(original, example.id, example.replacement)
    const saved = serializeLosslessPortableSource(edited)
    const reopened = parseLosslessPortableSource(saved)

    expect(saved.slice(0, prefix.length)).toBe(prefix)
    expect(saved.slice(-suffix.length)).toBe(suffix)
    expect(reopened.semanticNodes.find((candidate) => candidate.id === example.id)).toMatchObject({
      id: example.id,
      kind: example.kind,
      raw: example.replacement,
    })
  })

  it('rejects edits that would erase a semantic node identity', () => {
    const document = parseLosslessPortableSource('Evidence [@vezy2024].\n')

    expect(() => replacePortableSemanticNode(document, 'citation:1', 'plain text')).toThrow(
      'Replacement for citation:1 must remain a citation node with the same identity.',
    )
    expect(serializeLosslessPortableSource(document)).toBe('Evidence [@vezy2024].\n')
  })
})
