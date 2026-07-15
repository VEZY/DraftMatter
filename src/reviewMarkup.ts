import { sourceHash } from './document'
import { parseLosslessPortableSource } from './portableSource'
import type { DocumentDiagnostic } from './types'

export interface ReviewAnchor {
  markerId: string
  anchorId: string
  edge: 'start' | 'end' | 'point'
  affinity?: string
  start: number
  end: number
  raw: string
}

interface ReviewRecordBase {
  id: string
  start: number
  end: number
  raw: string
  attributes: Record<string, string>
  classes: string[]
}

export interface ReviewAuthor extends ReviewRecordBase {
  kind: 'author'
  name: string
}

export interface ReviewChange extends ReviewRecordBase {
  kind: 'change'
  anchorId: string
  authorId: string
  changeKind: string
  status: string
  proposal?: string
  rationale?: string
  anchorContext?: ReviewAnchorContext
}

export interface ReviewAnchorContext {
  quote: string
  prefix: string
  suffix: string
}

export interface ReviewThreadMessage {
  content: string
  authorId?: string
  timestamp?: string
  index?: number
}

export interface ReviewThread extends ReviewRecordBase {
  kind: 'thread'
  anchorId: string
  authorId: string
  status: string
  messages: string[]
  messageRecords: ReviewThreadMessage[]
  anchorContext?: ReviewAnchorContext
}

export interface ReviewDecision extends ReviewRecordBase {
  kind: 'decision'
  changeId: string
  authorId: string
  action: string
  timestamp?: string
}

export interface UnknownReviewRecord extends ReviewRecordBase {
  kind: 'unknown'
}

export interface ReviewAnchorRange {
  anchorId: string
  start: number
  end: number
  markerIds: string[]
  complete: boolean
}

export interface ReviewMarkupDocument {
  source: string
  sourceHash: string
  schema?: string
  sectionStart?: number
  sectionEnd?: number
  anchors: ReviewAnchor[]
  ranges: ReviewAnchorRange[]
  authors: ReviewAuthor[]
  changes: ReviewChange[]
  threads: ReviewThread[]
  decisions: ReviewDecision[]
  unknownRecords: UnknownReviewRecord[]
  diagnostics: DocumentDiagnostic[]
}

interface IndexedLine {
  content: string
  start: number
  end: number
}

function indexedLines(source: string) {
  const rawLines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? []
  let offset = 0
  return rawLines.map<IndexedLine>((raw) => {
    const line = { content: raw.replace(/(?:\r\n|\n|\r)$/, ''), start: offset, end: offset + raw.length }
    offset = line.end
    return line
  })
}

function parseAttributes(source: string) {
  const attributes: Record<string, string> = {}
  const classes: string[] = []
  let id = ''
  const tokens = source.matchAll(/(?:^|\s)(#[a-zA-Z][\w.:-]*|\.[a-zA-Z][\w-]*|([a-zA-Z][\w:-]*)=(?:"([^"]*)"|'([^']*)'|([^\s}]+)))/g)
  for (const token of tokens) {
    if (token[1].startsWith('#')) id = token[1].slice(1)
    else if (token[1].startsWith('.')) classes.push(token[1].slice(1))
    else attributes[token[2]] = decodeAttribute(token[3] ?? token[4] ?? token[5] ?? '')
  }
  return { id, classes, attributes }
}

function decodeAttribute(value: string) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function literalBlocks(body: string) {
  const lines = indexedLines(body)
  const blocks: { className: string; attributes: Record<string, string>; content: string; start: number; end: number; contentStart: number; contentEnd: number }[] = []
  let index = 0
  while (index < lines.length) {
    const opening = lines[index].content.match(/^[ \t]*(`{3,}|~{3,})\{([^}]*)\}[ \t]*$/)
    if (!opening) {
      index += 1
      continue
    }
    const parsed = parseAttributes(opening[2])
    const className = parsed.classes.find((candidate) => candidate.startsWith('dm-')) ?? parsed.classes[0]
    if (!className) {
      index += 1
      continue
    }
    const marker = opening[1]
    const closing = new RegExp(`^[ \\t]*\\${marker[0]}{${marker.length},}[ \\t]*$`)
    let end = index + 1
    while (end < lines.length && !closing.test(lines[end].content)) end += 1
    const contentStart = lines[index].end
    const contentEnd = end < lines.length ? lines[end].start : body.length
    blocks.push({
      className,
      attributes: parsed.attributes,
      content: body.slice(contentStart, contentEnd).replace(/(?:\r\n|\n|\r)$/, ''),
      start: lines[index].start,
      end: end < lines.length ? lines[end].end : body.length,
      contentStart,
      contentEnd,
    })
    index = end + 1
  }
  return blocks
}

function closingLineIndex(lines: IndexedLine[], start: number, limit: number, colonCount: number) {
  const closing = new RegExp(`^:{${colonCount},}[ \\t]*$`)
  let literalFence: { character: string; length: number } | undefined
  for (let index = start; index < limit; index += 1) {
    const content = lines[index].content
    if (literalFence) {
      const fenceClose = new RegExp(`^[ \\t]*\\${literalFence.character}{${literalFence.length},}[ \\t]*$`)
      if (fenceClose.test(content)) literalFence = undefined
      continue
    }
    const fenceOpen = content.match(/^[ \t]*(`{3,}|~{3,})\{[^}]*\}[ \t]*$/)
    if (fenceOpen) {
      literalFence = { character: fenceOpen[1][0], length: fenceOpen[1].length }
      continue
    }
    if (closing.test(content)) return index
  }
  return limit
}

function fencedLineIndexes(lines: IndexedLine[]) {
  const fenced = new Set<number>()
  let marker: { character: string; length: number } | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].content
    if (marker) {
      fenced.add(index)
      const closing = new RegExp(`^[ \\t]*\\${marker.character}{${marker.length},}[ \\t]*$`)
      if (closing.test(content)) marker = undefined
      continue
    }
    const opening = content.match(/^[ \t]*(`{3,}|~{3,})(?:\{[^}]*\}|[^\s].*)?[ \t]*$/)
    if (!opening) continue
    fenced.add(index)
    marker = { character: opening[1][0], length: opening[1].length }
  }
  return fenced
}

function deriveRanges(anchors: ReviewAnchor[], diagnostics: DocumentDiagnostic[]) {
  const grouped = new Map<string, ReviewAnchor[]>()
  for (const anchor of anchors) grouped.set(anchor.anchorId, [...(grouped.get(anchor.anchorId) ?? []), anchor])

  return [...grouped.entries()].map<ReviewAnchorRange>(([anchorId, markers]) => {
    const point = markers.find((marker) => marker.edge === 'point')
    const start = markers.find((marker) => marker.edge === 'start')
    const end = markers.find((marker) => marker.edge === 'end')
    const complete = Boolean(point ? markers.length === 1 : start && end)
    if (!complete) diagnostics.push({
      code: `review-anchor-${anchorId}-incomplete`,
      level: 'error',
      message: `Review anchor ${anchorId} does not have one point marker or a complete start/end pair.`,
    })
    return {
      anchorId,
      start: point?.start ?? start?.end ?? markers[0].start,
      end: point?.start ?? end?.start ?? markers.at(-1)?.end ?? markers[0].end,
      markerIds: markers.map((marker) => marker.markerId),
      complete,
    }
  })
}

export function parseReviewMarkup(source: string): ReviewMarkupDocument {
  const diagnostics: DocumentDiagnostic[] = []
  const lossless = parseLosslessPortableSource(source)
  const anchors = lossless.semanticNodes
    .filter((node) => node.kind === 'review-anchor')
    .map<ReviewAnchor>((node) => ({
      markerId: String(node.attributes.label ?? node.id.slice('anchor:'.length)),
      anchorId: String(node.attributes.anchor ?? ''),
      edge: node.attributes.edge === 'start' || node.attributes.edge === 'end' || node.attributes.edge === 'point' ? node.attributes.edge : 'point',
      affinity: typeof node.attributes.affinity === 'string' ? node.attributes.affinity : undefined,
      start: node.start,
      end: node.end,
      raw: node.raw,
    }))
  const lines = indexedLines(source)
  const fencedLines = fencedLineIndexes(lines)
  const sectionOpeners = lines
    .map((line, index) => ({ line, index, match: line.content.match(/^(:{5,})[ \t]+\{([^}]*)\}[ \t]*$/) }))
    .filter((candidate) => !fencedLines.has(candidate.index) && candidate.match && parseAttributes(candidate.match[2]).classes.includes('draftmatter-reviews'))

  if (sectionOpeners.length === 0) diagnostics.push({ code: 'review-section-missing', level: 'info', message: 'This manuscript has no DraftMatter review section.' })
  if (sectionOpeners.length > 1) diagnostics.push({ code: 'review-section-duplicate', level: 'error', message: 'A manuscript may contain only one DraftMatter review section.' })

  const opener = sectionOpeners[0]
  let sectionStart: number | undefined
  let sectionEnd: number | undefined
  let schema: string | undefined
  const authors: ReviewAuthor[] = []
  const changes: ReviewChange[] = []
  const threads: ReviewThread[] = []
  const decisions: ReviewDecision[] = []
  const unknownRecords: UnknownReviewRecord[] = []

  if (opener?.match) {
    sectionStart = opener.line.start
    const outerLength = opener.match[1].length
    const outerAttributes = parseAttributes(opener.match[2])
    schema = outerAttributes.attributes['data-schema']
    if (schema !== '1') diagnostics.push({ code: 'review-schema-unsupported', level: 'warning', message: `DraftMatter review schema ${schema ?? 'unknown'} is preserved but not fully understood.` })

    const closingIndex = closingLineIndex(lines, opener.index + 1, lines.length, outerLength)
    sectionEnd = lines[closingIndex]?.end ?? source.length

    let index = opener.index + 1
    while (index < closingIndex) {
      const recordOpening = lines[index].content.match(/^(:{3,4})[ \t]+\{([^}]*)\}[ \t]*$/)
      if (!recordOpening) {
        index += 1
        continue
      }
      const endIndex = closingLineIndex(lines, index + 1, closingIndex, recordOpening[1].length)
      if (endIndex >= closingIndex) {
        diagnostics.push({ code: `review-record-${index}-unclosed`, level: 'error', message: 'A DraftMatter review record is not closed.' })
        break
      }

      const parsedAttributes = parseAttributes(recordOpening[2])
      const id = parsedAttributes.id || `unknown:${lines[index].start}`
      const start = lines[index].start
      const end = lines[endIndex].end
      const raw = source.slice(start, end)
      const body = source.slice(lines[index].end, lines[endIndex].start)
      const literals = literalBlocks(body)
      const base = { id, start, end, raw, attributes: parsedAttributes.attributes, classes: parsedAttributes.classes }

      if (parsedAttributes.classes.includes('dm-author')) {
        authors.push({ ...base, kind: 'author', name: parsedAttributes.attributes['data-name'] ?? id })
      } else if (parsedAttributes.classes.includes('dm-change')) {
        const quote = literals.find((block) => block.className === 'dm-anchor-quote')
        const prefix = literals.find((block) => block.className === 'dm-anchor-prefix')
        const suffix = literals.find((block) => block.className === 'dm-anchor-suffix')
        changes.push({
          ...base,
          kind: 'change',
          anchorId: parsedAttributes.attributes['data-anchor'] ?? '',
          authorId: parsedAttributes.attributes['data-author'] ?? '',
          changeKind: parsedAttributes.attributes['data-kind'] ?? 'unknown',
          status: parsedAttributes.attributes['data-status'] ?? 'open',
          proposal: literals.find((block) => block.className === 'dm-proposal')?.content,
          rationale: literals.find((block) => block.className === 'dm-rationale')?.content,
          ...(quote && prefix && suffix ? { anchorContext: { quote: quote.content, prefix: prefix.content, suffix: suffix.content } } : {}),
        })
      } else if (parsedAttributes.classes.includes('dm-thread')) {
        const quote = literals.find((block) => block.className === 'dm-anchor-quote')
        const prefix = literals.find((block) => block.className === 'dm-anchor-prefix')
        const suffix = literals.find((block) => block.className === 'dm-anchor-suffix')
        const messageRecords = literals.filter((block) => block.className === 'dm-message').map<ReviewThreadMessage>((block) => ({
          content: block.content,
          ...(block.attributes['data-author'] ? { authorId: block.attributes['data-author'] } : {}),
          ...(block.attributes['data-at'] ? { timestamp: block.attributes['data-at'] } : {}),
          ...(/^\d+$/.test(block.attributes['data-index'] ?? '') ? { index: Number(block.attributes['data-index']) } : {}),
        }))
        threads.push({
          ...base,
          kind: 'thread',
          anchorId: parsedAttributes.attributes['data-anchor'] ?? '',
          authorId: parsedAttributes.attributes['data-author'] ?? '',
          status: parsedAttributes.attributes['data-status'] ?? 'open',
          messages: messageRecords.map((message) => message.content),
          messageRecords,
          ...(quote && prefix && suffix ? { anchorContext: { quote: quote.content, prefix: prefix.content, suffix: suffix.content } } : {}),
        })
      } else if (parsedAttributes.classes.includes('dm-decision')) {
        decisions.push({
          ...base,
          kind: 'decision',
          changeId: parsedAttributes.attributes['data-change'] ?? '',
          authorId: parsedAttributes.attributes['data-author'] ?? '',
          action: parsedAttributes.attributes['data-action'] ?? 'unknown',
          timestamp: parsedAttributes.attributes['data-at'],
        })
      } else {
        unknownRecords.push({ ...base, kind: 'unknown' })
      }
      index = endIndex + 1
    }
  }

  const ranges = deriveRanges(anchors, diagnostics)
  const authorIds = new Set(authors.map((author) => author.id))
  const anchorIds = new Set(ranges.filter((range) => range.complete).map((range) => range.anchorId))
  for (const change of changes.filter((candidate) => candidate.status === 'open')) {
    if (!anchorIds.has(change.anchorId)) diagnostics.push({ code: `review-change-${change.id}-anchor-missing`, level: 'error', message: `Open change ${change.id} references missing anchor ${change.anchorId || '(empty)'}.` })
    if (!authorIds.has(change.authorId)) diagnostics.push({ code: `review-change-${change.id}-author-missing`, level: 'error', message: `Open change ${change.id} references missing author ${change.authorId || '(empty)'}.` })
  }
  for (const thread of threads.filter((candidate) => candidate.status !== 'deleted')) {
    if (!anchorIds.has(thread.anchorId)) diagnostics.push({ code: `review-thread-${thread.id}-anchor-missing`, level: 'error', message: `Review thread ${thread.id} references missing anchor ${thread.anchorId || '(empty)'}.` })
    if (!authorIds.has(thread.authorId)) diagnostics.push({ code: `review-thread-${thread.id}-author-missing`, level: 'error', message: `Review thread ${thread.id} references missing author ${thread.authorId || '(empty)'}.` })
  }
  const changeIds = new Set(changes.map((change) => change.id))
  for (const decision of decisions) {
    if (!changeIds.has(decision.changeId)) diagnostics.push({ code: `review-decision-${decision.id}-change-missing`, level: 'error', message: `Review decision ${decision.id} references missing change ${decision.changeId || '(empty)'}.` })
    if (!authorIds.has(decision.authorId)) diagnostics.push({ code: `review-decision-${decision.id}-author-missing`, level: 'error', message: `Review decision ${decision.id} references missing author ${decision.authorId || '(empty)'}.` })
  }

  const recordIds = [...authors, ...changes, ...threads, ...decisions, ...unknownRecords].map((record) => record.id)
  for (const id of new Set(recordIds.filter((candidate, index) => recordIds.indexOf(candidate) !== index))) {
    diagnostics.push({ code: `review-record-${id}-duplicate`, level: 'error', message: `Review record ID ${id} is duplicated.` })
  }

  return {
    source,
    sourceHash: sourceHash(source),
    schema,
    sectionStart,
    sectionEnd,
    anchors,
    ranges,
    authors,
    changes,
    threads,
    decisions,
    unknownRecords,
    diagnostics,
  }
}

export function serializeReviewMarkup(document: ReviewMarkupDocument) {
  return document.source
}

export function updateReviewRecordStatus(document: ReviewMarkupDocument, recordId: string, status: string) {
  const record = [...document.changes, ...document.threads].find((candidate) => candidate.id === recordId)
  if (!record) throw new Error(`Review record ${recordId} does not support a status update.`)
  const headerEnd = record.raw.search(/\r\n|\n|\r/)
  const header = headerEnd < 0 ? record.raw : record.raw.slice(0, headerEnd)
  const updatedHeader = /\bdata-status="[^"]*"/.test(header)
    ? header.replace(/\bdata-status="[^"]*"/, `data-status="${status}"`)
    : header.replace(/\}[ \t]*$/, ` data-status="${status}"}`)
  const updatedRaw = `${updatedHeader}${headerEnd < 0 ? '' : record.raw.slice(headerEnd)}`
  return parseReviewMarkup(`${document.source.slice(0, record.start)}${updatedRaw}${document.source.slice(record.end)}`)
}

function messageFence(message: string) {
  const longest = Math.max(0, ...[...message.matchAll(/^~+/gm)].map((match) => match[0].length))
  return '~'.repeat(Math.max(3, longest + 1))
}

function rewrittenMessageBlock(raw: string, block: ReturnType<typeof literalBlocks>[number], message: string) {
  const opening = raw.slice(block.start, block.contentStart)
  const ending = opening.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '\n'
  const header = opening.slice(0, -ending.length)
  const marker = header.match(/^(`{3,}|~{3,})/)?.[1] ?? '~~~'
  const longest = Math.max(0, ...[...message.matchAll(new RegExp(`^\\${marker[0]}+`, 'gm'))].map((match) => match[0].length))
  if (longest < marker.length) return null
  const fence = marker[0].repeat(longest + 1)
  return `${fence}${header.slice(marker.length)}${ending}${message}${ending}${fence}${ending}`
}

export function updateReviewThreadMessages(document: ReviewMarkupDocument, recordId: string, messages: string[], authorId = 'dm-a01') {
  const record = document.threads.find((candidate) => candidate.id === recordId)
  if (!record) throw new Error(`Review thread ${recordId} was not found.`)
  if (messages.length === 0) throw new Error(`Review thread ${recordId} must retain its opening message.`)

  const blocks = literalBlocks(record.raw).filter((block) => block.className === 'dm-message')
  if (blocks.length === 0) throw new Error(`Review thread ${recordId} has no message payload.`)
  const patches: { start: number; end: number; replacement: string }[] = []
  const retained = Math.min(blocks.length, messages.length)
  for (let index = 0; index < retained; index += 1) {
    const rewritten = rewrittenMessageBlock(record.raw, blocks[index], messages[index])
    if (rewritten !== null) {
      patches.push({ start: blocks[index].start, end: blocks[index].end, replacement: rewritten })
    } else {
      const ending = record.raw.slice(blocks[index].contentStart, blocks[index].contentEnd).match(/(?:\r\n|\n|\r)$/)?.[0] ?? '\n'
      patches.push({ start: blocks[index].contentStart, end: blocks[index].contentEnd, replacement: `${messages[index]}${ending}` })
    }
  }
  for (let index = messages.length; index < blocks.length; index += 1) {
    patches.push({ start: blocks[index].start, end: blocks[index].end, replacement: '' })
  }
  if (messages.length > blocks.length) {
    const lineEnding = document.source.includes('\r\n') ? '\r\n' : document.source.includes('\r') ? '\r' : '\n'
    const added = messages.slice(blocks.length).map((message, offset) => {
      const fence = messageFence(message)
      return `${fence}{.dm-message data-author="${authorId}" data-index="${blocks.length + offset}"}${lineEnding}${message}${lineEnding}${fence}${lineEnding}`
    }).join('')
    patches.push({ start: blocks.at(-1)!.end, end: blocks.at(-1)!.end, replacement: added })
  }

  let updatedRaw = record.raw
  for (const patch of patches.sort((left, right) => right.start - left.start || right.end - left.end)) {
    updatedRaw = `${updatedRaw.slice(0, patch.start)}${patch.replacement}${updatedRaw.slice(patch.end)}`
  }
  return parseReviewMarkup(`${document.source.slice(0, record.start)}${updatedRaw}${document.source.slice(record.end)}`)
}
