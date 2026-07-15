export type MarkupView = 'simple' | 'all' | 'original' | 'final'
export type SuggestionStatus = 'open' | 'accepted' | 'rejected' | 'needs-rebase'
export type SectionKey = 'frontmatter' | 'abstract' | 'introduction' | 'methods' | 'results' | 'conclusion'

export interface PreservedSection {
  after: SectionKey
  markdown: string
}

export interface PortableDraftBaseline {
  title: string
  abstract: string
  introduction: string
  methods: string
  resultsLead: string
  code: string
  conclusion: string
  citationKeys: string[]
  citationItems: CitationItem[]
  aliceStatus: SuggestionStatus
  marcusStatus: SuggestionStatus
  commentResolved: boolean
  commentReplies: string[]
}

export interface PortableDraftEnvelope {
  source: string
  baseline: PortableDraftBaseline
}

export interface DraftState {
  title: string
  abstract: string
  introduction: string
  methods: string
  resultsLead: string
  code: string
  conclusion: string
  citationInserted: boolean
  citationKeys: string[]
  citationItems: CitationItem[]
  activeProposal: 'alice' | 'marcus'
  aliceStatus: SuggestionStatus
  marcusStatus: SuggestionStatus
  commentResolved: boolean
  commentReplies: string[]
  cellStatus: 'current' | 'stale' | 'running'
  lastSavedAt: string
  frontmatterSource?: string
  preservedSections?: PreservedSection[]
  portableEnvelope?: PortableDraftEnvelope
}

export interface CitationItem {
  citekey: string
  prefix?: string
  suffix?: string
  locator?: string
  suppressAuthor?: boolean
}

export interface CitationRecord {
  citekey: string
  type: string
  title: string
  authors: string[]
  year?: string
  container?: string
  doi?: string
  url?: string
  cslData?: Record<string, unknown>
  source: 'bibtex' | 'csl-json' | 'ris' | 'endnote' | 'zotero' | 'sample'
  availability?: 'live' | 'cached'
  provenance?: {
    origin: 'project-file' | 'manual-import' | 'zotero-local' | 'sample'
    locator?: string
  }
  sourceIdentity?: {
    provider: 'zotero'
    itemKey: string
    itemVersion: number
    libraryVersion?: string
  }
}

export interface BibliographyResult {
  records: CitationRecord[]
  diagnostics: DocumentDiagnostic[]
}

export interface DocumentDiagnostic {
  code: string
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface ParsedPortableDocument {
  draft: DraftState
  diagnostics: DocumentDiagnostic[]
  sourceHash: string
}
