import { describe, expect, it } from 'vitest'
import {
  portableFixtureManifest,
  requiredPortableFixtureFeatures,
  type PortableFixtureFeature,
} from './portableFixtureManifest'
import { parseReviewMarkup } from './reviewMarkup'
import { projectPortableReviewSource } from './reviewProjector'
import { parseLosslessPortableSource, serializeLosslessPortableSource } from './portableSource'

const fixtureModules = import.meta.glob<string>('./fixtures/portable/*.{md,qmd}', {
  eager: true,
  import: 'default',
  query: '?raw',
})

function fixtureFilename(path: string) {
  return path.split('/').at(-1) ?? path
}

const sourceByFilename = new Map(
  Object.entries(fixtureModules).map(([path, source]) => [fixtureFilename(path), source]),
)

const featureChecks: Record<PortableFixtureFeature, (source: string) => boolean> = {
  yaml: (source) => /^---\r?\n/.test(source) && /\r?\n---\r?\n/.test(source),
  headings: (source) => /^#{1,6}[ \t]+\S/m.test(source),
  lists: (source) => /^(?:\s*[-+*]|\s*\d+[.)])\s+\S/m.test(source) || /^:\s+\S/m.test(source),
  citations: (source) => /\[[^\]]*@[a-zA-Z0-9_:.+-]+[^\]]*\]/.test(source),
  equations: (source) => /\$[^$]+\$/.test(source),
  footnotes: (source) => /\[\^[^\]]+\]|\^\[[^\]]+\]/.test(source),
  'raw-blocks': (source) => /```\{=\w+\}|<\w+[\s>]|:::\s*\{/.test(source),
  'executable-fences': (source) => /^(`{3,}|~{3,})(python|r|julia)\b[^\n]*\.execute/m.test(source),
  'output-markers': (source) => source.includes('<!-- dm-output:start') && source.includes('<!-- dm-output:end -->'),
  comments: (source) => source.includes('.dm-thread') && source.includes('.dm-message'),
  'identical-review-anchors': (source) => (source.match(/data-anchor="dm-r-identical"/g)?.length ?? 0) >= 4,
  'nested-review-anchors': (source) => source.includes('data-anchor="dm-r-outer"') && source.includes('data-anchor="dm-r-inner"'),
  'crossing-review-anchors': (source) => source.includes('data-anchor="dm-r-left"') && source.includes('data-anchor="dm-r-right"'),
  'unknown-syntax': (source) => source.includes('future-') || source.includes('## Résultats'),
}

describe('portable manuscript fixture corpus', () => {
  it('enumerates every fixture explicitly and loads at least thirty manuscripts', () => {
    const loaded = Object.keys(fixtureModules).map(fixtureFilename).sort()
    const declared = portableFixtureManifest.map((fixture) => fixture.filename).sort()

    expect(loaded).toHaveLength(30)
    expect(loaded).toEqual(declared)
    for (const [path, source] of Object.entries(fixtureModules)) {
      expect(source.trim(), `${fixtureFilename(path)} must not be empty`).not.toBe('')
    }
  })

  it('covers every syntax family required by the Phase 0 contract', () => {
    const covered = new Set(portableFixtureManifest.flatMap((fixture) => fixture.features))
    const missing = requiredPortableFixtureFeatures.filter((feature) => !covered.has(feature))

    expect(missing).toEqual([])
    for (const fixture of portableFixtureManifest) {
      const source = sourceByFilename.get(fixture.filename) ?? ''
      for (const feature of fixture.features) {
        expect(featureChecks[feature](source), `${fixture.filename} does not demonstrate ${feature}`).toBe(true)
      }
    }
  })

  it('round-trips and reopens every fixture without changing preserved bytes', () => {
    for (const fixture of portableFixtureManifest) {
      const source = sourceByFilename.get(fixture.filename) ?? ''
      const parsed = parseLosslessPortableSource(source)
      const serialized = serializeLosslessPortableSource(parsed)
      const reopened = parseLosslessPortableSource(serialized)

      expect(serialized, `${fixture.filename} changed during its first serialization`).toBe(source)
      expect(serializeLosslessPortableSource(reopened), `${fixture.filename} changed after reopening`).toBe(source)
      expect(reopened, `${fixture.filename} produced a non-deterministic syntax tree`).toEqual(parsed)

      let cursor = 0
      for (const node of parsed.nodes) {
        expect(node.start, `${fixture.filename} contains a gap or overlapping raw node`).toBe(cursor)
        expect(node.raw, `${fixture.filename} changed bytes in ${node.id}`).toBe(source.slice(node.start, node.end))
        cursor = node.end
      }
      expect(cursor, `${fixture.filename} was not consumed completely`).toBe(source.length)
    }
  })

  it('recognizes structural boundaries while leaving their raw source untouched', () => {
    const kinds = new Set(
      portableFixtureManifest.flatMap((fixture) => {
        const source = sourceByFilename.get(fixture.filename) ?? ''
        return parseLosslessPortableSource(source).nodes.map((node) => node.kind)
      }),
    )

    expect(kinds).toEqual(new Set([
      'frontmatter',
      'heading',
      'list',
      'executable-fence',
      'raw-block',
      'output',
      'review-section',
      'unknown',
      'text',
      'blank',
    ]))
  })

  it('preserves Windows line endings exactly', () => {
    const source = '---\r\ntitle: "Portable"\r\n---\r\n\r\n## Results\r\n\r\nText.\r\n'
    const parsed = parseLosslessPortableSource(source)

    expect(parsed.lineEnding).toBe('\r\n')
    expect(serializeLosslessPortableSource(parsed)).toBe(source)
  })

  it('produces deterministic clean Original and resolved Final projections for every fixture', () => {
    for (const fixture of portableFixtureManifest) {
      const source = sourceByFilename.get(fixture.filename) ?? ''
      const original = projectPortableReviewSource(source, { view: 'original' })

      expect(original.ok, `${fixture.filename} could not produce Original`).toBe(true)
      if (!original.ok) continue
      const originalReview = parseReviewMarkup(original.source)
      expect(originalReview.anchors, `${fixture.filename} leaked anchors into Original`).toEqual([])
      expect(originalReview.sectionStart, `${fixture.filename} leaked review records into Original`).toBeUndefined()
      expect(projectPortableReviewSource(source, { view: 'original' }), `${fixture.filename} Original was not deterministic`).toEqual(original)

      const unresolvedFinal = projectPortableReviewSource(source, { view: 'final' })
      const selectedChangeIds = unresolvedFinal.ok
        ? []
        : unresolvedFinal.conflicts.map((conflict) => conflict.candidates[0]?.changeId).filter((id): id is string => Boolean(id))
      const resolvedFinal = unresolvedFinal.ok
        ? unresolvedFinal
        : projectPortableReviewSource(source, { view: 'final', selectedChangeIds })

      expect(resolvedFinal.ok, `${fixture.filename} could not produce a resolved Final`).toBe(true)
      if (!resolvedFinal.ok) continue
      const finalReview = parseReviewMarkup(resolvedFinal.source)
      expect(finalReview.anchors, `${fixture.filename} leaked anchors into Final`).toEqual([])
      expect(finalReview.sectionStart, `${fixture.filename} leaked review records into Final`).toBeUndefined()
      expect(projectPortableReviewSource(source, { view: 'final', selectedChangeIds }), `${fixture.filename} Final was not deterministic`).toEqual(resolvedFinal)

      const preservedRaw = parseLosslessPortableSource(source).semanticNodes.filter((node) => node.kind === 'raw-markdown')
      for (const raw of preservedRaw) {
        expect(original.source, `${fixture.filename} lost unsupported raw node ${raw.id} in Original`).toContain(raw.raw)
        expect(resolvedFinal.source, `${fixture.filename} lost unsupported raw node ${raw.id} in Final`).toContain(raw.raw)
      }
    }
  })
})
