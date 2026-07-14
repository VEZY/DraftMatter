import { describe, expect, it } from 'vitest'
import { createDraftHistory, reduceDraftHistory } from './draftHistory'
import { initialDraft } from './sampleDraft'

describe('draft history', () => {
  it('undoes and redoes a structured edit', () => {
    const initial = createDraftHistory(initialDraft)
    const edited = reduceDraftHistory(initial, { type: 'update', patch: { title: 'A revised title' } })
    const undone = reduceDraftHistory(edited, { type: 'undo' })
    const redone = reduceDraftHistory(undone, { type: 'redo' })

    expect(edited.present.title).toBe('A revised title')
    expect(undone.present.title).toBe(initialDraft.title)
    expect(redone.present.title).toBe('A revised title')
  })

  it('invalidates redo after a divergent edit', () => {
    const edited = reduceDraftHistory(createDraftHistory(initialDraft), { type: 'update', patch: { title: 'First path' } })
    const undone = reduceDraftHistory(edited, { type: 'undo' })
    const diverged = reduceDraftHistory(undone, { type: 'update', patch: { title: 'Second path' } })

    expect(diverged.future).toEqual([])
    expect(reduceDraftHistory(diverged, { type: 'redo' })).toBe(diverged)
  })

  it('bounds retained edits and clears history when opening another document', () => {
    let history = createDraftHistory(initialDraft)
    history = reduceDraftHistory(history, { type: 'update', patch: { title: 'One' } }, 2)
    history = reduceDraftHistory(history, { type: 'update', patch: { title: 'Two' } }, 2)
    history = reduceDraftHistory(history, { type: 'update', patch: { title: 'Three' } }, 2)
    expect(history.past).toHaveLength(2)

    const opened = { ...initialDraft, title: 'Another manuscript' }
    expect(reduceDraftHistory(history, { type: 'reset', draft: opened })).toEqual(createDraftHistory(opened))
  })
})
