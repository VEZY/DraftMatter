import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { formatCrossReferenceTarget } from './crossReference'
import {
  semanticCrossReferenceLabel,
  semanticManuscriptObjects,
  semanticObjectByLabel,
} from './semanticObjects'

export {
  isExplicitlyUnnumbered,
  retainedOutputPresentation,
  type RetainedOutputPresentation,
} from './retainedOutputPresentation'

export type NumberedObjectKind = 'figure' | 'table' | 'equation'

export interface NumberedManuscriptObject {
  kind: NumberedObjectKind
  nodeId: string
  label?: string
  caption?: string
  number?: number
  unnumbered: boolean
}

export function numberedManuscriptObjects(document: ProseMirrorNode) {
  return semanticManuscriptObjects(document).flatMap<NumberedManuscriptObject>((object) => object.kind === 'section'
    ? []
    : [{
        kind: object.kind,
        nodeId: object.nodeId,
        label: object.label,
        caption: object.caption,
        number: object.number,
        unnumbered: object.unnumbered,
      }])
}

export function numberedObjectByNodeId(document: ProseMirrorNode, nodeId: string) {
  return numberedManuscriptObjects(document).find((object) => object.nodeId === nodeId)
}

export function numberedObjectByLabel(document: ProseMirrorNode, label: string) {
  const object = semanticObjectByLabel(document, label)
  return object?.kind === 'section' ? undefined : object
}

export function numberedCrossReferenceLabel(document: ProseMirrorNode, target: string) {
  return semanticCrossReferenceLabel(document, target) ?? formatCrossReferenceTarget(target)
}
