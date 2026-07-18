import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { formatCrossReferenceTarget } from './crossReference'
import { manuscriptSchema } from './manuscriptSchema'
import { embeddedExecutionImageFromHtml } from './outputRenderer'
import { parseTableCaptionLine } from './tableSyntax'

export type NumberedObjectKind = 'figure' | 'table' | 'equation'

export interface NumberedManuscriptObject {
  kind: NumberedObjectKind
  nodeId: string
  label?: string
  caption?: string
  number?: number
  unnumbered: boolean
}

export interface RetainedOutputPresentation {
  kind: 'image' | 'table' | 'markdown'
  label?: string
  caption?: string
  sourceAttributes?: string
  unnumbered: boolean
}

export function isExplicitlyUnnumbered(sourceAttributes: unknown) {
  return /(?:^|\s)\.unnumbered(?:\s|$)/.test(String(sourceAttributes ?? ''))
}

function retainedOutputBody(markdown: string) {
  return markdown
    .replace(/^\s*<!-- dm-output:start[^>]*-->\s*/m, '')
    .replace(/\s*<!-- dm-output:end -->\s*$/m, '')
    .replace(/^\s*<!-- dm-published-value\b[^>]*-->\s*$/gm, '')
    .trim()
}

function imagePresentation(body: string): RetainedOutputPresentation | undefined {
  const image = body.match(/!\[[^\]]*\]\((?:<[^>\r\n]+>|[^)\r\n]+)\)\s*(?:\{([^}\r\n]+)\})?/)
  if (!image) return undefined
  const sourceAttributes = image[1]?.trim()
  const after = body.slice((image.index ?? 0) + image[0].length).trim()
  const conventional = after.match(/^:\s*(.+)$/m)?.[1]?.trim()
  const legacy = conventional ? undefined : after.match(/^\*([^*\r\n]+)\*$/m)?.[1]?.trim()
  return {
    kind: 'image',
    label: sourceAttributes?.match(/(?:^|\s)#([a-zA-Z][\w.:-]*)/)?.[1],
    caption: conventional || legacy || undefined,
    sourceAttributes,
    unnumbered: isExplicitlyUnnumbered(sourceAttributes),
  }
}

function tablePresentation(body: string): RetainedOutputPresentation | undefined {
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const separator = lines.findIndex((line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  if (separator < 1) return undefined
  let index = separator + 1
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) index += 1
  while (index < lines.length && !lines[index].trim()) index += 1
  const caption = parseTableCaptionLine(lines[index] ?? '')
  return {
    kind: 'table',
    label: caption?.label ?? undefined,
    caption: caption?.captionMarkdown || undefined,
    sourceAttributes: caption?.sourceAttributes ?? undefined,
    unnumbered: isExplicitlyUnnumbered(caption?.sourceAttributes),
  }
}

export function retainedOutputPresentation(markdown: string, declaredKind?: unknown): RetainedOutputPresentation {
  const body = retainedOutputBody(markdown)
  const image = imagePresentation(body)
  if (image) return image
  if (embeddedExecutionImageFromHtml(body)) return { kind: 'image', unnumbered: false }
  const table = tablePresentation(body)
  if (table) return table
  return { kind: declaredKind === 'table' ? 'table' : declaredKind === 'image' ? 'image' : 'markdown', unnumbered: false }
}

export function numberedManuscriptObjects(document: ProseMirrorNode) {
  const objects: NumberedManuscriptObject[] = []
  const counters: Record<NumberedObjectKind, number> = { figure: 0, table: 0, equation: 0 }
  const append = (object: Omit<NumberedManuscriptObject, 'number'>) => {
    const number = object.unnumbered ? undefined : ++counters[object.kind]
    objects.push({ ...object, number })
  }

  document.descendants((node) => {
    if (node.type === manuscriptSchema.nodes.figure) {
      const image = node.firstChild
      const caption = node.childCount > 1 ? node.child(1).textContent.trim() : ''
      append({
        kind: 'figure',
        nodeId: String(image?.attrs.id ?? node.attrs.id),
        label: image?.attrs.label ? String(image.attrs.label) : undefined,
        caption: caption || undefined,
        unnumbered: isExplicitlyUnnumbered(image?.attrs.sourceAttributes),
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.table) {
      append({
        kind: 'table',
        nodeId: String(node.attrs.id),
        label: node.attrs.label ? String(node.attrs.label) : undefined,
        caption: String(node.attrs.captionMarkdown ?? '').trim() || undefined,
        unnumbered: isExplicitlyUnnumbered(node.attrs.sourceAttributes),
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.equation_block) {
      append({
        kind: 'equation',
        nodeId: String(node.attrs.id),
        label: node.attrs.label ? String(node.attrs.label) : undefined,
        caption: String(node.attrs.captionMarkdown ?? '').trim() || undefined,
        unnumbered: isExplicitlyUnnumbered(node.attrs.sourceAttributes),
      })
      return false
    }
    if (node.type === manuscriptSchema.nodes.output_block) {
      const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
      if (presentation.kind === 'image' || presentation.kind === 'table') {
        append({
          kind: presentation.kind === 'image' ? 'figure' : 'table',
          nodeId: String(node.attrs.id),
          label: presentation.label,
          caption: presentation.caption,
          unnumbered: presentation.unnumbered,
        })
      }
      return false
    }
    return true
  })
  return objects
}

export function numberedObjectByNodeId(document: ProseMirrorNode, nodeId: string) {
  return numberedManuscriptObjects(document).find((object) => object.nodeId === nodeId)
}

export function numberedObjectByLabel(document: ProseMirrorNode, label: string) {
  return numberedManuscriptObjects(document).find((object) => object.label === label)
}

export function numberedCrossReferenceLabel(document: ProseMirrorNode, target: string) {
  const object = numberedObjectByLabel(document, target.trim().replace(/^@/, ''))
  if (!object?.number) return formatCrossReferenceTarget(target)
  const kind = object.kind === 'figure' ? 'Figure' : object.kind === 'table' ? 'Table' : 'Equation'
  return `${kind} ${object.number}`
}
