import { describe, expect, it } from 'vitest'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'
import { SAMPLE_INTRODUCTION_CONTINUATION, seedSampleIntroduction, upgradeSampleIntroduction } from './sampleWorkspace'

describe('sample workspace upgrades', () => {
  it('adds the editable introduction continuation once to an older sample source', () => {
    const legacy = reviewedProjection(initialDraft)
    const upgraded = upgradeSampleIntroduction(legacy)

    expect(upgraded).toContain(`${initialDraft.introduction} [@vezy2024]\n\n${SAMPLE_INTRODUCTION_CONTINUATION}\n\n## Methods`)
    expect(upgradeSampleIntroduction(upgraded)).toBe(upgraded)
  })

  it('does not alter an arbitrary manuscript', () => {
    const source = '# Field notes\n\n## Introduction\n\nAn unrelated introduction.\n\n## Methods\n\nObserve.\n'
    expect(upgradeSampleIntroduction(source)).toBe(source)
  })

  it('seeds only the built-in sample draft', () => {
    expect(seedSampleIntroduction(initialDraft).preservedSections).toEqual([{ after: 'introduction', markdown: SAMPLE_INTRODUCTION_CONTINUATION }])
    const imported = { ...initialDraft, title: 'Imported study' }
    expect(seedSampleIntroduction(imported)).toBe(imported)
  })
})
