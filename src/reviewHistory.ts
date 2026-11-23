import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import { Step, StepResult } from 'prosemirror-transform'
import { closeHistory } from 'prosemirror-history'

// Review records live in the portable Markdown metadata, outside the editable
// ProseMirror document. Keep their inverse alongside the ordinary prose steps.
export class ReviewSourceStep extends Step {
  constructor(readonly before: string, readonly after: string) { super() }
  apply(doc: ProseMirrorNode) { return StepResult.ok(doc) }
  invert() { return new ReviewSourceStep(this.after, this.before) }
  map() { return this }
  toJSON() { return { stepType: 'draftmatterReviewSource', before: this.before, after: this.after } }
}

export function reviewSourceTransaction(state: EditorState, next: ProseMirrorNode, before: string, after: string) {
  const tr = closeHistory(state.tr)
  const start = state.doc.content.findDiffStart(next.content)
  const end = state.doc.content.findDiffEnd(next.content)
  if (start != null && end) {
    const overlap = start - Math.min(end.a, end.b)
    const fromEnd = end.a + Math.max(0, overlap)
    const toEnd = end.b + Math.max(0, overlap)
    tr.replace(start, fromEnd, next.slice(start, toEnd))
  }
  return tr.step(new ReviewSourceStep(before, after))
}
