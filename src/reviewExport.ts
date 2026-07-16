import { buildReviewConflictGraph } from './reviewConflicts'
import { parseReviewMarkup, type ReviewMarkupDocument } from './reviewMarkup'
import { projectPortableReviewSource, type ReviewProjectionResult } from './reviewProjector'
import type { DocumentDiagnostic } from './types'

export interface ReviewExportBundle {
  original: string
  final?: string
  report: string
  finalProjection: ReviewProjectionResult
  diagnostics: DocumentDiagnostic[]
}

function safeText(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function quoted(value: string) {
  return value.split(/\r\n|\n|\r/).map((line) => `> ${safeText(line)}`).join('\n')
}

function activity(createdAt?: string, updatedAt?: string) {
  const values = [
    ...(createdAt ? [`Created: ${safeText(createdAt)}`] : []),
    ...(updatedAt ? [`Updated: ${safeText(updatedAt)}`] : []),
  ]
  return values.length ? values.join(' · ') : undefined
}

function summary(document: ReviewMarkupDocument) {
  const openChanges = document.changes.filter((change) => change.status === 'open').length
  const openThreads = document.threads.filter((thread) => thread.status === 'open').length
  const completeAnchors = new Set(document.ranges.filter((range) => range.complete).map((range) => range.anchorId))
  const unresolvedLocations = new Set([...document.changes, ...document.threads]
    .filter((record) => record.status !== 'deleted' && !completeAnchors.has(record.anchorId))
    .map((record) => record.anchorId)).size
  return [
    `- ${document.changes.length} suggestion${document.changes.length === 1 ? '' : 's'} (${openChanges} open)`,
    `- ${document.threads.length} comment thread${document.threads.length === 1 ? '' : 's'} (${openThreads} open)`,
    `- ${document.decisions.length} recorded decision${document.decisions.length === 1 ? '' : 's'}`,
    `- ${unresolvedLocations} unplaced review location${unresolvedLocations === 1 ? '' : 's'}`,
  ]
}

export function renderReviewReport(source: string) {
  const document = parseReviewMarkup(source)
  const authors = new Map(document.authors.map((author) => [author.id, author.name]))
  const conflicts = buildReviewConflictGraph(document).components.filter((component) => component.changeIds.length > 1)
  const lines = [
    '# DraftMatter review report',
    '',
    'This report is separate from the clean publication source.',
    '',
    '## Summary',
    '',
    ...summary(document),
    '',
  ]

  if (conflicts.length > 0) {
    lines.push('## Conflicting alternatives', '')
    for (const conflict of conflicts) {
      lines.push(`- ${conflict.changeIds.join(', ')} — ${conflict.relations.join(', ')}`, '')
    }
  }

  if (document.changes.length > 0) {
    lines.push('## Suggestions', '')
    for (const change of document.changes) {
      lines.push(
        `### ${change.id} — ${safeText(authors.get(change.authorId) ?? change.authorId)}`,
        '',
        `Status: ${safeText(change.status)} · Kind: ${safeText(change.changeKind)} · Anchor: ${safeText(change.anchorId)}`,
        '',
      )
      const changeActivity = activity(change.createdAt, change.updatedAt)
      if (changeActivity) lines.push(changeActivity, '')
      if (change.proposal !== undefined) lines.push('Proposed content:', '', quoted(change.proposal), '')
      if (change.rationale) lines.push('Rationale:', '', quoted(change.rationale), '')
    }
  }

  if (document.threads.length > 0) {
    lines.push('## Comment threads', '')
    for (const thread of document.threads) {
      lines.push(
        `### ${thread.id} — ${safeText(authors.get(thread.authorId) ?? thread.authorId)}`,
        '',
        `Status: ${safeText(thread.status)} · Anchor: ${safeText(thread.anchorId)}`,
        '',
      )
      const threadActivity = activity(thread.createdAt, thread.updatedAt)
      if (threadActivity) lines.push(threadActivity, '')
      for (const [index, message] of thread.messageRecords.entries()) {
        const messageAuthor = message.authorId ? authors.get(message.authorId) ?? message.authorId : thread.authorId
        lines.push(`Message ${index + 1} — ${safeText(messageAuthor)}${message.timestamp ? ` · ${safeText(message.timestamp)}` : ''}`, '', quoted(message.content), '')
      }
    }
  }

  if (document.decisions.length > 0) {
    lines.push('## Decision log', '')
    for (const decision of document.decisions) {
      lines.push(`- ${decision.changeId}: ${safeText(decision.action)} by ${safeText(authors.get(decision.authorId) ?? decision.authorId)}${decision.timestamp ? ` at ${safeText(decision.timestamp)}` : ''}`)
    }
    lines.push('')
  }

  const errors = document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')
  if (errors.length > 0) {
    lines.push('## Placement and integrity issues', '', ...errors.map((diagnostic) => `- ${safeText(diagnostic.message)}`), '')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

export function buildReviewExportBundle(source: string, selectedChangeIds: string[] = []): ReviewExportBundle {
  const original = projectPortableReviewSource(source, { view: 'original' })
  if (!original.ok) throw new Error('Original review projection unexpectedly failed.')
  const finalProjection = projectPortableReviewSource(source, { view: 'final', selectedChangeIds })
  return {
    original: original.source,
    ...(finalProjection.ok ? { final: finalProjection.source } : {}),
    report: renderReviewReport(source),
    finalProjection,
    diagnostics: [...original.diagnostics, ...finalProjection.diagnostics],
  }
}
