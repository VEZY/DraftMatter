import type { Root, RootContent } from 'mdast'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { AgentExternalReference, AgentSelector } from './agentProtocol'
import { sourceHash } from './document'
import { manuscriptSchema } from './manuscriptSchema'

export class AgentSelectorError extends Error {
  constructor(readonly code: 'not-found' | 'ambiguous-selector' | 'selector-unsupported', message: string) {
    super(message)
    this.name = 'AgentSelectorError'
  }
}

export function opaqueAgentReference(
  kind: 'project' | 'node' | 'cell' | 'figure' | 'table' | 'equation' | 'review' | 'citation-candidate' | 'artifact' | 'operation',
  identity: string,
): AgentExternalReference {
  const opaque = sourceHash(`${kind}\u0000${identity}`).slice('fnv1a:'.length)
  return `${kind}:${opaque}` as AgentExternalReference
}

interface SourceNode {
  node: RootContent
  start: number
  end: number
}

function sourceNodes(source: string) {
  const tree = unified().use(remarkParse).parse(source) as Root
  const nodes: SourceNode[] = []
  const visit = (node: Root | RootContent) => {
    if (node.type !== 'root' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      nodes.push({ node, start: node.position.start.offset, end: node.position.end.offset })
    }
    if ('children' in node) for (const child of node.children) visit(child as RootContent)
  }
  visit(tree)
  return nodes
}

function markdownHeadingText(source: string, entry: SourceNode) {
  return source.slice(entry.start, entry.end)
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+\{[^}]*\}\s*$/, '')
    .trim()
}

function choose<T>(values: T[], occurrence: number | undefined, description: string) {
  if (!values.length) throw new AgentSelectorError('not-found', `${description} was not found.`)
  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1) throw new AgentSelectorError('selector-unsupported', 'Selector occurrence values are one-based positive integers.')
    const value = values[occurrence - 1]
    if (!value) throw new AgentSelectorError('not-found', `${description} occurrence ${occurrence} was not found.`)
    return value
  }
  if (values.length > 1) throw new AgentSelectorError('ambiguous-selector', `${description} matched ${values.length} locations. Add surrounding context or an occurrence.`)
  return values[0]
}

export interface AgentSourceRange {
  start: number
  end: number
  source: string
}

export function resolveSourceSelector(source: string, selector: AgentSelector): AgentSourceRange {
  if (selector.kind === 'document-boundary') {
    const offset = selector.edge === 'start' ? 0 : source.length
    return { start: offset, end: offset, source: '' }
  }
  if (selector.kind === 'reference') {
    throw new AgentSelectorError('selector-unsupported', 'Portable source ranges cannot be selected from an opaque node reference in this operation.')
  }
  if (selector.kind === 'quote') {
    const matches: AgentSourceRange[] = []
    let offset = 0
    while (selector.quote && offset <= source.length) {
      const start = source.indexOf(selector.quote, offset)
      if (start < 0) break
      const end = start + selector.quote.length
      const prefixMatches = selector.prefix === undefined || source.slice(Math.max(0, start - selector.prefix.length), start) === selector.prefix
      const suffixMatches = selector.suffix === undefined || source.slice(end, end + selector.suffix.length) === selector.suffix
      if (prefixMatches && suffixMatches) matches.push({ start, end, source: source.slice(start, end) })
      offset = start + Math.max(1, selector.quote.length)
    }
    return choose(matches, selector.occurrence, `Quote “${selector.quote.slice(0, 80)}”`)
  }

  const nodes = sourceNodes(source)
  if (selector.kind === 'section-label') {
    const matches = nodes.filter((entry) => entry.node.type === 'heading'
      && new RegExp(`(?:^|[\\s{])#${selector.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s}])`).test(source.slice(entry.start, entry.end)))
    const match = choose(matches, undefined, `Section label #${selector.label}`)
    return { start: match.start, end: match.end, source: source.slice(match.start, match.end) }
  }
  if (selector.kind === 'heading') {
    const matches = nodes.filter((entry) => entry.node.type === 'heading' && markdownHeadingText(source, entry) === selector.text)
    const match = choose(matches, selector.occurrence, `Heading “${selector.text}”`)
    return { start: match.start, end: match.end, source: source.slice(match.start, match.end) }
  }
  const paragraphs = nodes.filter((entry) => entry.node.type === 'paragraph')
  let candidates = paragraphs
  if (selector.section) {
    const section = resolveSourceSelector(source, selector.section)
    const heading = nodes.find((entry) => entry.start === section.start && entry.node.type === 'heading')
    if (!heading || heading.node.type !== 'heading') throw new AgentSelectorError('selector-unsupported', 'A paragraph section selector must resolve to a heading.')
    const headingDepth = heading.node.type === 'heading' ? heading.node.depth : 6
    const next = nodes.find((entry) => entry.node.type === 'heading'
      && entry.start > heading.end
      && entry.node.depth <= headingDepth)
    candidates = paragraphs.filter((entry) => entry.start > heading.end && entry.end <= (next?.start ?? source.length))
  }
  const match = choose(candidates, selector.ordinal, `Paragraph ${selector.ordinal}`)
  return { start: match.start, end: match.end, source: source.slice(match.start, match.end) }
}

export interface AgentDocumentTarget {
  node: ProseMirrorNode
  position: number
  reference: AgentExternalReference
}

export function documentTargets(document: ProseMirrorNode) {
  const targets: AgentDocumentTarget[] = []
  document.descendants((node, position) => {
    const id = node.attrs?.id
    if (id) targets.push({
      node,
      position,
      reference: opaqueAgentReference(node.type === manuscriptSchema.nodes.code_cell ? 'cell' : 'node', String(id)),
    })
    return true
  })
  return targets
}

export function resolveDocumentSelector(document: ProseMirrorNode, selector: AgentSelector): AgentDocumentTarget {
  const targets = documentTargets(document)
  if (selector.kind === 'reference') {
    return choose(targets.filter((target) => target.reference === selector.reference), undefined, `Reference ${selector.reference}`)
  }
  if (selector.kind === 'section-label') {
    return choose(targets.filter((target) => target.node.type === manuscriptSchema.nodes.heading && target.node.attrs.label === selector.label), undefined, `Section label #${selector.label}`)
  }
  if (selector.kind === 'heading') {
    return choose(
      targets.filter((target) => target.node.type === manuscriptSchema.nodes.heading && target.node.textContent === selector.text),
      selector.occurrence,
      `Heading “${selector.text}”`,
    )
  }
  if (selector.kind === 'paragraph') {
    const paragraphs = targets.filter((target) => target.node.type === manuscriptSchema.nodes.paragraph)
    if (!selector.section) return choose(paragraphs, selector.ordinal, `Paragraph ${selector.ordinal}`)
    const heading = resolveDocumentSelector(document, selector.section)
    if (heading.node.type !== manuscriptSchema.nodes.heading) throw new AgentSelectorError('selector-unsupported', 'A paragraph section selector must resolve to a heading.')
    const sectionEnd = targets
      .filter((target) => target.node.type === manuscriptSchema.nodes.heading
        && target.position > heading.position
        && Number(target.node.attrs.level) <= Number(heading.node.attrs.level))
      .sort((left, right) => left.position - right.position)[0]?.position ?? document.content.size
    const sectionParagraphs = paragraphs.filter((target) => target.position > heading.position && target.position < sectionEnd)
    return choose(sectionParagraphs, selector.ordinal, `Paragraph ${selector.ordinal} in ${heading.node.textContent}`)
  }
  if (selector.kind === 'quote') {
    const matches: AgentDocumentTarget[] = []
    document.descendants((node, position) => {
      if (!node.isText || !node.text) return true
      let offset = 0
      while (selector.quote && offset <= node.text.length) {
        const index = node.text.indexOf(selector.quote, offset)
        if (index < 0) break
        const end = index + selector.quote.length
        const prefixMatches = selector.prefix === undefined || node.text.slice(Math.max(0, index - selector.prefix.length), index) === selector.prefix
        const suffixMatches = selector.suffix === undefined || node.text.slice(end, end + selector.suffix.length) === selector.suffix
        if (prefixMatches && suffixMatches) matches.push({
          node,
          position: position + index,
          reference: opaqueAgentReference('node', `${position}:${index}:${selector.quote}`),
        })
        offset = index + Math.max(1, selector.quote.length)
      }
      return true
    })
    return choose(matches, selector.occurrence, `Quote “${selector.quote.slice(0, 80)}”`)
  }
  throw new AgentSelectorError('selector-unsupported', 'Document boundary selectors identify insertion positions, not manuscript nodes.')
}

export function blockInsertionPosition(document: ProseMirrorNode, selector: AgentSelector, placement: 'before' | 'after' | 'start' | 'end') {
  if (selector.kind === 'document-boundary') return selector.edge === 'start' ? 0 : document.content.size
  const target = resolveDocumentSelector(document, selector)
  if (placement === 'before') return target.position
  if (placement === 'after') return target.position + target.node.nodeSize
  if (target.node.type === manuscriptSchema.nodes.heading) {
    if (placement === 'start') return target.position + target.node.nodeSize
    const next = documentTargets(document)
      .filter((candidate) => candidate.node.type === manuscriptSchema.nodes.heading
        && candidate.position > target.position
        && Number(candidate.node.attrs.level) <= Number(target.node.attrs.level))
      .sort((left, right) => left.position - right.position)[0]
    return next?.position ?? document.content.size
  }
  throw new AgentSelectorError('selector-unsupported', `Placement “${placement}” requires a section heading or document boundary.`)
}
