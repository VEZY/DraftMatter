export const requiredPortableFixtureFeatures = [
  'yaml',
  'headings',
  'lists',
  'citations',
  'equations',
  'footnotes',
  'raw-blocks',
  'executable-fences',
  'output-markers',
  'comments',
  'identical-review-anchors',
  'nested-review-anchors',
  'crossing-review-anchors',
  'unknown-syntax',
] as const

export type PortableFixtureFeature = typeof requiredPortableFixtureFeatures[number]

export interface PortableFixtureManifestEntry {
  filename: `${string}.${'md' | 'qmd'}`
  features: PortableFixtureFeature[]
}

export const portableFixtureManifest: PortableFixtureManifestEntry[] = [
  { filename: '01-yaml-basic.qmd', features: ['yaml'] },
  { filename: '02-yaml-complex.qmd', features: ['yaml'] },
  { filename: '03-headings-atx.md', features: ['headings'] },
  { filename: '04-headings-numbered.qmd', features: ['headings'] },
  { filename: '05-list-unordered.md', features: ['lists'] },
  { filename: '06-list-ordered.md', features: ['lists'] },
  { filename: '07-list-task.qmd', features: ['lists'] },
  { filename: '08-list-definition.qmd', features: ['lists'] },
  { filename: '09-citation-single.qmd', features: ['citations'] },
  { filename: '10-citation-cluster.qmd', features: ['citations'] },
  { filename: '11-citation-locator.qmd', features: ['citations'] },
  { filename: '12-equation-inline.md', features: ['equations'] },
  { filename: '13-equation-display.qmd', features: ['equations'] },
  { filename: '14-footnote-reference.md', features: ['footnotes'] },
  { filename: '15-footnote-inline.qmd', features: ['footnotes'] },
  { filename: '16-raw-html.md', features: ['raw-blocks'] },
  { filename: '17-raw-latex.qmd', features: ['raw-blocks'] },
  { filename: '18-fenced-div.qmd', features: ['raw-blocks'] },
  { filename: '19-cell-python.qmd', features: ['executable-fences'] },
  { filename: '20-cell-r.qmd', features: ['executable-fences'] },
  { filename: '21-cell-julia.qmd', features: ['executable-fences'] },
  { filename: '22-output-image.qmd', features: ['output-markers'] },
  { filename: '23-output-table.qmd', features: ['output-markers'] },
  { filename: '24-comment-thread.qmd', features: ['comments'] },
  { filename: '25-review-identical.qmd', features: ['identical-review-anchors'] },
  { filename: '26-review-nested.qmd', features: ['nested-review-anchors'] },
  { filename: '27-review-crossing.qmd', features: ['crossing-review-anchors'] },
  { filename: '28-unknown-directive.qmd', features: ['unknown-syntax'] },
  { filename: '29-unicode-manuscript.md', features: ['unknown-syntax'] },
  { filename: '30-mixed-manuscript.qmd', features: ['yaml', 'headings', 'lists', 'citations', 'equations', 'footnotes', 'raw-blocks', 'executable-fences', 'output-markers', 'comments'] },
]
