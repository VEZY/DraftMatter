import type { DocumentDiagnostic, DraftState, SectionKey } from './types'
import { projectPortableReviewSource } from './reviewProjector'
import { materializePortableDraftSource } from './portableDraft'
import { citationItemsForDraft, serializeCitationCluster } from './citation'

const REVIEW_START = '::::: {.draftmatter-reviews .hidden data-schema="1"}'
const REVIEW_END = ':::::'

export type CleanProjectionResult =
  | { ok: true; source: string; diagnostics: DocumentDiagnostic[] }
  | { ok: false; source: null; diagnostics: DocumentDiagnostic[] }

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

function frontmatter(state: DraftState) {
  if (state.frontmatterSource) {
    const replaced = state.frontmatterSource.replace(
      /^(title\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|.+)$/m,
      `$1"${state.title.replaceAll('"', '\\"')}"`,
    )
    if (/^title\s*:/m.test(replaced)) return replaced.trim()
    return replaced.replace(/^---\s*$/m, `---\ntitle: "${state.title.replaceAll('"', '\\"')}"` ).trim()
  }

  return `---
title: "${state.title.replaceAll('"', '\\"')}"
author:
  - Remi Vezy
  - Alice Martin
bibliography: references.bib
format: html
---`
}

function preservedAfter(state: DraftState, section: SectionKey) {
  const blocks = state.preservedSections?.filter((item) => item.after === section) ?? []
  return blocks.length ? `\n\n${blocks.map((item) => item.markdown.trim()).join('\n\n')}` : ''
}

export function cleanProjection(state: DraftState, view: 'original' | 'final') {
  const result = proposalSentence(state, view)
  const citation = ` ${serializeCitationCluster(citationItemsForDraft(state))}`

  return `${frontmatter(state)}${preservedAfter(state, 'frontmatter')}

## Abstract

${state.abstract}${preservedAfter(state, 'abstract')}

## Introduction

${state.introduction}${citation}${preservedAfter(state, 'introduction')}

## Methods

${state.methods}

\`\`\`python {#fig-canopy .execute output="figure" produces="figures/generated/fig-canopy.svg"}
${state.code}
\`\`\`

<!-- dm-output:start cell="fig-canopy" run="sha256:6f42f1a" -->
![Leaf area response over twelve weeks](figures/generated/fig-canopy.svg){#fig-canopy-result}
<!-- dm-output:end -->
${preservedAfter(state, 'methods')}

## Results

${state.resultsLead} The drought treatment ${result}, while root allocation increased modestly [@coutellier2022].${preservedAfter(state, 'results')}

## Conclusion

${state.conclusion}${preservedAfter(state, 'conclusion')}
`
}

export function projectCleanSource(state: DraftState, view: 'original' | 'final'): CleanProjectionResult {
  const projected = projectPortableReviewSource(reviewedProjection(state), { view })
  return projected.ok
    ? { ok: true, source: projected.source, diagnostics: projected.diagnostics }
    : { ok: false, source: null, diagnostics: projected.diagnostics }
}

export function projectCurrentManuscriptSource(
  source: string,
  state: DraftState,
  structuredMode: boolean,
  view: 'original' | 'final',
): CleanProjectionResult {
  if (!structuredMode) return projectCleanSource(state, view)
  const projected = projectPortableReviewSource(source, { view })
  return projected.ok
    ? { ok: true, source: projected.source, diagnostics: projected.diagnostics }
    : { ok: false, source: null, diagnostics: projected.diagnostics }
}

export function reviewedProjection(state: DraftState) {
  const materialized = materializePortableDraftSource(state)
  if (materialized !== null) return materialized
  const citation = ` ${serializeCitationCluster(citationItemsForDraft(state))}`
  const replyBlocks = state.commentReplies
    .map((reply, index) => {
      const timestamp = state.commentReplyTimestamps?.[index]
      return `~~~{.dm-message data-author="dm-a01"${timestamp ? ` data-at="${timestamp}"` : ''} data-index="${index + 1}"}\n${reply}\n~~~`
    })
    .join('\n')
  const aliceUpdated = state.reviewUpdatedAt?.alice ? ` data-updated="${state.reviewUpdatedAt.alice}"` : ''
  const marcusUpdated = state.reviewUpdatedAt?.marcus ? ` data-updated="${state.reviewUpdatedAt.marcus}"` : ''
  const commentUpdated = state.reviewUpdatedAt?.comment ? ` data-updated="${state.reviewUpdatedAt.comment}"` : ''

  return `${frontmatter(state)}${preservedAfter(state, 'frontmatter')}

## Abstract

${state.abstract}${preservedAfter(state, 'abstract')}

## Introduction

${state.introduction}${citation}${preservedAfter(state, 'introduction')}

## Methods

${state.methods}

\`\`\`python {#fig-canopy .execute output="figure" produces="figures/generated/fig-canopy.svg"}
${state.code}
\`\`\`

<!-- dm-output:start cell="fig-canopy" run="sha256:6f42f1a" -->
![Leaf area response over twelve weeks](figures/generated/fig-canopy.svg){#fig-canopy-result}
<!-- dm-output:end -->
${preservedAfter(state, 'methods')}

## Results

${state.resultsLead} The drought treatment []{#dm-m01 .dm-anchor data-anchor="dm-r01" data-edge="start" data-affinity="after"}did not substantially alter leaf expansion[]{#dm-m02 .dm-anchor data-anchor="dm-r01" data-edge="end" data-affinity="before"}, while root allocation []{#dm-cm01 .dm-anchor data-anchor="dm-comment-01" data-edge="start" data-affinity="after"}increased modestly[]{#dm-cm02 .dm-anchor data-anchor="dm-comment-01" data-edge="end" data-affinity="before"} [@coutellier2022].${preservedAfter(state, 'results')}

## Conclusion

${state.conclusion}${preservedAfter(state, 'conclusion')}

${REVIEW_START}
:::: {#dm-c01 .dm-change data-anchor="dm-r01" data-kind="replace" data-author="dm-a01" data-status="${state.aliceStatus}" data-created="2026-07-15T09:00:00.000Z"${aliceUpdated}}
~~~{.dm-proposal}
reduced leaf area by 18%
~~~
~~~{.dm-rationale}
State the measured effect directly.
~~~
::::
:::: {#dm-c02 .dm-change data-anchor="dm-r01" data-kind="replace" data-author="dm-a02" data-status="${state.marcusStatus}" data-created="2026-07-15T09:04:00.000Z"${marcusUpdated}}
~~~{.dm-proposal}
lowered leaf expansion during the treatment period
~~~
~~~{.dm-rationale}
Keep the interpretation conservative.
~~~
::::
:::: {#dm-comment-01 .dm-thread data-anchor="dm-comment-01" data-author="dm-a02" data-status="${state.commentDeleted ? 'deleted' : state.commentResolved ? 'resolved' : 'open'}" data-created="2026-07-15T09:08:00.000Z"${commentUpdated}}
~~~{.dm-message data-author="dm-a02" data-at="2026-07-15T09:08:00.000Z" data-index="0"}
Can we quantify this increase in the main text?
~~~
${replyBlocks}
::::
:::: {#dm-a01 .dm-author data-name="Alice Martin" data-created="2026-07-15T09:00:00.000Z"}
::::
:::: {#dm-a02 .dm-author data-name="Marcus Chen" data-created="2026-07-15T09:04:00.000Z"}
::::
${REVIEW_END}
`
}

export function downloadText(filename: string, content: string) {
  downloadBlob(filename, content, 'text/markdown;charset=utf-8')
}

export function downloadBlob(filename: string, content: BlobPart, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
