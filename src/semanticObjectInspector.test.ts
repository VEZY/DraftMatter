import { describe, expect, it } from 'vitest'
import {
  rewriteRetainedOutputPresentation,
  updatePortableAttributeClass,
} from './StructuredManuscriptEditor'
import { retainedOutputPresentation } from './retainedOutputPresentation'
import { parseStructuredManuscript, serializeStructuredManuscript } from './structuredManuscript'

describe('semantic object inspector source edits', () => {
  it('rewrites a reproducible figure without exposing its source cell or losing retained metadata', () => {
    const source = `<!-- dm-output:start cell="cell-julia-private" run="sha256:run" -->
<!-- dm-published-value data="retained-value" -->
![Old description](figures/result.svg){#fig-old .wide data-owner="lab"}
: Old caption.
<!-- dm-output:end -->`

    const rewritten = rewriteRetainedOutputPresentation(source, {
      caption: 'Updated **caption**.',
      label: 'fig-response',
      alt: 'Accessible response curve',
      numbered: false,
    }, 'image')

    expect(rewritten).toContain('<!-- dm-output:start cell="cell-julia-private" run="sha256:run" -->')
    expect(rewritten).toContain('<!-- dm-published-value data="retained-value" -->')
    expect(rewritten).toContain('![Accessible response curve](figures/result.svg){#fig-response .wide data-owner="lab" .unnumbered}')
    expect(rewritten).toContain(': Updated **caption**.')
    expect(retainedOutputPresentation(rewritten, 'image')).toMatchObject({
      kind: 'image',
      label: 'fig-response',
      caption: 'Updated **caption**.',
      alt: 'Accessible response curve',
      unnumbered: true,
    })

    const manuscript = parseStructuredManuscript(`## Results\n\n${rewritten}\n`)
    const roundTripped = serializeStructuredManuscript(manuscript.document, manuscript.metadata)
    expect(roundTripped).toContain('![Accessible response curve](figures/result.svg){#fig-response .wide data-owner="lab" .unnumbered}')
    expect(roundTripped).toContain(': Updated **caption**.')
  })

  it('toggles only the requested portable display class', () => {
    expect(updatePortableAttributeClass('#fig-response .wide data-owner="lab"', 'unnumbered', true))
      .toBe('#fig-response .wide data-owner="lab" .unnumbered')
    expect(updatePortableAttributeClass('#fig-response .wide .unnumbered data-owner="lab"', 'unnumbered', false))
      .toBe('#fig-response .wide data-owner="lab"')
  })
})
