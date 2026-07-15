import { describe, expect, it } from 'vitest'
import {
  portableFixtureManifest,
  requiredPortableFixtureFeatures,
  type PortableFixtureFeature,
} from './portableFixtureManifest'

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
  yaml: (source) => source.startsWith('---\n') && source.includes('\n---\n'),
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
})
