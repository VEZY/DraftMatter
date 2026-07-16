import { initialDraft } from './sampleDraft'
import type { DraftState } from './types'

export const SAMPLE_INTRODUCTION_CONTINUATION = 'Reproducible writing environments can shorten the path between an observation, its supporting analysis, and the claim that enters the literature. This manuscript keeps those elements close without exposing the mechanics during ordinary reading.'

export function seedSampleIntroduction(draft: DraftState) {
  const isSample = draft.title === initialDraft.title && draft.introduction === initialDraft.introduction
  const present = draft.preservedSections?.some((section) => section.after === 'introduction' && section.markdown === SAMPLE_INTRODUCTION_CONTINUATION)
  if (!isSample || present) return draft
  return {
    ...draft,
    preservedSections: [...(draft.preservedSections ?? []), { after: 'introduction' as const, markdown: SAMPLE_INTRODUCTION_CONTINUATION }],
  }
}

export function upgradeSampleIntroduction(source: string) {
  if (source.includes(SAMPLE_INTRODUCTION_CONTINUATION)) return source
  if (!source.includes(`title: "${initialDraft.title}"`)) return source

  const introductionHeading = source.indexOf('## Introduction')
  const introduction = source.indexOf(initialDraft.introduction, introductionHeading)
  const paragraphEnd = source.indexOf('\n\n', introduction)
  if (introductionHeading < 0 || introduction < 0 || paragraphEnd < 0) return source

  return `${source.slice(0, paragraphEnd)}\n\n${SAMPLE_INTRODUCTION_CONTINUATION}${source.slice(paragraphEnd)}`
}
