import { describe, expect, it } from 'vitest'
import { summarizeSemanticGitDiff } from './semanticGitDiff'

describe('semantic Git diff', () => {
  it('renders readable prose separately from portable review metadata', () => {
    const summary = summarizeSemanticGitDiff(`diff --git a/paper.qmd b/paper.qmd
--- a/paper.qmd
+++ b/paper.qmd
@@ -2,3 +2,4 @@
-## Old result
-Leaf area stayed stable.
+## Results
+Leaf area declined by **18%**.
+[]{#dm-mark .dm-anchor data-anchor="range" data-edge="point"}
 ::::: {.draftmatter-reviews .hidden}
-:::: {#old .dm-change}
+:::: {#new .dm-change}
`)

    expect(summary).toMatchObject({ addedLines: 4, removedLines: 3, reviewLines: 3 })
    expect(summary.hunks).toEqual([{
      heading: '@@ -2,3 +2,4 @@',
      removed: ['Old result', 'Leaf area stayed stable.'],
      added: ['Results', 'Leaf area declined by 18%.'],
    }])
  })

  it('returns an empty rendered change for metadata-only diffs', () => {
    expect(summarizeSemanticGitDiff(`@@ -1 +1 @@
-[]{#a .dm-anchor data-anchor="a"}
+[]{#b .dm-anchor data-anchor="b"}
`)).toMatchObject({ addedLines: 1, removedLines: 1, reviewLines: 2, hunks: [] })
  })
})
