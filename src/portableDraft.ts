import { parseLosslessPortableSource } from './portableSource'
import { parseReviewMarkup, serializeReviewMarkup, updateReviewRecordStatus, updateReviewThreadMessages } from './reviewMarkup'
import type { DraftState, PortableDraftBaseline } from './types'
import { citationItemsForDraft, sameCitationItems, serializeCitationCluster } from './citation'

interface SourcePatch {
  start: number
  end: number
  replacement: string
}

interface SectionRange {
  key?: 'abstract' | 'introduction' | 'methods' | 'results' | 'conclusion'
  start: number
  contentStart: number
  end: number
}

const KNOWN_SECTIONS: Record<string, SectionRange['key']> = {
  abstract: 'abstract',
  introduction: 'introduction',
  methods: 'methods',
  results: 'results',
  conclusion: 'conclusion',
}

function normalizeHeading(heading: string) {
  return heading.trim().replace(/^\d+(?:\.\d+)*[.)]?\s+/, '').toLowerCase()
}

function sectionRanges(source: string) {
  const matches = [...source.matchAll(/^##[ \t]+(.+?)[ \t]*\r?$/gm)]
  return matches.map<SectionRange>((match, index) => {
    const start = match.index ?? 0
    const lineEnd = source.indexOf('\n', start)
    return {
      key: KNOWN_SECTIONS[normalizeHeading(match[1])],
      start,
      contentStart: lineEnd < 0 ? source.length : lineEnd + 1,
      end: matches[index + 1]?.index ?? source.length,
    }
  })
}

function lineEnding(source: string) {
  return source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
}

function sourceText(value: string, ending: string) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', ending)
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function applyPatches(source: string, patches: SourcePatch[]) {
  let updated = source
  for (const patch of [...patches].sort((left, right) => right.start - left.start || right.end - left.end)) {
    updated = `${updated.slice(0, patch.start)}${patch.replacement}${updated.slice(patch.end)}`
  }
  return updated
}

function patchExactField(
  source: string,
  section: SectionRange | undefined,
  baseline: string,
  value: string,
  ending: string,
  patches: SourcePatch[],
) {
  if (!section || baseline === value) return
  const original = sourceText(baseline, ending)
  const offset = source.indexOf(original, section.contentStart)
  if (offset >= section.contentStart && offset + original.length <= section.end) {
    patches.push({ start: offset, end: offset + original.length, replacement: sourceText(value, ending) })
  }
}

function patchTitle(source: string, baseline: PortableDraftBaseline, draft: DraftState, patches: SourcePatch[]) {
  if (baseline.title === draft.title) return
  const frontmatterEnd = source.startsWith('---') ? source.search(/(?:\r\n|\n|\r)---(?:\r\n|\n|\r)/) : -1
  if (frontmatterEnd < 0) return
  const frontmatter = source.slice(0, frontmatterEnd)
  const title = /^(title[ \t]*:[ \t]*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\r\n]*)/m.exec(frontmatter)
  if (!title || title.index === undefined) return
  const valueStart = title.index + title[1].length
  patches.push({
    start: valueStart,
    end: title.index + title[0].length,
    replacement: `"${draft.title.replaceAll('"', '\\"')}"`,
  })
}

function patchCitationCluster(
  source: string,
  section: SectionRange | undefined,
  baseline: PortableDraftBaseline,
  draft: DraftState,
  patches: SourcePatch[],
) {
  if (!section || sameCitationItems(baseline.citationItems, citationItemsForDraft(draft))) return
  const sectionSource = source.slice(section.contentStart, section.end)
  const matches = [...sectionSource.matchAll(/\[[^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*\]/g)]
  const citation = matches.at(-1)
  const replacement = serializeCitationCluster(citationItemsForDraft(draft))
  if (citation?.index !== undefined) {
    const start = section.contentStart + citation.index
    patches.push({ start, end: start + citation[0].length, replacement })
  } else {
    const insertion = section.contentStart + sectionSource.trimEnd().length
    patches.push({ start: insertion, end: insertion, replacement: ` ${replacement}` })
  }
}

function patchCode(source: string, baseline: PortableDraftBaseline, draft: DraftState, ending: string, patches: SourcePatch[]) {
  if (baseline.code === draft.code) return
  const original = sourceText(baseline.code, ending)
  const codeCell = parseLosslessPortableSource(source).semanticNodes.find((node) => node.kind === 'code-cell' && node.raw.includes(original))
  if (!codeCell) return
  const relative = codeCell.raw.indexOf(original)
  patches.push({
    start: codeCell.start + relative,
    end: codeCell.start + relative + original.length,
    replacement: sourceText(draft.code, ending),
  })
}

function hasModeledChanges(draft: DraftState, baseline: PortableDraftBaseline) {
  return baseline.title !== draft.title
    || baseline.abstract !== draft.abstract
    || baseline.introduction !== draft.introduction
    || baseline.methods !== draft.methods
    || baseline.resultsLead !== draft.resultsLead
    || baseline.code !== draft.code
    || baseline.conclusion !== draft.conclusion
    || !sameCitationItems(baseline.citationItems, citationItemsForDraft(draft))
    || baseline.aliceStatus !== draft.aliceStatus
    || baseline.marcusStatus !== draft.marcusStatus
    || baseline.commentResolved !== draft.commentResolved
    || baseline.commentDeleted !== draft.commentDeleted
    || !sameStrings(baseline.commentReplies, draft.commentReplies)
}

export function materializePortableDraftSource(draft: DraftState) {
  const envelope = draft.portableEnvelope
  if (!envelope) return null
  if (!hasModeledChanges(draft, envelope.baseline)) return envelope.source

  const source = envelope.source
  const baseline = envelope.baseline
  const ending = lineEnding(source)
  const sections = sectionRanges(source)
  const findSection = (key: SectionRange['key']) => sections.find((section) => section.key === key)
  const patches: SourcePatch[] = []

  patchTitle(source, baseline, draft, patches)
  patchExactField(source, findSection('abstract'), baseline.abstract, draft.abstract, ending, patches)
  patchExactField(source, findSection('introduction'), baseline.introduction, draft.introduction, ending, patches)
  patchExactField(source, findSection('methods'), baseline.methods, draft.methods, ending, patches)
  patchExactField(source, findSection('results'), baseline.resultsLead, draft.resultsLead, ending, patches)
  patchExactField(source, findSection('conclusion'), baseline.conclusion, draft.conclusion, ending, patches)
  patchCitationCluster(source, findSection('introduction'), baseline, draft, patches)
  patchCode(source, baseline, draft, ending, patches)

  let materialized = applyPatches(source, patches)
  let review = parseReviewMarkup(materialized)
  const baselineCommentStatus = baseline.commentDeleted ? 'deleted' : baseline.commentResolved ? 'resolved' : 'open'
  const draftCommentStatus = draft.commentDeleted ? 'deleted' : draft.commentResolved ? 'resolved' : 'open'
  const statusUpdates: [string, string, string][] = [
    ['dm-c01', baseline.aliceStatus, draft.aliceStatus],
    ['dm-c02', baseline.marcusStatus, draft.marcusStatus],
    ['dm-comment-01', baselineCommentStatus, draftCommentStatus],
  ]
  for (const [recordId, previous, next] of statusUpdates) {
    if (previous === next) continue
    if ([...review.changes, ...review.threads].some((record) => record.id === recordId)) review = updateReviewRecordStatus(review, recordId, next)
  }
  if (!sameStrings(baseline.commentReplies, draft.commentReplies)) {
    const thread = review.threads.find((candidate) => candidate.id === 'dm-comment-01')
    if (thread?.messages[0]) review = updateReviewThreadMessages(review, thread.id, [thread.messages[0], ...draft.commentReplies])
  }
  materialized = serializeReviewMarkup(review)
  return materialized
}
