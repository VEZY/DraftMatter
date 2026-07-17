import { describe, expect, it } from 'vitest'
import { projectComputationsForPublication } from './publicationComputation'

describe('publication computation projection', () => {
  it('removes executable source, retains outputs, and resolves named values', () => {
    const source = `The estimate was {{dm:value:estimate}}.

\`\`\`python {#analysis .execute output="values"}
print("DRAFTMATTER_VALUE estimate=12.4")
\`\`\`

<!-- dm-output:start cell="analysis" run="sha256:run" -->
<!-- dm-value key="estimate" value="12.4" -->

| treatment | mean |
| --- | --- |
| dry | 12.4 |
<!-- dm-output:end -->
`
    const projected = projectComputationsForPublication(source)

    expect(projected).toContain('The estimate was 12.4.')
    expect(projected).toContain('| dry | 12.4 |')
    expect(projected).not.toContain('print(')
    expect(projected).not.toContain('dm-value')
  })

  it('keeps ordinary non-executable code examples', () => {
    const source = '```text\nThis is an example, not a computation.\n```\n'
    expect(projectComputationsForPublication(source)).toBe(source)
  })
})
