import type { DraftState } from './types'

export const initialDraft: DraftState = {
  title: 'Drought acclimation reshapes canopy development',
  abstract:
    'Plant responses to intermittent drought emerge from coordinated changes in canopy development and carbon allocation. We combined repeated imaging with a process-based analysis to test how young plants adjust growth across contrasting water regimes.',
  introduction:
    'Plant architecture mediates the exchange of light, water, and carbon between an organism and its environment. Yet the timing of architectural acclimation remains poorly resolved under fluctuating water availability.',
  methods:
    'We grew 48 plants under controlled conditions and assigned them to well-watered or intermittent-drought treatments. Canopy area was measured weekly from calibrated top-view images, and allocation was estimated from destructive harvests at weeks 4, 8, and 12.',
  resultsLead: 'Canopy trajectories diverged after the second dry-down cycle.',
  code: `weeks = [0, 2, 4, 6, 8, 10, 12]\ncontrol = [0, 8, 21, 39, 58, 76, 91]\ndrought = [0, 7, 19, 33, 47, 60, 72]\nplot_response(weeks, control, drought)`,
  conclusion:
    'Architectural acclimation was detectable before final biomass differences emerged. Linking repeated phenotyping with explicit provenance makes this response easier to inspect, reproduce, and review.',
  citationInserted: false,
  citationKeys: ['vezy2024'],
  citationItems: [{ citekey: 'vezy2024' }],
  activeProposal: 'alice',
  aliceStatus: 'open',
  marcusStatus: 'open',
  commentResolved: false,
  commentReplies: [],
  cellStatus: 'current',
  lastSavedAt: new Date().toISOString(),
  preservedSections: [],
}
