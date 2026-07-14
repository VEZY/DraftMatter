import type { DraftState } from './types'

const REVIEW_START = '::::: {.draftmatter-reviews .hidden data-schema="1"}'
const REVIEW_END = ':::::'

function proposalSentence(state: DraftState, view: 'original' | 'final') {
  if (view === 'original') return 'did not substantially alter leaf expansion'
  if (state.aliceStatus === 'accepted' || (state.aliceStatus === 'open' && state.activeProposal === 'alice')) {
    return 'reduced leaf area by 18%'
  }
  if (state.marcusStatus === 'accepted' || (state.marcusStatus === 'open' && state.activeProposal === 'marcus')) {
    return 'lowered leaf expansion during the treatment period'
  }
  return 'did not substantially alter leaf expansion'
}

export function cleanProjection(state: DraftState, view: 'original' | 'final') {
  const result = proposalSentence(state, view)
  const citation = state.citationInserted ? ' [@vezy2024; @martin2023]' : ' [@vezy2024]'

  return `---
title: "${state.title.replaceAll('"', '\\"')}"
author:
  - Remi Vezy
  - Alice Martin
bibliography: references.bib
format: html
---

## Abstract

${state.abstract}

## Introduction

${state.introduction}${citation}

## Methods

${state.methods}

\`\`\`python {#fig-canopy .execute output="figure"}
${state.code}
\`\`\`

<!-- dm-output:start cell="fig-canopy" run="sha256:6f42f1a" -->
![Leaf area response over twelve weeks](figures/generated/fig-canopy.svg){#fig-canopy-result}
<!-- dm-output:end -->

## Results

${state.resultsLead} The drought treatment ${result}, while root allocation increased modestly [@coutellier2022].

## Conclusion

${state.conclusion}
`
}

export function reviewedProjection(state: DraftState) {
  const replyBlocks = state.commentReplies
    .map((reply, index) => `~~~{.dm-message data-author="dm-a01" data-index="${index + 1}"}\n${reply}\n~~~`)
    .join('\n')

  return `---
title: "${state.title.replaceAll('"', '\\"')}"
author:
  - Remi Vezy
  - Alice Martin
bibliography: references.bib
format: html
---

## Abstract

${state.abstract}

## Introduction

${state.introduction} [@vezy2024]

## Methods

${state.methods}

\`\`\`python {#fig-canopy .execute output="figure"}
${state.code}
\`\`\`

<!-- dm-output:start cell="fig-canopy" run="sha256:6f42f1a" -->
![Leaf area response over twelve weeks](figures/generated/fig-canopy.svg){#fig-canopy-result}
<!-- dm-output:end -->

## Results

${state.resultsLead} The drought treatment []{#dm-m01 .dm-anchor data-anchor="dm-r01" data-edge="start" data-affinity="after"}did not substantially alter leaf expansion[]{#dm-m02 .dm-anchor data-anchor="dm-r01" data-edge="end" data-affinity="before"}, while root allocation []{#dm-cm01 .dm-anchor data-anchor="dm-comment-01" data-edge="start" data-affinity="after"}increased modestly[]{#dm-cm02 .dm-anchor data-anchor="dm-comment-01" data-edge="end" data-affinity="before"} [@coutellier2022].

## Conclusion

${state.conclusion}

${REVIEW_START}
:::: {#dm-c01 .dm-change data-anchor="dm-r01" data-kind="replace" data-author="dm-a01" data-status="${state.aliceStatus}"}
~~~{.dm-proposal}
reduced leaf area by 18%
~~~
~~~{.dm-rationale}
State the measured effect directly.
~~~
::::
:::: {#dm-c02 .dm-change data-anchor="dm-r01" data-kind="replace" data-author="dm-a02" data-status="${state.marcusStatus}"}
~~~{.dm-proposal}
lowered leaf expansion during the treatment period
~~~
~~~{.dm-rationale}
Keep the interpretation conservative.
~~~
::::
:::: {#dm-comment-01 .dm-thread data-anchor="dm-comment-01" data-author="dm-a02" data-status="${state.commentResolved ? 'resolved' : 'open'}"}
~~~{.dm-message}
Can we quantify this increase in the main text?
~~~
${replyBlocks}
::::
:::: {#dm-a01 .dm-author data-name="Alice Martin"}
::::
:::: {#dm-a02 .dm-author data-name="Marcus Chen"}
::::
${REVIEW_END}
`
}

export function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
