import { describe, expect, it } from 'vitest'
import { parseStructuredManuscript } from './structuredManuscript'
import {
  referenceIntegrityDiagnostics,
  resolveSemanticReference,
  semanticReferenceOccurrences,
} from './referenceIntegrity'

function document(source: string) {
  return parseStructuredManuscript(source).document
}

describe('semantic reference integrity', () => {
  it('distinguishes valid, missing, duplicate, and wrong-kind targets', () => {
    const manuscript = document(`See @fig-valid, @fig-missing, @fig-duplicate, and @tbl-mislabeled.

![Valid](valid.svg){#fig-valid}

![First duplicate](one.svg){#fig-duplicate}

![Second duplicate](two.svg){#fig-duplicate}

![Actually a figure](wrong.svg){#tbl-mislabeled}
`)

    expect(semanticReferenceOccurrences(manuscript).map(({ target, status }) => ({ target, status }))).toEqual([
      { target: 'fig-valid', status: 'valid' },
      { target: 'fig-missing', status: 'missing' },
      { target: 'fig-duplicate', status: 'duplicate' },
      { target: 'tbl-mislabeled', status: 'wrong-kind' },
    ])
    expect(resolveSemanticReference(manuscript, 'tbl-mislabeled')).toMatchObject({
      status: 'wrong-kind',
      expectedKind: 'table',
      objects: [expect.objectContaining({ kind: 'figure' })],
    })
    expect(referenceIntegrityDiagnostics(manuscript).map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'reference-target-duplicate-fig-duplicate',
      'reference-target-wrong-kind-tbl-mislabeled',
      'cross-reference-missing-fig-missing',
      'cross-reference-ambiguous-fig-duplicate',
      'cross-reference-wrong-kind-tbl-mislabeled',
    ]))
  })

  it('diagnoses reproducible targets only when source and retained output provenance disagree', () => {
    const manuscript = document(`\`\`\`julia {#cell-good .execute output="figure" reference="fig-good"}
plot_good()
\`\`\`

<!-- dm-output:start cell="cell-good" run="sha256:good" -->
![Good](good.svg){#fig-good}
<!-- dm-output:end -->

\`\`\`python {#cell-orphan .execute output="table" reference="tbl-orphan"}
make_table()
\`\`\`

<!-- dm-output:start cell="cell-missing" run="sha256:missing" -->
![Missing source](missing.svg){#fig-missing-source}
<!-- dm-output:end -->
`)
    const diagnostics = referenceIntegrityDiagnostics(manuscript)

    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringContaining('fig-good') }),
    ]))
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'reference-target-orphaned-tbl-orphan-cell-orphan', level: 'warning' }),
      expect.objectContaining({ code: 'reference-output-orphaned-fig-missing-source', level: 'warning' }),
    ]))
  })
})
