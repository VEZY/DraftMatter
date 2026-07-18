import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { manuscriptSchema } from './manuscriptSchema'
import { retainedOutputPresentation } from './retainedOutputPresentation'
import {
  semanticManuscriptObjects,
  type SemanticManuscriptObject,
  type SemanticObjectKind,
} from './semanticObjects'
import type { DocumentDiagnostic } from './types'

export type SemanticReferenceStatus = 'valid' | 'missing' | 'duplicate' | 'wrong-kind'

export interface SemanticReferenceResolution {
  target: string
  status: SemanticReferenceStatus
  expectedKind?: SemanticObjectKind
  objects: SemanticManuscriptObject[]
}

export interface SemanticReferenceOccurrence extends SemanticReferenceResolution {
  nodeId: string
  position: number
}

const prefixes: Record<string, SemanticObjectKind> = {
  fig: 'figure',
  tbl: 'table',
  eq: 'equation',
  sec: 'section',
}

function diagnosticToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

export function semanticKindFromLabel(label: string) {
  return prefixes[label.trim().replace(/^@/, '').split('-', 1)[0]]
}

export function resolveSemanticReference(
  document: ProseMirrorNode,
  target: string,
  objects = semanticManuscriptObjects(document),
): SemanticReferenceResolution {
  const normalized = target.trim().replace(/^@/, '')
  const expectedKind = semanticKindFromLabel(normalized)
  const matches = objects.filter((object) => object.label === normalized)
  const status: SemanticReferenceStatus = matches.length === 0
    ? 'missing'
    : matches.length > 1
      ? 'duplicate'
      : expectedKind && matches[0].kind !== expectedKind
        ? 'wrong-kind'
        : 'valid'
  return { target: normalized, status, expectedKind, objects: matches }
}

export function semanticReferenceOccurrences(document: ProseMirrorNode) {
  const objects = semanticManuscriptObjects(document)
  const references: SemanticReferenceOccurrence[] = []
  document.descendants((node, position) => {
    if (node.type === manuscriptSchema.nodes.cross_reference) {
      references.push({
        nodeId: String(node.attrs.id),
        position,
        ...resolveSemanticReference(document, String(node.attrs.target), objects),
      })
    }
    return true
  })
  return references
}

export function referenceIntegrityDiagnostics(document: ProseMirrorNode) {
  const diagnostics: DocumentDiagnostic[] = []
  const objects = semanticManuscriptObjects(document)
  const labels = new Map<string, SemanticManuscriptObject[]>()
  for (const object of objects) {
    if (!object.label) continue
    labels.set(object.label, [...(labels.get(object.label) ?? []), object])
  }

  for (const [label, matches] of labels) {
    if (matches.length > 1) diagnostics.push({
      code: `reference-target-duplicate-${diagnosticToken(label)}`,
      level: 'error',
      message: `Cross-reference target @${label} belongs to ${matches.length} manuscript objects. Give each object a unique portable label.`,
    })
    const expectedKind = semanticKindFromLabel(label)
    const wrongKinds = expectedKind ? matches.filter((object) => object.kind !== expectedKind) : []
    if (wrongKinds.length) diagnostics.push({
      code: `reference-target-wrong-kind-${diagnosticToken(label)}`,
      level: 'error',
      message: `Portable label @${label} identifies ${wrongKinds.map((object) => object.kind).join(' and ')} content but its prefix declares a ${expectedKind}. Rename the object before citing it.`,
    })
  }

  const occurrences = semanticReferenceOccurrences(document)
  const occurrenceCounts = new Map<string, number>()
  for (const occurrence of occurrences) occurrenceCounts.set(occurrence.target, (occurrenceCounts.get(occurrence.target) ?? 0) + 1)
  for (const [target, count] of occurrenceCounts) {
    const resolution = resolveSemanticReference(document, target, objects)
    if (resolution.status === 'missing') diagnostics.push({
      code: `cross-reference-missing-${diagnosticToken(target)}`,
      level: 'error',
      message: `${count} cross-reference${count === 1 ? '' : 's'} point${count === 1 ? 's' : ''} to missing target @${target}. Retarget or remove ${count === 1 ? 'it' : 'them'}.`,
    })
    else if (resolution.status === 'duplicate') diagnostics.push({
      code: `cross-reference-ambiguous-${diagnosticToken(target)}`,
      level: 'error',
      message: `${count} cross-reference${count === 1 ? '' : 's'} to @${target} ${count === 1 ? 'is' : 'are'} ambiguous because that label belongs to multiple objects.`,
    })
    else if (resolution.status === 'wrong-kind') diagnostics.push({
      code: `cross-reference-wrong-kind-${diagnosticToken(target)}`,
      level: 'error',
      message: `${count} cross-reference${count === 1 ? '' : 's'} use${count === 1 ? 's' : ''} @${target} as a ${resolution.expectedKind}, but it resolves to a ${resolution.objects[0].kind}.`,
    })
  }

  const codeCells = new Map<string, { reference?: string }>()
  const outputTargets = new Map<string, Set<string>>()
  const outputCells: Array<{ cellId: string; label?: string; kind: string }> = []
  document.descendants((node) => {
    if (node.type === manuscriptSchema.nodes.code_cell) {
      const attributes = (node.attrs.attributes ?? {}) as Record<string, unknown>
      const reference = typeof attributes.reference === 'string' ? attributes.reference.trim().replace(/^#/, '') : undefined
      codeCells.set(String(node.attrs.id), { reference })
      return false
    }
    if (node.type === manuscriptSchema.nodes.output_block) {
      const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
      const cellId = String(node.attrs.cellId)
      outputCells.push({ cellId, label: presentation.label, kind: presentation.kind })
      if (presentation.label) outputTargets.set(cellId, new Set([...(outputTargets.get(cellId) ?? []), presentation.label]))
      return false
    }
    return true
  })

  const reproducibleReferences = new Map<string, string[]>()
  for (const [cellId, cell] of codeCells) {
    if (!cell.reference) continue
    reproducibleReferences.set(cell.reference, [...(reproducibleReferences.get(cell.reference) ?? []), cellId])
    if (!outputTargets.get(cellId)?.has(cell.reference)) diagnostics.push({
      code: `reference-target-orphaned-${diagnosticToken(cell.reference)}-${diagnosticToken(cellId)}`,
      level: 'warning',
      message: `Reproducible target @${cell.reference} has no matching retained output from its source cell. Run the cell or repair its object details.`,
    })
  }
  for (const [label, cellIds] of reproducibleReferences) {
    if (cellIds.length > 1) diagnostics.push({
      code: `reference-target-reproducible-duplicate-${diagnosticToken(label)}`,
      level: 'error',
      message: `Reproducible target @${label} is claimed by ${cellIds.length} source cells. Give each generated object a unique portable label.`,
    })
  }
  for (const output of outputCells) {
    if (!codeCells.has(output.cellId)) diagnostics.push({
      code: `reference-output-orphaned-${diagnosticToken(output.label ?? output.cellId)}`,
      level: 'warning',
      message: `${output.label ? `Reproducible target @${output.label}` : `A retained ${output.kind} output`} has no matching source cell, so its computation provenance is orphaned.`,
    })
  }

  return diagnostics
}
