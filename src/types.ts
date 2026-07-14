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
