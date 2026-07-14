export type MarkupView = 'simple' | 'all' | 'original' | 'final'
export type SuggestionStatus = 'open' | 'accepted' | 'rejected' | 'needs-rebase'
export type SectionKey = 'frontmatter' | 'abstract' | 'introduction' | 'methods' | 'results' | 'conclusion'

export interface PreservedSection {
  after: SectionKey
  markdown: string
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
  activeProposal: 'alice' | 'marcus'
  aliceStatus: SuggestionStatus
  marcusStatus: SuggestionStatus
  commentResolved: boolean
  commentReplies: string[]
  cellStatus: 'current' | 'stale' | 'running'
  lastSavedAt: string
  frontmatterSource?: string
  preservedSections?: PreservedSection[]
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
  source: 'bibtex' | 'csl-json' | 'sample'
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
