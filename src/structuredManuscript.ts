import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model'
import { parseCitationCluster, serializeCitationCluster } from './citation'
import { sourceHash } from './document'
import { extractExecutableCells } from './executionCells'
import { manuscriptSchema } from './manuscriptSchema'
import { parseReviewMarkup } from './reviewMarkup'
import type { DocumentDiagnostic } from './types'

interface SourceLine {
  raw: string
  content: string
}

export interface StructuredManuscriptMetadata {
  frontmatter?: string
  reviewSection?: string
  lineEnding: '\n' | '\r\n' | '\r'
  originalSource: string
  originalDocumentJson: unknown
}

export interface StructuredManuscript {
  document: ProseMirrorNode
  metadata: StructuredManuscriptMetadata
  diagnostics: DocumentDiagnostic[]
}

function sourceLines(source: string): SourceLine[] {
  return (source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [])
    .filter((raw) => raw.length > 0)
    .map((raw) => ({ raw, content: raw.replace(/(?:\r\n|\n|\r)$/, '') }))
}

function sourceLineEnding(source: string): StructuredManuscriptMetadata['lineEnding'] {
  if (source.includes('\r\n')) return '\r\n'
  if (source.includes('\r')) return '\r'
  return '\n'
}

function nodeId(kind: string, raw: string, ordinal: number) {
  return `dm-${kind}-${sourceHash(raw).slice('fnv1a:'.length)}-${ordinal}`
}

function text(value: string, marks: readonly Mark[] = []) {
  return value ? manuscriptSchema.text(value, marks) : null
}

function marked(nodes: ProseMirrorNode[], mark: Mark) {
  return nodes.map((node) => node.mark([...node.marks, mark]))
}

interface InlineCandidate {
  index: number
  raw: string
  kind: 'anchor' | 'citation' | 'link' | 'strong' | 'emphasis' | 'code' | 'math' | 'cross-reference' | 'footnote'
  match: RegExpMatchArray
}

const inlinePatterns: Array<[InlineCandidate['kind'], RegExp]> = [
  ['anchor', /\[\]\{[^}\r\n]*\.dm-anchor[^}\r\n]*\}/],
  ['citation', /\[[^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*\]/],
  ['link', /\[([^\]\r\n]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/],
  ['strong', /\*\*([^*\r\n]+)\*\*|__([^_\r\n]+)__/],
  ['emphasis', /\*([^*\r\n]+)\*|_([^_\r\n]+)_/],
  ['code', /`([^`\r\n]+)`/],
  ['math', /\$([^$\r\n]+)\$/],
  ['footnote', /\[\^([a-zA-Z0-9_.:-]+)\]/],
  ['cross-reference', /@((?:fig|tbl|eq|sec)-[a-zA-Z0-9_.:-]+)/],
]

function nextInlineCandidate(value: string): InlineCandidate | undefined {
  const candidates = inlinePatterns.flatMap<InlineCandidate>(([kind, pattern]) => {
    const match = value.match(pattern)
    return match && match.index !== undefined ? [{ index: match.index, raw: match[0], kind, match }] : []
  })
  return candidates.sort((left, right) => left.index - right.index || inlinePatterns.findIndex(([kind]) => kind === left.kind) - inlinePatterns.findIndex(([kind]) => kind === right.kind))[0]
}

function inlineNodes(value: string, idPrefix: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = []
  let remaining = value
  let ordinal = 0
  while (remaining) {
    const candidate = nextInlineCandidate(remaining)
    if (!candidate) {
      const plain = text(remaining.replace(/\r?\n/g, ' '))
      if (plain) nodes.push(plain)
      break
    }
    if (candidate.index > 0) {
      const plain = text(remaining.slice(0, candidate.index).replace(/\r?\n/g, ' '))
      if (plain) nodes.push(plain)
    }
    ordinal += 1
    const id = `${idPrefix}-${candidate.kind}-${ordinal}`
    if (candidate.kind === 'anchor') {
      const attributes = candidate.raw.slice(candidate.raw.indexOf('{') + 1, -1)
      nodes.push(manuscriptSchema.nodes.review_anchor.createChecked({
        id: attributes.match(/(?:^|\s)#([a-zA-Z][\w.:-]*)/)?.[1] ?? id,
        anchorId: attributes.match(/\bdata-anchor="([^"]+)"/)?.[1] ?? id,
        edge: attributes.match(/\bdata-edge="(start|end|point)"/)?.[1] ?? 'point',
        affinity: attributes.match(/\bdata-affinity="([^"]+)"/)?.[1] ?? 'after',
      }))
    } else if (candidate.kind === 'citation') {
      const items = parseCitationCluster(candidate.raw)
      const keys = items.map((item) => item.citekey)
      nodes.push(manuscriptSchema.nodes.citation.createChecked({
        id,
        keys,
        items,
        rendered: `(${keys.join('; ')})`,
      }))
    } else if (candidate.kind === 'link') {
      const mark = manuscriptSchema.marks.link.create({ href: candidate.match[2], title: candidate.match[3] || null })
      nodes.push(...marked(inlineNodes(candidate.match[1], id), mark))
    } else if (candidate.kind === 'strong') {
      nodes.push(...marked(inlineNodes(candidate.match[1] ?? candidate.match[2], id), manuscriptSchema.marks.strong.create()))
    } else if (candidate.kind === 'emphasis') {
      nodes.push(...marked(inlineNodes(candidate.match[1] ?? candidate.match[2], id), manuscriptSchema.marks.emphasis.create()))
    } else if (candidate.kind === 'code') {
      const code = text(candidate.match[1], [manuscriptSchema.marks.code.create()])
      if (code) nodes.push(code)
    } else if (candidate.kind === 'math') {
      nodes.push(manuscriptSchema.nodes.equation_inline.createChecked({ id, tex: candidate.match[1] }))
    } else if (candidate.kind === 'footnote') {
      nodes.push(manuscriptSchema.nodes.footnote_reference.createChecked({ id, label: candidate.match[1] }))
    } else {
      nodes.push(manuscriptSchema.nodes.cross_reference.createChecked({ id, target: candidate.match[1], rendered: candidate.match[1] }))
    }
    remaining = remaining.slice(candidate.index + candidate.raw.length)
  }
  return nodes
}

function paragraph(id: string, value: string) {
  return manuscriptSchema.nodes.paragraph.createChecked({ id, section: null }, inlineNodes(value, id))
}

function closingFence(lines: SourceLine[], start: number, marker: string) {
  const close = new RegExp(`^[ \\t]*\\${marker[0]}{${marker.length},}[ \\t]*$`)
  for (let index = start + 1; index < lines.length; index += 1) if (close.test(lines[index].content)) return index + 1
  return lines.length
}

function closingDiv(lines: SourceLine[], start: number) {
  const length = lines[start].content.match(/^(:{3,})/)?.[1].length ?? 3
  const close = new RegExp(`^:{${length},}[ \\t]*$`)
  for (let index = start + 1; index < lines.length; index += 1) if (close.test(lines[index].content)) return index + 1
  return lines.length
}

function outputEnd(lines: SourceLine[], start: number) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].content.includes('<!-- dm-output:end -->')) return index + 1
  }
  return lines.length
}

function isTableSeparator(value: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value)
}

function splitTableRow(value: string) {
  return value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isBlockStart(lines: SourceLine[], index: number) {
  const value = lines[index]?.content ?? ''
  return !value.trim()
    || /^#{1,6}\s+/.test(value)
    || /^[ \t]*(`{3,}|~{3,})/.test(value)
    || value.includes('<!-- dm-output:start')
    || /^:{3,}\s*\{/.test(value)
    || /^\s*>/.test(value)
    || /^\s*(?:[-+*]|\d+[.)])\s+/.test(value)
    || /^\s*\[\^[^\]]+\]:/.test(value)
    || /^\s*\$\$/.test(value)
    || /^\s*!\[[^\]]*\]\([^)]+\)/.test(value)
    || /^\s*(?:---+|\*\*\*+)\s*$/.test(value)
    || /^\s*</.test(value)
    || /\{\{<\s*/.test(value)
    || Boolean(lines[index + 1] && isTableSeparator(lines[index + 1].content))
}

function parseCodeAttributes(cell: ReturnType<typeof extractExecutableCells>['cells'][number]) {
  return Object.fromEntries(Object.entries(cell.attributes).map(([key, value]) => [key, value]))
}

function parseBlocks(lines: SourceLine[], diagnostics: DocumentDiagnostic[], ordinalRef: { value: number }): ProseMirrorNode[] {
  const blocks: ProseMirrorNode[] = []
  let index = 0
  const id = (kind: string, raw: string) => nodeId(kind, raw, ++ordinalRef.value)

  while (index < lines.length) {
    if (!lines[index].content.trim()) {
      index += 1
      continue
    }
    const value = lines[index].content

    const heading = value.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const raw = lines[index].raw
      blocks.push(manuscriptSchema.nodes.heading.createChecked({ id: id('heading', raw), level: heading[1].length, section: null }, inlineNodes(heading[2], `heading-${ordinalRef.value}`)))
      index += 1
      continue
    }

    if (value.includes('<!-- dm-output:start')) {
      const end = outputEnd(lines, index)
      const raw = lines.slice(index, end).map((line) => line.raw).join('')
      const cellId = raw.match(/\bcell="([^"]+)"/)?.[1] ?? id('output-cell', raw)
      const runHash = raw.match(/\brun="([^"]+)"/)?.[1] ?? null
      const kind = /!\[[^\]]*\]\([^)]+\)/.test(raw) ? 'image' : /\|[^\n]+\|/.test(raw) ? 'table' : 'markdown'
      blocks.push(manuscriptSchema.nodes.output_block.createChecked({ id: id('output', raw), cellId, kind, markdown: raw, runHash }))
      index = end
      continue
    }

    const fence = value.match(/^[ \t]*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const end = closingFence(lines, index, fence[1])
      const raw = lines.slice(index, end).map((line) => line.raw).join('')
      const extracted = extractExecutableCells(raw)
      diagnostics.push(...extracted.diagnostics)
      const cell = extracted.cells[0]
      if (cell) {
        blocks.push(manuscriptSchema.nodes.code_cell.createChecked({
          id: cell.id,
          language: cell.language,
          code: cell.source,
          outputKind: typeof cell.attributes.output === 'string' ? cell.attributes.output : null,
          status: 'stale',
          attributes: parseCodeAttributes(cell),
        }))
      } else {
        blocks.push(manuscriptSchema.nodes.raw_block.createChecked({ id: id('raw', raw), raw, format: 'code' }))
      }
      index = end
      continue
    }

    if (/^:{3,}\s*\{/.test(value)) {
      const end = closingDiv(lines, index)
      const raw = lines.slice(index, end).map((line) => line.raw).join('')
      blocks.push(manuscriptSchema.nodes.raw_block.createChecked({ id: id('raw', raw), raw, format: 'pandoc-div' }))
      index = end
      continue
    }

    if (/^\s*</.test(value) || /\{\{<\s*/.test(value)) {
      const raw = lines[index].raw
      blocks.push(manuscriptSchema.nodes.raw_block.createChecked({ id: id('raw', raw), raw, format: value.trimStart().startsWith('<') ? 'html' : 'quarto' }))
      index += 1
      continue
    }

    if (/^\s*>/.test(value)) {
      const quoted: SourceLine[] = []
      while (index < lines.length && /^\s*>/.test(lines[index].content)) {
        const content = lines[index].content.replace(/^\s*>\s?/, '')
        const ending = lines[index].raw.slice(lines[index].content.length)
        quoted.push({ content, raw: `${content}${ending}` })
        index += 1
      }
      const children = parseBlocks(quoted, diagnostics, ordinalRef)
      blocks.push(manuscriptSchema.nodes.blockquote.createChecked({ id: id('quote', quoted.map((line) => line.raw).join('')) }, children.length ? children : [paragraph(id('paragraph', ''), '')]))
      continue
    }

    const listMatch = value.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1])
      const items: ProseMirrorNode[] = []
      let order = ordered ? Number.parseInt(listMatch[1], 10) : 1
      while (index < lines.length) {
        const item = lines[index].content.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
        if (!item || /^\d/.test(item[1]) !== ordered) break
        const itemId = id('list-item', lines[index].raw)
        items.push(manuscriptSchema.nodes.list_item.createChecked({ id: itemId }, [paragraph(`${itemId}-paragraph`, item[2])]))
        index += 1
      }
      const listType = ordered ? manuscriptSchema.nodes.ordered_list : manuscriptSchema.nodes.bullet_list
      blocks.push(listType.createChecked(ordered ? { id: id('list', String(order)), order } : { id: id('list', '-') }, items))
      continue
    }

    if (lines[index + 1] && isTableSeparator(lines[index + 1].content)) {
      const rows: ProseMirrorNode[] = []
      const headerValues = splitTableRow(value)
      const headerCells = headerValues.map((cell, cellIndex) => manuscriptSchema.nodes.table_header.createChecked(
        { id: id('table-header', `${cellIndex}:${cell}`), colspan: 1, rowspan: 1, colwidth: null },
        [paragraph(id('table-paragraph', cell), cell)],
      ))
      rows.push(manuscriptSchema.nodes.table_row.createChecked({ id: id('table-row', value) }, headerCells))
      index += 2
      while (index < lines.length && /\|/.test(lines[index].content) && lines[index].content.trim()) {
        const values = splitTableRow(lines[index].content)
        const cells = values.map((cell, cellIndex) => manuscriptSchema.nodes.table_cell.createChecked(
          { id: id('table-cell', `${cellIndex}:${cell}`), colspan: 1, rowspan: 1, colwidth: null },
          [paragraph(id('table-paragraph', cell), cell)],
        ))
        rows.push(manuscriptSchema.nodes.table_row.createChecked({ id: id('table-row', lines[index].raw) }, cells))
        index += 1
      }
      blocks.push(manuscriptSchema.nodes.table.createChecked({ id: id('table', value) }, rows))
      continue
    }

    const footnote = value.match(/^\s*\[\^([^\]]+)\]:\s*(.*)$/)
    if (footnote) {
      blocks.push(manuscriptSchema.nodes.footnote_definition.createChecked({ id: id('footnote', lines[index].raw), label: footnote[1], contentMarkdown: footnote[2] }))
      index += 1
      continue
    }

    if (/^\s*\$\$/.test(value)) {
      const equationLines = [value.replace(/^\s*\$\$\s*/, '')]
      index += 1
      while (index < lines.length && !/\$\$\s*$/.test(equationLines.at(-1) ?? '')) {
        equationLines.push(lines[index].content)
        index += 1
      }
      equationLines[equationLines.length - 1] = equationLines.at(-1)?.replace(/\s*\$\$\s*$/, '') ?? ''
      const tex = equationLines.join('\n').trim()
      blocks.push(manuscriptSchema.nodes.equation_block.createChecked({ id: id('equation', tex), tex, label: null }))
      continue
    }

    const image = value.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)(?:\{#([^}\s]+)[^}]*\})?\s*$/)
    if (image) {
      const imageId = id('image', lines[index].raw)
      const content = [manuscriptSchema.nodes.image.createChecked({ id: imageId, src: image[2], alt: image[1], title: image[3] || null, label: image[4] || null })]
      if (lines[index + 1]?.content.match(/^:\s+(.+)/)) {
        const caption = lines[index + 1].content.replace(/^:\s+/, '')
        content.push(manuscriptSchema.nodes.caption.createChecked({ id: `${imageId}-caption` }, inlineNodes(caption, `${imageId}-caption`)))
        index += 1
      }
      blocks.push(manuscriptSchema.nodes.figure.createChecked({ id: id('figure', lines[index].raw) }, content))
      index += 1
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(value)) {
      blocks.push(manuscriptSchema.nodes.horizontal_rule.createChecked({ id: id('rule', lines[index].raw) }))
      index += 1
      continue
    }

    const paragraphLines = [lines[index].content]
    const rawLines = [lines[index].raw]
    index += 1
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].content)
      rawLines.push(lines[index].raw)
      index += 1
    }
    const raw = rawLines.join('')
    blocks.push(paragraph(id('paragraph', raw), paragraphLines.join('\n')))
  }
  return blocks
}

export function parseStructuredManuscript(source: string): StructuredManuscript {
  const diagnostics: DocumentDiagnostic[] = []
  const ending = sourceLineEnding(source)
  const review = parseReviewMarkup(source)
  diagnostics.push(...review.diagnostics.filter((diagnostic) => diagnostic.level !== 'info'))
  const reviewStart = review.sectionStart
  const reviewEnd = review.sectionEnd ?? source.length
  const reviewSection = reviewStart === undefined ? undefined : source.slice(reviewStart, reviewEnd)
  let body = reviewStart === undefined ? source : `${source.slice(0, reviewStart)}${source.slice(reviewEnd)}`
  let frontmatter: string | undefined
  const lines = sourceLines(body)
  if (lines[0]?.content === '---') {
    const closing = lines.slice(1).findIndex((line) => line.content === '---')
    if (closing >= 0) {
      const end = closing + 2
      frontmatter = lines.slice(0, end).map((line) => line.raw).join('')
      body = lines.slice(end).map((line) => line.raw).join('')
    } else {
      diagnostics.push({ code: 'structured-frontmatter-unclosed', level: 'error', message: 'YAML front matter is not closed and remains available in the source inspector.' })
    }
  }

  const blocks = parseBlocks(sourceLines(body), diagnostics, { value: 0 })
  if (!blocks.length) blocks.push(paragraph('dm-empty-paragraph', ''))
  const document = manuscriptSchema.nodes.doc.createChecked(null, blocks)
  return {
    document,
    metadata: {
      frontmatter,
      reviewSection,
      lineEnding: ending,
      originalSource: source,
      originalDocumentJson: document.toJSON(),
    },
    diagnostics,
  }
}

function escapeText(value: string) {
  return value.replace(/([\\`*_[\]])/g, '\\$1')
}

function serializeTextNode(node: ProseMirrorNode) {
  let value = escapeText(node.text ?? '')
  for (const mark of node.marks) {
    if (mark.type === manuscriptSchema.marks.code) value = `\`${node.text ?? ''}\``
    else if (mark.type === manuscriptSchema.marks.strong) value = `**${value}**`
    else if (mark.type === manuscriptSchema.marks.emphasis) value = `*${value}*`
    else if (mark.type === manuscriptSchema.marks.link) value = `[${value}](${mark.attrs.href}${mark.attrs.title ? ` "${mark.attrs.title}"` : ''})`
  }
  return value
}

function serializeInline(node: ProseMirrorNode) {
  if (node.isText) return serializeTextNode(node)
  if (node.type === manuscriptSchema.nodes.hard_break) return '  \n'
  if (node.type === manuscriptSchema.nodes.equation_inline) return `$${node.attrs.tex}$`
  if (node.type === manuscriptSchema.nodes.citation) {
    const items = Array.isArray(node.attrs.items) ? node.attrs.items : []
    return serializeCitationCluster(items.length ? items : (node.attrs.keys as string[]).map((citekey) => ({ citekey })))
  }
  if (node.type === manuscriptSchema.nodes.cross_reference) return `@${node.attrs.target}`
  if (node.type === manuscriptSchema.nodes.footnote_reference) return `[^${node.attrs.label}]`
  if (node.type === manuscriptSchema.nodes.review_anchor) {
    const edge = node.attrs.edge ?? 'point'
    const affinity = node.attrs.affinity ? ` data-affinity="${node.attrs.affinity}"` : ''
    return `[]{#${node.attrs.id} .dm-anchor data-anchor="${node.attrs.anchorId}" data-edge="${edge}"${affinity}}`
  }
  return node.textContent
}

function serializeInlineContent(node: ProseMirrorNode) {
  let value = ''
  node.forEach((child) => { value += serializeInline(child) })
  return value
}

function serializeTable(node: ProseMirrorNode, ending: string) {
  const rows: string[][] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => cells.push(serializeInlineContent(cell.firstChild ?? cell)))
    rows.push(cells)
  })
  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => '')])
  return [
    `| ${normalized[0].join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join(ending)
}

function serializeBlock(node: ProseMirrorNode, ending: string, index = 0): string {
  if (node.type === manuscriptSchema.nodes.heading) return `${'#'.repeat(node.attrs.level)} ${serializeInlineContent(node)}`
  if (node.type === manuscriptSchema.nodes.paragraph) return serializeInlineContent(node)
  if (node.type === manuscriptSchema.nodes.blockquote) {
    const content: string[] = []
    node.forEach((child, _offset, childIndex) => content.push(serializeBlock(child, ending, childIndex)))
    return content.join(`${ending}${ending}`).split(/\r\n|\r|\n/).map((line) => `> ${line}`).join(ending)
  }
  if (node.type === manuscriptSchema.nodes.bullet_list || node.type === manuscriptSchema.nodes.ordered_list) {
    const items: string[] = []
    node.forEach((item, _offset, itemIndex) => {
      const prefix = node.type === manuscriptSchema.nodes.ordered_list ? `${node.attrs.order + itemIndex}.` : '-'
      items.push(`${prefix} ${serializeInlineContent(item.firstChild ?? item)}`)
    })
    return items.join(ending)
  }
  if (node.type === manuscriptSchema.nodes.horizontal_rule) return '---'
  if (node.type === manuscriptSchema.nodes.equation_block) return `$$${ending}${node.attrs.tex}${ending}$$${node.attrs.label ? ` {#${node.attrs.label}}` : ''}`
  if (node.type === manuscriptSchema.nodes.figure) {
    const image = node.firstChild
    const caption = node.childCount > 1 ? node.child(1) : undefined
    if (!image) return ''
    const title = image.attrs.title ? ` "${image.attrs.title}"` : ''
    const label = image.attrs.label ? `{#${image.attrs.label}}` : ''
    return `![${image.attrs.alt}](${image.attrs.src}${title})${label}${caption ? `${ending}: ${serializeInlineContent(caption)}` : ''}`
  }
  if (node.type === manuscriptSchema.nodes.footnote_definition) return `[^${node.attrs.label}]: ${node.attrs.contentMarkdown}`
  if (node.type === manuscriptSchema.nodes.table) return serializeTable(node, ending)
  if (node.type === manuscriptSchema.nodes.code_cell) {
    const attributes = Object.entries(node.attrs.attributes ?? {})
      .filter(([key]) => key !== 'id' && key !== 'execute')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => value === true ? `.${key}` : `${key}="${String(value)}"`)
    const attr = [`#${node.attrs.id}`, '.execute', ...attributes].join(' ')
    const fenceLength = Math.max(3, ...[...(node.attrs.code as string).matchAll(/`+/g)].map((match) => match[0].length + 1))
    const fence = '`'.repeat(fenceLength)
    return `${fence}${node.attrs.language} {${attr}}${ending}${node.attrs.code}${ending}${fence}`
  }
  if (node.type === manuscriptSchema.nodes.output_block) return String(node.attrs.markdown).replace(/(?:\r\n|\r|\n)+$/, '')
  if (node.type === manuscriptSchema.nodes.raw_block) return String(node.attrs.raw).replace(/(?:\r\n|\r|\n)+$/, '')
  return node.textContent
}

export function serializeStructuredManuscript(document: ProseMirrorNode, metadata: StructuredManuscriptMetadata) {
  if (JSON.stringify(document.toJSON()) === JSON.stringify(metadata.originalDocumentJson)) return metadata.originalSource
  const ending = metadata.lineEnding
  const blocks: string[] = []
  document.forEach((node, _offset, index) => blocks.push(serializeBlock(node, ending, index)))
  const body = blocks.filter((block) => block !== '').join(`${ending}${ending}`)
  const pieces = [metadata.frontmatter?.replace(/(?:\r\n|\r|\n)+$/, ''), body, metadata.reviewSection?.replace(/(?:\r\n|\r|\n)+$/, '')].filter((piece): piece is string => Boolean(piece))
  return `${pieces.join(`${ending}${ending}`)}${ending}`
}
