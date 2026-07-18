import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { manuscriptSchema } from './manuscriptSchema'
import { isExplicitlyUnnumbered, retainedOutputPresentation } from './retainedOutputPresentation'

export type SemanticObjectKind = 'section' | 'figure' | 'table' | 'equation'

export interface SemanticManuscriptObject {
  kind: SemanticObjectKind
  nodeId: string
  position: number
  label?: string
  suggestedLabel: string
  title?: string
  caption?: string
  alt?: string
  number?: number
  displayNumber?: string
  unnumbered: boolean
  source: 'manual' | 'reproducible'
  legacyMachineLabel: boolean
}

const prefixes: Record<SemanticObjectKind, string> = {
  section: 'sec',
  figure: 'fig',
  table: 'tbl',
  equation: 'eq',
}

const fallbacks: Record<SemanticObjectKind, string> = {
  section: 'section',
  figure: 'figure',
  table: 'table',
  equation: 'equation',
}

function portableSlug(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '')
}

function withoutKindPrefix(kind: SemanticObjectKind, value: string) {
  return value.replace(new RegExp(`^${prefixes[kind]}-`, 'i'), '')
}

export function friendlyObjectLabel(kind: SemanticObjectKind, seed: string, labels: Iterable<string> = []) {
  const used = new Set([...labels].map((label) => label.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))
  const slug = portableSlug(withoutKindPrefix(kind, seed)) || fallbacks[kind]
  const base = `${prefixes[kind]}-${slug}`
  if (!used.has(base.toLowerCase())) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`.toLowerCase())) suffix += 1
  return `${base}-${suffix}`
}

export function isFriendlyObjectLabelForKind(kind: SemanticObjectKind, label: string) {
  return new RegExp(`^${prefixes[kind]}-[A-Za-z0-9][A-Za-z0-9_.:-]*$`).test(label.trim().replace(/^#/, ''))
}

export function isLegacyMachineObjectLabel(label: string) {
  const normalized = label.trim().replace(/^#/, '')
  return /(?:^|-)(?:cell|output)-(?:python|r|julia)-/i.test(normalized)
    || /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(normalized)
    || /(?:^|-)[0-9a-f]{12,}(?:-|$)/i.test(normalized)
}

function codeReference(node: ProseMirrorNode) {
  if (node.type !== manuscriptSchema.nodes.code_cell) return undefined
  const attributes = (node.attrs.attributes ?? {}) as Record<string, unknown>
  return typeof attributes.reference === 'string' ? attributes.reference.trim().replace(/^#/, '') : undefined
}

export function semanticLabelsInUse(document: ProseMirrorNode) {
  const labels = new Set<string>()
  document.descendants((node) => {
    const direct = node.type === manuscriptSchema.nodes.heading
      || node.type === manuscriptSchema.nodes.table
      || node.type === manuscriptSchema.nodes.equation_block
      || node.type === manuscriptSchema.nodes.image
      ? node.attrs.label
      : undefined
    if (direct) labels.add(String(direct))
    const reference = codeReference(node)
    if (reference) labels.add(reference)
    if (node.type === manuscriptSchema.nodes.output_block) {
      const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
      if (presentation.label) labels.add(presentation.label)
      return false
    }
    return true
  })
  return labels
}

export function semanticLabelIsInUse(labels: Iterable<string>, label: string) {
  const normalized = label.trim().replace(/^#/, '').toLowerCase()
  return [...labels].some((candidate) => candidate.toLowerCase() === normalized)
}

interface ObjectDraft extends Omit<SemanticManuscriptObject, 'suggestedLabel' | 'legacyMachineLabel'> {
  seed: string
}

function sourceStem(source: unknown) {
  const path = String(source ?? '').split(/[?#]/, 1)[0]
  const basename = path.split(/[\\/]/).at(-1) ?? ''
  return basename.replace(/\.[^.]+$/, '')
}

export function semanticManuscriptObjects(document: ProseMirrorNode) {
  const drafts: ObjectDraft[] = []
  const counters: Record<Exclude<SemanticObjectKind, 'section'>, number> = { figure: 0, table: 0, equation: 0 }
  const sectionCounters = Array.from({ length: 7 }, () => 0)

  document.descendants((node, position) => {
    if (node.type === manuscriptSchema.nodes.heading) {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1))
      sectionCounters[level] += 1
      for (let index = level + 1; index < sectionCounters.length; index += 1) sectionCounters[index] = 0
      const displayNumber = sectionCounters.slice(1, level + 1).filter((part) => part > 0).join('.')
      const title = node.textContent.trim()
      drafts.push({
        kind: 'section',
        nodeId: String(node.attrs.id),
        position,
        label: node.attrs.label ? String(node.attrs.label) : undefined,
        title: title || undefined,
        displayNumber: displayNumber || undefined,
        unnumbered: isExplicitlyUnnumbered(node.attrs.sourceAttributes),
        source: 'manual',
        seed: title,
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.figure) {
      const image = node.firstChild
      const caption = node.childCount > 1 ? node.child(1).textContent.trim() : ''
      const alt = String(image?.attrs.alt ?? '').trim()
      const unnumbered = isExplicitlyUnnumbered(image?.attrs.sourceAttributes)
      const number = unnumbered ? undefined : ++counters.figure
      drafts.push({
        kind: 'figure',
        nodeId: String(image?.attrs.id ?? node.attrs.id),
        position,
        label: image?.attrs.label ? String(image.attrs.label) : undefined,
        caption: caption || undefined,
        alt: alt || undefined,
        number,
        displayNumber: number ? String(number) : undefined,
        unnumbered,
        source: 'manual',
        seed: caption || alt || sourceStem(image?.attrs.src),
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.table) {
      const caption = String(node.attrs.captionMarkdown ?? '').trim()
      const unnumbered = isExplicitlyUnnumbered(node.attrs.sourceAttributes)
      const number = unnumbered ? undefined : ++counters.table
      drafts.push({
        kind: 'table',
        nodeId: String(node.attrs.id),
        position,
        label: node.attrs.label ? String(node.attrs.label) : undefined,
        caption: caption || undefined,
        number,
        displayNumber: number ? String(number) : undefined,
        unnumbered,
        source: 'manual',
        seed: caption,
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.equation_block) {
      const caption = String(node.attrs.captionMarkdown ?? '').trim()
      const unnumbered = isExplicitlyUnnumbered(node.attrs.sourceAttributes)
      const number = unnumbered ? undefined : ++counters.equation
      drafts.push({
        kind: 'equation',
        nodeId: String(node.attrs.id),
        position,
        label: node.attrs.label ? String(node.attrs.label) : undefined,
        caption: caption || undefined,
        number,
        displayNumber: number ? String(number) : undefined,
        unnumbered,
        source: 'manual',
        seed: caption || String(node.attrs.tex ?? ''),
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.output_block) {
      const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
      if (presentation.kind === 'image' || presentation.kind === 'table') {
        const kind = presentation.kind === 'image' ? 'figure' : 'table'
        const number = presentation.unnumbered ? undefined : ++counters[kind]
        drafts.push({
          kind,
          nodeId: String(node.attrs.id),
          position,
          label: presentation.label,
          caption: presentation.caption,
          alt: presentation.alt,
          number,
          displayNumber: number ? String(number) : undefined,
          unnumbered: presentation.unnumbered,
          source: 'reproducible',
          seed: presentation.caption || presentation.alt || `${kind} result`,
        })
      }
      return false
    }
    return true
  })

  const used = semanticLabelsInUse(document)
  return drafts.map<SemanticManuscriptObject>(({ seed, ...object }) => {
    const suggestedLabel = object.label ?? friendlyObjectLabel(object.kind, seed, used)
    used.add(suggestedLabel)
    return {
      ...object,
      suggestedLabel,
      legacyMachineLabel: Boolean(object.label && isLegacyMachineObjectLabel(object.label)),
    }
  })
}

export function semanticObjectByLabel(document: ProseMirrorNode, label: string) {
  const normalized = label.trim().replace(/^@/, '')
  return semanticManuscriptObjects(document).find((object) => object.label === normalized)
}

export function semanticObjectKindName(kind: SemanticObjectKind) {
  return kind === 'section' ? 'Section' : kind === 'figure' ? 'Figure' : kind === 'table' ? 'Table' : 'Equation'
}

export function semanticCrossReferenceLabel(document: ProseMirrorNode, target: string) {
  const object = semanticObjectByLabel(document, target)
  if (!object?.displayNumber || object.unnumbered) return undefined
  return `${semanticObjectKindName(object.kind)} ${object.displayNumber}`
}
