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
  code: `from pathlib import Path

weeks = [0, 2, 4, 6, 8, 10, 12]
control = [0, 8, 21, 39, 58, 76, 91]
drought = [0, 7, 19, 33, 47, 60, 72]
points = lambda values: " ".join(f"{50 + i * 90},{230 - value * 2}" for i, value in enumerate(values))
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 270">
<rect width="640" height="270" fill="white"/><g fill="none" stroke="#edf1ef">{''.join(f'<path d="M50 {y}H590"/>' for y in (30,80,130,180,230))}</g>
<polyline points="{points(control)}" fill="none" stroke="#426b5b" stroke-width="3"/>
<polyline points="{points(drought)}" fill="none" stroke="#b57557" stroke-width="3"/>
<g font-family="sans-serif" font-size="12" fill="#68736d"><text x="50" y="255">Week 0</text><text x="535" y="255">Week 12</text><text x="390" y="24">Well-watered</text><text x="500" y="24">Drought</text></g></svg>'''
output = Path("figures/generated/fig-canopy.svg")
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(svg, encoding="utf-8")
print(f"Wrote {output}")`,
  conclusion:
    'Architectural acclimation was detectable before final biomass differences emerged. Linking repeated phenotyping with explicit provenance makes this response easier to inspect, reproduce, and review.',
  citationInserted: false,
  citationKeys: ['vezy2024'],
  citationItems: [{ citekey: 'vezy2024' }],
  activeProposal: 'alice',
  aliceStatus: 'open',
  marcusStatus: 'open',
  commentResolved: false,
  commentDeleted: false,
  commentReplies: [],
  commentReplyAuthors: [],
  reviewUpdatedAt: {},
  commentReplyTimestamps: [],
  cellStatus: 'current',
  lastSavedAt: new Date().toISOString(),
}
