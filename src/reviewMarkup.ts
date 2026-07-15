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
}

export interface ReviewThread extends ReviewRecordBase {
  kind: 'thread'
  anchorId: string
  authorId: string
  status: string
  messages: string[]
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
    else attributes[token[2]] = token[3] ?? token[4] ?? token[5] ?? ''
  }
  return { id, classes, attributes }
}

function literalBlocks(body: string) {
  const lines = indexedLines(body)
  const blocks: { className: string; content: string }[] = []
  let index = 0
  while (index < lines.length) {
    const opening = lines[index].content.match(/^[ \t]*(`{3,}|~{3,})\{\.([a-zA-Z][\w-]*)[^}]*\}[ \t]*$/)
    if (!opening) {
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
      className: opening[2],
      content: body.slice(contentStart, contentEnd).replace(/(?:\r\n|\n|\r)$/, ''),
    })
    index = end + 1
  }
  return blocks
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
      end: point?.end ?? end?.start ?? markers.at(-1)?.end ?? markers[0].end,
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
  const sectionOpeners = lines
    .map((line, index) => ({ line, index, match: line.content.match(/^(:{5,})[ \t]+\{([^}]*)\}[ \t]*$/) }))
    .filter((candidate) => candidate.match && parseAttributes(candidate.match[2]).classes.includes('draftmatter-reviews'))

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

    let closingIndex = lines.length - 1
    const outerClosing = new RegExp(`^:{${outerLength},}[ \\t]*$`)
    for (let index = opener.index + 1; index < lines.length; index += 1) {
      if (outerClosing.test(lines[index].content)) {
        closingIndex = index
        break
      }
    }
    sectionEnd = lines[closingIndex]?.end ?? source.length

    let index = opener.index + 1
    while (index < closingIndex) {
      const recordOpening = lines[index].content.match(/^(:{3,4})[ \t]+\{([^}]*)\}[ \t]*$/)
      if (!recordOpening) {
        index += 1
        continue
      }
      const recordClosing = new RegExp(`^:{${recordOpening[1].length}}[ \\t]*$`)
      let endIndex = index + 1
      while (endIndex < closingIndex && !recordClosing.test(lines[endIndex].content)) endIndex += 1
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
        changes.push({
          ...base,
          kind: 'change',
          anchorId: parsedAttributes.attributes['data-anchor'] ?? '',
          authorId: parsedAttributes.attributes['data-author'] ?? '',
          changeKind: parsedAttributes.attributes['data-kind'] ?? 'unknown',
          status: parsedAttributes.attributes['data-status'] ?? 'open',
          proposal: literals.find((block) => block.className === 'dm-proposal')?.content,
          rationale: literals.find((block) => block.className === 'dm-rationale')?.content,
        })
      } else if (parsedAttributes.classes.includes('dm-thread')) {
        threads.push({
          ...base,
          kind: 'thread',
          anchorId: parsedAttributes.attributes['data-anchor'] ?? '',
          authorId: parsedAttributes.attributes['data-author'] ?? '',
          status: parsedAttributes.attributes['data-status'] ?? 'open',
          messages: literals.filter((block) => block.className === 'dm-message').map((block) => block.content),
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
