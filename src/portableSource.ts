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

export interface LosslessPortableSource {
  sourceHash: string
  lineEnding: '\n' | '\r\n' | '\r' | null
  nodes: PortableSourceNode[]
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

function classifyLine(line: string): PortableSourceNodeKind {
  if (!line.trim()) return 'blank'
  if (/^#{1,6}[ \t]+\S/.test(line)) return 'heading'
  if (/^(?:[ \t]*[-+*]|[ \t]*\d+[.)])[ \t]+\S/.test(line) || /^:[ \t]+\S/.test(line)) return 'list'
  if (/^```\{=\w+\}/.test(line) || /^:::[ \t]*\{/.test(line) || /^<\w+[\s>]/.test(line)) return 'raw-block'
  if (/\{\{<\s*[^>]+>\}\}|\.draftmatter-future/.test(line)) return 'unknown'
  return 'text'
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
  }
}

export function serializeLosslessPortableSource(document: LosslessPortableSource) {
  return document.nodes.map((node) => node.raw).join('')
}
