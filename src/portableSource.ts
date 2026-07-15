import { sourceHash } from './document'

export type PortableSourceNodeKind =
  | 'frontmatter'
  | 'heading'
  | 'list'
  | 'executable-fence'
  | 'raw-block'
  | 'output'
  | 'review-section'
  | 'unknown'
  | 'text'
  | 'blank'

export interface PortableSourceNode {
  id: string
  kind: PortableSourceNodeKind
  start: number
  end: number
  raw: string
}

export type PortableSemanticNodeKind = 'citation' | 'code-cell' | 'output' | 'review-anchor' | 'raw-markdown'

export interface PortableSemanticNode {
  id: string
  kind: PortableSemanticNodeKind
  start: number
  end: number
  raw: string
  attributes: Record<string, string | string[]>
}

export interface LosslessPortableSource {
  sourceHash: string
  lineEnding: '\n' | '\r\n' | '\r' | null
  nodes: PortableSourceNode[]
  semanticNodes: PortableSemanticNode[]
}

function sourceLines(source: string) {
  return source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? []
}

function lineContent(line: string) {
  return line.replace(/(?:\r\n|\n|\r)$/, '')
}

function fenceEnd(lines: string[], start: number, marker: string) {
  const character = marker[0]
  const closing = new RegExp(`^[ \\t]*\\${character}{${marker.length},}[ \\t]*$`)
  for (let index = start + 1; index < lines.length; index += 1) {
    if (closing.test(lineContent(lines[index]))) return index + 1
  }
  return lines.length
}

function markerEnd(lines: string[], start: number, marker: string) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lineContent(lines[index]).includes(marker)) return index + 1
  }
  return lines.length
}

function divEnd(lines: string[], start: number) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^:{3,}[ \t]*$/.test(lineContent(lines[index]))) return index + 1
  }
  return lines.length
}

function classifyLine(line: string): PortableSourceNodeKind {
  if (!line.trim()) return 'blank'
  if (/^#{1,6}[ \t]+\S/.test(line)) return 'heading'
  if (/^(?:[ \t]*[-+*]|[ \t]*\d+[.)])[ \t]+\S/.test(line) || /^:[ \t]+\S/.test(line)) return 'list'
  if (/^```\{=\w+\}/.test(line) || /^:::[ \t]*\{/.test(line) || /^<\w+[\s>]/.test(line)) return 'raw-block'
  if (/\{\{<\s*[^>]+>\}\}|\.draftmatter-future/.test(line)) return 'unknown'
  return 'text'
}

function explicitId(raw: string) {
  return raw.match(/(?:^|[\s{])#([a-zA-Z][a-zA-Z0-9_.:-]*)/)?.[1]
}

function semanticNodes(source: string, nodes: PortableSourceNode[]): PortableSemanticNode[] {
  const semantic: PortableSemanticNode[] = []
  const literalRanges = nodes.filter((node) => node.kind === 'executable-fence' || node.kind === 'raw-block' || node.kind === 'output' || node.kind === 'review-section')
  const isLiteralRange = (start: number, end: number) => literalRanges.some((range) => start >= range.start && end <= range.end)
  let citationOrdinal = 0
  let outputOrdinal = 0
  let anchorOrdinal = 0
  let rawOrdinal = 0

  for (const node of nodes) {
    if (node.kind === 'executable-fence') {
      const opening = lineContent(sourceLines(node.raw)[0] ?? '')
      const language = opening.match(/^[ \t]*(?:`{3,}|~{3,})(python|r|julia)\b/)?.[1] ?? 'unknown'
      const label = explicitId(opening)
      semantic.push({
        id: label ? `code:${label}` : `code:${semantic.filter((item) => item.kind === 'code-cell').length + 1}`,
        kind: 'code-cell',
        start: node.start,
        end: node.end,
        raw: node.raw,
        attributes: { language, ...(label ? { label } : {}) },
      })
    }

    if (node.kind === 'output') {
      outputOrdinal += 1
      const cell = node.raw.match(/<!-- dm-output:start[^>]*\bcell="([^"]+)"/)?.[1]
      semantic.push({
        id: cell ? `output:${cell}` : `output:${outputOrdinal}`,
        kind: 'output',
        start: node.start,
        end: node.end,
        raw: node.raw,
        attributes: cell ? { cell } : {},
      })
    }

    if (node.kind === 'raw-block' || node.kind === 'unknown') {
      rawOrdinal += 1
      const label = explicitId(node.raw)
      semantic.push({
        id: label ? `raw:${label}` : `raw:${rawOrdinal}`,
        kind: 'raw-markdown',
        start: node.start,
        end: node.end,
        raw: node.raw,
        attributes: label ? { label } : {},
      })
    }
  }

  const citationPattern = /\[([^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*)\]/g
  for (const match of source.matchAll(citationPattern)) {
    const start = match.index ?? 0
    if (isLiteralRange(start, start + match[0].length)) continue
    citationOrdinal += 1
    const citekeys = [...match[1].matchAll(/@([a-zA-Z0-9_:.+-]+)/g)].map((key) => key[1])
    semantic.push({
      id: `citation:${citationOrdinal}`,
      kind: 'citation',
      start,
      end: start + match[0].length,
      raw: match[0],
      attributes: { citekeys },
    })
  }

  const anchorPattern = /\[\]\{([^}\r\n]*\.dm-anchor[^}\r\n]*)\}/g
  for (const match of source.matchAll(anchorPattern)) {
    const start = match.index ?? 0
    if (isLiteralRange(start, start + match[0].length)) continue
    anchorOrdinal += 1
    const label = explicitId(match[1])
    const anchor = match[1].match(/\bdata-anchor="([^"]+)"/)?.[1]
    const edge = match[1].match(/\bdata-edge="([^"]+)"/)?.[1]
    const affinity = match[1].match(/\bdata-affinity="([^"]+)"/)?.[1]
    semantic.push({
      id: label ? `anchor:${label}` : `anchor:${anchorOrdinal}`,
      kind: 'review-anchor',
      start,
      end: start + match[0].length,
      raw: match[0],
      attributes: { ...(label ? { label } : {}), ...(anchor ? { anchor } : {}), ...(edge ? { edge } : {}), ...(affinity ? { affinity } : {}) },
    })
  }

  return semantic.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id))
}

export function parseLosslessPortableSource(source: string): LosslessPortableSource {
  const lines = sourceLines(source)
  const nodes: PortableSourceNode[] = []
  let index = 0
  let offset = 0

  const append = (kind: PortableSourceNodeKind, endIndex: number) => {
    const raw = lines.slice(index, endIndex).join('')
    nodes.push({
      id: `dm-raw-${sourceHash(raw).slice(6)}-${offset}`,
      kind,
      start: offset,
      end: offset + raw.length,
      raw,
    })
    offset += raw.length
    index = endIndex
  }

  while (index < lines.length) {
    const line = lineContent(lines[index])

    if (index === 0 && line === '---') {
      const end = lines.slice(1).findIndex((candidate) => lineContent(candidate) === '---')
      append('frontmatter', end < 0 ? lines.length : end + 2)
      continue
    }

    if (/^:{5,}[ \t]+\{\.draftmatter-reviews\b/.test(line)) {
      append('review-section', lines.length)
      continue
    }

    if (line.includes('<!-- dm-output:start')) {
      append('output', markerEnd(lines, index, '<!-- dm-output:end -->'))
      continue
    }

    if (/^:{3,}[ \t]*\{/.test(line)) {
      append('raw-block', divEnd(lines, index))
      continue
    }

    const fence = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const info = fence[2]
      const kind = /^(?:python|r|julia)\b[^\n]*\.execute/.test(info.trim())
        ? 'executable-fence'
        : /^\{=\w+\}/.test(info.trim())
          ? 'raw-block'
          : 'text'
      append(kind, fenceEnd(lines, index, fence[1]))
      continue
    }

    append(classifyLine(line), index + 1)
  }

  return {
    sourceHash: sourceHash(source),
    lineEnding: source.includes('\r\n') ? '\r\n' : source.includes('\n') ? '\n' : source.includes('\r') ? '\r' : null,
    nodes,
    semanticNodes: semanticNodes(source, nodes),
  }
}

export function serializeLosslessPortableSource(document: LosslessPortableSource) {
  return document.nodes.map((node) => node.raw).join('')
}

export function insertPortableSource(document: LosslessPortableSource, offset: number, raw: string) {
  const source = serializeLosslessPortableSource(document)
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) throw new RangeError('Portable source insertion offset is outside the document.')
  return parseLosslessPortableSource(`${source.slice(0, offset)}${raw}${source.slice(offset)}`)
}

export function replacePortableSemanticNode(document: LosslessPortableSource, id: string, raw: string) {
  const node = document.semanticNodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`Portable semantic node ${id} was not found.`)

  const source = serializeLosslessPortableSource(document)
  const updated = parseLosslessPortableSource(`${source.slice(0, node.start)}${raw}${source.slice(node.end)}`)
  const replacement = updated.semanticNodes.find((candidate) => candidate.id === id && candidate.kind === node.kind)
  if (!replacement) throw new Error(`Replacement for ${id} must remain a ${node.kind} node with the same identity.`)
  return updated
}
