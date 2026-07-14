export type MarkupView = 'simple' | 'all' | 'original' | 'final'
export type SuggestionStatus = 'open' | 'accepted' | 'rejected' | 'needs-rebase'

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
}
