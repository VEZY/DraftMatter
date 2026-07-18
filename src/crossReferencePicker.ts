import type { SemanticManuscriptObject, SemanticObjectKind } from './semanticObjects'
import { semanticObjectKindName } from './semanticObjects'

export interface CrossReferenceChoice {
  key: string
  nodeId: string
  target: string
  kind: SemanticObjectKind
  group: string
  text: string
  searchText: string
}

const groupNames: Record<SemanticObjectKind, string> = {
  figure: 'Figures',
  table: 'Tables',
  equation: 'Equations',
  section: 'Sections',
}

export const crossReferenceKindOrder: SemanticObjectKind[] = ['figure', 'table', 'equation', 'section']

function previewText(value: string | undefined) {
  return value
    ?.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function crossReferenceChoice(object: SemanticManuscriptObject): CrossReferenceChoice {
  const kindName = semanticObjectKindName(object.kind)
  const identity = object.displayNumber && !object.unnumbered ? `${kindName} ${object.displayNumber}` : kindName
  const description = previewText(object.title ?? object.caption ?? object.alt)
    || (object.kind === 'equation' ? 'Display equation' : `Untitled ${object.kind}`)
  const text = `${identity} — ${description}${object.source === 'reproducible' ? ' · Reproducible' : ''}`
  const target = object.label ?? object.suggestedLabel
  return {
    key: `${object.nodeId}:${target}`,
    nodeId: object.nodeId,
    target,
    kind: object.kind,
    group: groupNames[object.kind],
    text,
    searchText: `${text} ${target}`.toLowerCase(),
  }
}

export function crossReferenceChoices(objects: SemanticManuscriptObject[], query = '') {
  const normalizedQuery = query.trim().toLowerCase()
  const choices = objects.map(crossReferenceChoice)
  const filtered = normalizedQuery
    ? choices.filter((choice) => normalizedQuery.split(/\s+/).every((part) => choice.searchText.includes(part)))
    : choices
  return crossReferenceKindOrder.flatMap((kind) => filtered.filter((choice) => choice.kind === kind))
}

export function groupedCrossReferenceChoices(objects: SemanticManuscriptObject[], query = '') {
  const choices = crossReferenceChoices(objects, query)
  return crossReferenceKindOrder.flatMap((kind) => {
    const items = choices.filter((choice) => choice.kind === kind)
    return items.length ? [{ kind, label: groupNames[kind], items }] : []
  })
}
