import type {
  DocumentDiagnostic,
  DraftState,
  ParsedPortableDocument,
  PreservedSection,
  SectionKey,
  SuggestionStatus,
} from './types'
import { citationKeys, parseCitationCluster } from './citation'
import { extractExecutableCells } from './executionCells'
import { parseReviewMarkup } from './reviewMarkup'

const KNOWN_SECTIONS: Record<string, Exclude<SectionKey, 'frontmatter'>> = {
  abstract: 'abstract',
  introduction: 'introduction',
  methods: 'methods',
  results: 'results',
  conclusion: 'conclusion',
}

interface SourceSection {
  key?: Exclude<SectionKey, 'frontmatter'>
  heading: string
  markdown: string
  content: string
}

export function sourceHash(source: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function parseFrontmatter(source: string, diagnostics: DocumentDiagnostic[]) {
  if (!source.startsWith('---\n')) {
    diagnostics.push({ code: 'frontmatter-missing', level: 'warning', message: 'No YAML front matter was found; project defaults will be used.' })
    return { frontmatter: undefined, body: source }
  }

  const closing = source.indexOf('\n---', 4)
  if (closing < 0) {
    diagnostics.push({ code: 'frontmatter-unclosed', level: 'error', message: 'The YAML front matter is not closed.' })
    return { frontmatter: undefined, body: source }
  }

  const closingEnd = source.indexOf('\n', closing + 4)
  const end = closingEnd < 0 ? source.length : closingEnd + 1
  return { frontmatter: source.slice(0, closing + 4), body: source.slice(end) }
}

function normalizeHeading(heading: string) {
  return heading.trim().replace(/^\d+(?:\.\d+)*[.)]?\s+/, '').toLowerCase()
}

function splitSections(body: string) {
  const matches = [...body.matchAll(/^##[ \t]+(.+?)\s*$/gm)]
  return matches.map<SourceSection>((match, index) => {
    const start = match.index ?? 0
    const end = matches[index + 1]?.index ?? body.length
    const headingLineEnd = body.indexOf('\n', start)
    const contentStart = headingLineEnd < 0 ? end : headingLineEnd + 1
    const normalized = normalizeHeading(match[1])
    return {
      key: KNOWN_SECTIONS[normalized],
      heading: match[1],
      markdown: body.slice(start, end).trim(),
      content: body.slice(contentStart, end).trim(),
    }
  })
}

function parseTitle(frontmatter: string | undefined, fallback: string) {
  const value = frontmatter?.match(/^title\s*:\s*(.+)$/m)?.[1]?.trim()
  if (!value) return fallback
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replaceAll('\\"', '"')
  }
  return value
}

function parseStatus(review: string, id: string, fallback: SuggestionStatus): SuggestionStatus {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const value = review.match(new RegExp(`\\{#${escaped}[^\\n]*data-status="([^"]+)"`))?.[1]
  return value === 'open' || value === 'accepted' || value === 'rejected' || value === 'needs-rebase' ? value : fallback
}

function cleanCitation(section: string) {
  const citationGroups = [...section.matchAll(/\[([^\]]*@[a-zA-Z0-9_:.+-]+[^\]]*)\]/g)]
  const citationItems = citationGroups.flatMap((match) => parseCitationCluster(match[0]))
  const keys = citationKeys(citationItems)
  const citationInserted = keys.length > 1
  const introduction = section.replace(/\s+\[(?:[^\]]*@[a-zA-Z0-9_:.+-]+[^\]]*)\]\s*$/, '').trim()
  return { introduction, citationInserted, citationKeys: keys, citationItems }
}

function parseMethods(section: string, fallback: DraftState, diagnostics: DocumentDiagnostic[]) {
  const withoutOutputs = section.replace(/<!-- dm-output:start[^>]*-->[\s\S]*?<!-- dm-output:end -->/g, '').trim()
  const executable = extractExecutableCells(withoutOutputs).cells[0]
  if (!executable) {
    diagnostics.push({ code: 'executable-cell-missing', level: 'warning', message: 'No supported executable cell was found; the sample cell remains available.' })
    return { methods: withoutOutputs, code: fallback.code }
  }
  return {
    methods: `${withoutOutputs.slice(0, executable.position.startOffset)}${withoutOutputs.slice(executable.position.endOffset)}`.trim(),
    code: executable.source,
  }
}

function parseResults(section: string, fallback: string) {
  const visible = section.replace(/\[\]\{[^}]*\.dm-anchor[^}]*\}/g, '').trim()
  const index = visible.indexOf('The drought treatment ')
  if (index < 0) return visible.split(/\n\n/)[0]?.trim() || fallback
  return visible.slice(0, index).trim() || fallback
}

function collectPreservedSections(sections: SourceSection[]) {
  const preserved: PreservedSection[] = []
  let lastKnown: SectionKey = 'frontmatter'
  for (const section of sections) {
    if (section.key) lastKnown = section.key
    else preserved.push({ after: lastKnown, markdown: section.markdown })
  }
  return preserved
}

function sectionContent(sections: SourceSection[], key: Exclude<SectionKey, 'frontmatter'>, fallback: string, diagnostics: DocumentDiagnostic[]) {
  const section = sections.find((candidate) => candidate.key === key)
  if (section) return section.content
  diagnostics.push({ code: `section-${key}-missing`, level: 'warning', message: `The ${key} section was not found; existing draft content was retained.` })
  return fallback
}

export function parsePortableDocument(sourceInput: string, fallback: DraftState): ParsedPortableDocument {
  const originalSource = sourceInput
  const source = sourceInput.replaceAll('\r\n', '\n')
  const diagnostics: DocumentDiagnostic[] = []
  const reviewDocument = parseReviewMarkup(source)
  const reviewIndex = reviewDocument.sectionStart ?? -1
  const review = reviewIndex >= 0 ? source.slice(reviewIndex) : ''
  const sourceWithoutReview = reviewIndex >= 0 ? source.slice(0, reviewIndex) : source
  if (!review) diagnostics.push({ code: 'review-data-missing', level: 'info', message: 'This manuscript has no embedded DraftMatter review section.' })
  const execution = extractExecutableCells(sourceWithoutReview)
  diagnostics.push(...execution.diagnostics)

  const { frontmatter, body } = parseFrontmatter(sourceWithoutReview, diagnostics)
  const sections = splitSections(body)
  const intro = cleanCitation(sectionContent(sections, 'introduction', fallback.introduction, diagnostics))
  const methods = parseMethods(sectionContent(sections, 'methods', fallback.methods, diagnostics), fallback, diagnostics)
  const modeledThread = reviewDocument.threads.find((thread) => thread.id === 'dm-comment-01')

  const draft: DraftState = {
    ...fallback,
    title: parseTitle(frontmatter, fallback.title),
    abstract: sectionContent(sections, 'abstract', fallback.abstract, diagnostics),
    introduction: intro.introduction,
    citationInserted: intro.citationInserted,
    citationKeys: intro.citationKeys.length ? intro.citationKeys : fallback.citationKeys,
    citationItems: intro.citationItems.length ? intro.citationItems : fallback.citationItems,
    methods: methods.methods,
    code: methods.code,
    resultsLead: parseResults(sectionContent(sections, 'results', fallback.resultsLead, diagnostics), fallback.resultsLead),
    conclusion: sectionContent(sections, 'conclusion', fallback.conclusion, diagnostics),
    aliceStatus: parseStatus(review, 'dm-c01', fallback.aliceStatus),
    marcusStatus: parseStatus(review, 'dm-c02', fallback.marcusStatus),
    commentResolved: modeledThread?.status === 'resolved',
    commentReplies: modeledThread?.messages.slice(1) ?? [],
    cellStatus: 'stale',
    lastSavedAt: new Date().toISOString(),
    frontmatterSource: frontmatter,
    preservedSections: collectPreservedSections(sections),
  }

  draft.portableEnvelope = {
    source: originalSource,
    baseline: {
      title: draft.title,
      abstract: draft.abstract,
      introduction: draft.introduction,
      methods: draft.methods,
      resultsLead: draft.resultsLead,
      code: draft.code,
      conclusion: draft.conclusion,
      citationKeys: [...draft.citationKeys],
      citationItems: structuredClone(draft.citationItems),
      aliceStatus: draft.aliceStatus,
      marcusStatus: draft.marcusStatus,
      commentResolved: draft.commentResolved,
      commentReplies: [...draft.commentReplies],
    },
  }

  const preservedCount = draft.preservedSections?.length ?? 0
  if (preservedCount) diagnostics.push({ code: 'sections-preserved', level: 'info', message: `${preservedCount} unsupported section${preservedCount === 1 ? '' : 's'} will be preserved in portable exports.` })

  return { draft, diagnostics, sourceHash: sourceHash(originalSource), executableCells: execution.cells }
}

export function validateCleanProjection(source: string): DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = []
  if (source.includes('.dm-anchor')) diagnostics.push({ code: 'clean-anchor-leak', level: 'error', message: 'A DraftMatter anchor leaked into the clean projection.' })
  if (source.includes('.draftmatter-reviews')) diagnostics.push({ code: 'clean-review-leak', level: 'error', message: 'The review data section leaked into the clean projection.' })
  for (const heading of ['Abstract', 'Introduction', 'Methods', 'Results', 'Conclusion']) {
    if (!source.includes(`## ${heading}`)) diagnostics.push({ code: `clean-${heading.toLowerCase()}-missing`, level: 'error', message: `The clean projection is missing its ${heading} section.` })
  }
  return diagnostics
}
