import { useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'

export type HomeShowcaseFeatureId = 'writing' | 'results' | 'citations' | 'review' | 'checks'
type HomeDemoSource = 'figure' | 'table'

export const homeShowcaseFeatures: ReadonlyArray<{
  id: HomeShowcaseFeatureId
  label: string
  description: string
}> = [
  {
    id: 'writing',
    label: 'Writing',
    description: 'Write in a calm, structured editor where the manuscript stays central.',
  },
  {
    id: 'results',
    label: 'Results from code',
    description: 'Create figures, tables, and in-text values from R, Python, or Julia. DraftMatter keeps the source linked to the result and keeps code out of the final paper.',
  },
  {
    id: 'citations',
    label: 'Citations',
    description: 'Search, insert, and format citations without leaving the manuscript.',
  },
  {
    id: 'review',
    label: 'Review and collaboration',
    description: 'Comment, suggest changes, and work with co-authors in the context of the paper.',
  },
  {
    id: 'checks',
    label: 'Checks and export',
    description: 'Review citation, computation, output, and export issues before sharing the paper.',
  },
]

function featureState(active: HomeShowcaseFeatureId, features: HomeShowcaseFeatureId) {
  return active === features ? 'is-preview-active' : 'is-preview-muted'
}

const figureSource = [
  'summary = observations.groupby(["week", "treatment"], as_index=False).agg(',
  '    canopy_cover=("canopy_cover", "mean"),',
  ')',
  'figure, ax = plt.subplots()',
  'for treatment, values in summary.groupby("treatment"):',
  '    ax.plot(values["week"], values["canopy_cover"], marker="o", label=treatment)',
  'ax.set(xlabel="Weeks after rainfall", ylabel="Canopy cover (%)")',
]

const tableSource = [
  'recovery_table = observations.groupby("treatment").agg(',
  '    change=("change", "mean"),',
  '    lower_ci=("lower_ci", "mean"),',
  '    upper_ci=("upper_ci", "mean"),',
  ').reset_index()',
]

const homeDemoOutlineSections: Record<
  HomeShowcaseFeatureId,
  'Introduction' | 'Results' | 'Discussion' | 'References' | null
> = {
  writing: 'Introduction',
  results: 'Results',
  citations: 'References',
  review: 'Discussion',
  checks: null,
}

function DemoSourcePanel({
  id,
  label,
  lines,
}: {
  id: string
  label: string
  lines: string[]
}) {
  return (
    <div id={id} className="home-demo-source-panel">
      <div className="home-demo-source-heading">
        <span>PY</span>
        <div>
          <strong>Python source</strong>
          <small>Source stays outside the manuscript · {lines.length} lines</small>
        </div>
      </div>
      <ol aria-label={label}>
        {lines.map((line, index) => <li key={`${index}:${line}`}><code>{line || ' '}</code></li>)}
      </ol>
    </div>
  )
}

export function HomeShowcase() {
  const [activeFeature, setActiveFeature] = useState<HomeShowcaseFeatureId>('writing')
  const [openSource, setOpenSource] = useState<HomeDemoSource | null>(null)
  const [citationDetailsOpen, setCitationDetailsOpen] = useState(false)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = homeShowcaseFeatures.find((feature) => feature.id === activeFeature) ?? homeShowcaseFeatures[0]
  const outlineSection = homeDemoOutlineSections[activeFeature]

  const selectTab = (index: number, focus = false) => {
    const next = homeShowcaseFeatures[index]
    if (!next) return
    setActiveFeature(next.id)
    if (next.id !== 'results') setOpenSource(null)
    if (next.id !== 'citations') setCitationDetailsOpen(false)
    if (focus) tabs.current[index]?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % homeShowcaseFeatures.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + homeShowcaseFeatures.length) % homeShowcaseFeatures.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = homeShowcaseFeatures.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    selectTab(nextIndex, true)
  }

  return (
    <section id="home-showcase" className="home-showcase" aria-labelledby="home-showcase-title">
      <div className="home-section-intro home-showcase-intro">
        <span className="home-kicker">A guided product preview</span>
        <h2 id="home-showcase-title">Stay in the flow</h2>
        <p>Write, compute, cite, and review in one focused workspace.</p>
      </div>

      <div className="home-showcase-layout">
        <div className="home-showcase-guide">
          <div className="home-showcase-tabs" role="tablist" aria-label="DraftMatter workspace features">
            {homeShowcaseFeatures.map((feature, index) => (
              <button
                ref={(element) => { tabs.current[index] = element }}
                key={feature.id}
                id={`home-showcase-tab-${feature.id}`}
                type="button"
                role="tab"
                aria-selected={activeFeature === feature.id}
                aria-controls="home-showcase-panel"
                tabIndex={activeFeature === feature.id ? 0 : -1}
                onClick={() => selectTab(index)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                <span>{index + 1}</span>
                <strong>{feature.label}</strong>
                <Icon name="arrowRight" size={15} />
              </button>
            ))}
          </div>
          <div
            id="home-showcase-panel"
            className="home-showcase-description"
            role="tabpanel"
            aria-labelledby={`home-showcase-tab-${activeFeature}`}
            tabIndex={0}
          >
            <strong>{selected.label}</strong>
            <p>{selected.description}</p>
            {activeFeature === 'results' && (
              <span className="home-showcase-tip">
                <Icon name="code" size={13} />
                Try “View source” on the figure or table.
              </span>
            )}
            {activeFeature === 'citations' && (
              <span className="home-showcase-tip">
                <Icon name="book" size={13} />
                Hover over or focus the citation to inspect its reference. The References section updates automatically.
              </span>
            )}
          </div>
        </div>

        <div
          className="home-workspace-demo"
          data-active-feature={activeFeature}
          aria-label="DraftMatter workspace product demonstration"
        >
          <div className="home-demo-label">
            <Icon name="eye" size={13} />
            Guided preview
          </div>
          <div className="home-demo-topbar">
            <div className="home-demo-project">
              <img src="/draftmatter-pencil-mark.svg" alt="" />
              <span><strong>Canopy recovery study</strong><small>All changes saved</small></span>
            </div>
            <div className={`home-demo-presence ${featureState(activeFeature, 'review')}`} data-preview-feature="review">
              <span aria-label="Amira is viewing">AM</span>
              <span aria-label="Jon is viewing">JL</span>
              <small>2 here</small>
            </div>
            <div className={`home-demo-check-summary ${featureState(activeFeature, 'checks')}`} data-preview-feature="checks">
              <Icon name="check" size={13} />
              <span><strong>Checks</strong><small>1 issue</small></span>
            </div>
            <span className={`home-demo-export ${featureState(activeFeature, 'checks')}`} data-preview-feature="checks">
              <Icon name="download" size={13} />Export
            </span>
          </div>

          <div className="home-demo-body">
            <aside className="home-demo-outline" aria-label="Manuscript outline">
              <span>Manuscript</span>
              <ol>
                <li><small>01</small>Abstract</li>
                <li className={outlineSection === 'Introduction' ? 'is-current' : undefined}><small>02</small>Introduction</li>
                <li><small>03</small>Methods</li>
                <li className={outlineSection === 'Results' ? 'is-current' : undefined}><small>04</small>Results</li>
                <li className={outlineSection === 'Discussion' ? 'is-current' : undefined}><small>05</small>Discussion</li>
                <li className={outlineSection === 'References' ? 'is-current' : undefined}><small>06</small>References</li>
              </ol>
            </aside>

            <article className="home-demo-paper" aria-label="Fictional manuscript preview" aria-live="polite">
              <div key={activeFeature} className="home-demo-paper-view" data-document-view={activeFeature}>
                {activeFeature === 'writing' && (
                  <>
                    <header className="is-preview-active" data-preview-feature="writing">
                      <span>RESEARCH ARTICLE</span>
                      <h3>Canopy recovery after seasonal drought</h3>
                      <div className="home-demo-author-line">
                        <strong>Rémi Vezy<sup>1,2</sup></strong>
                        <span className="home-demo-orcid" aria-label="ORCID 0000-0002-0808-1461">
                          <span aria-hidden="true">iD</span>
                          0000-0002-0808-1461
                        </span>
                      </div>
                      <ol className="home-demo-affiliations" aria-label="Author affiliations">
                        <li><sup>1</sup>CIRAD, UMR AMAP, Montpellier F-34398, France</li>
                        <li><sup>2</sup>AMAP, Univ Montpellier, CIRAD, CNRS, INRAE, IRD, Montpellier, France</li>
                      </ol>
                    </header>
                    <section className="home-demo-abstract is-preview-active" data-preview-feature="writing">
                      <div className="home-demo-section-heading">
                        <small>01</small><h4>Abstract</h4>
                      </div>
                      <p>
                        Seasonal drought can rapidly alter canopy structure, yet the pace of recovery after rainfall remains difficult to compare across treatments. We followed irrigated and control plots for six weeks and linked every reported estimate to a reproducible analysis.
                      </p>
                      <p className="home-demo-keywords"><strong>Keywords</strong> canopy recovery · drought · reproducibility · tropical ecology</p>
                    </section>
                    <section className="home-demo-introduction is-preview-active" data-preview-feature="writing">
                      <div className="home-demo-section-heading">
                        <small>02</small><h4>Introduction</h4>
                      </div>
                      <p>
                        Seasonal drought increasingly shapes the recovery of tropical canopies. Understanding how quickly leaf cover returns can help distinguish short-term stress from lasting structural change.
                      </p>
                      <p>
                        Here, we compare irrigated and control plots during the six weeks after rainfall resumed. We combine field observations with reproducible analyses to keep each reported result connected to its evidence.
                      </p>
                      <p className="home-demo-writing-line">
                        Our objective was to quantify the timing and magnitude of canopy recovery.<span aria-hidden="true" />
                      </p>
                    </section>
                  </>
                )}

                {activeFeature === 'results' && (
                  <section className="is-preview-active" data-preview-feature="results">
                    <div className="home-demo-section-heading">
                      <small>04</small><h4>Results</h4>
                    </div>
                    <p>
                      Canopy cover increased steadily after rainfall returned. Irrigated plots separated from controls during the first three weeks and maintained the larger gain through week six (<span className="home-demo-cross-reference" aria-label="Automatic reference to Figure 1">Figure 1</span>).
                    </p>

                    <figure id="home-demo-figure-1" className="home-demo-figure is-preview-active">
                      <div className="home-demo-result-bar">
                        <span>Reproducible figure</span>
                        <div className="home-demo-result-tools" aria-label="Reproducible figure controls">
                          <span><Icon name="play" size={12} />Run result</span>
                          {openSource === null && <small className="home-demo-source-cue">Try this</small>}
                          <button
                            type="button"
                            className="home-demo-source-toggle"
                            aria-expanded={openSource === 'figure'}
                            aria-controls="home-demo-figure-source"
                            aria-label={`${openSource === 'figure' ? 'Close' : 'View'} source for Figure 1`}
                            onClick={() => setOpenSource((current) => current === 'figure' ? null : 'figure')}
                          >
                            <Icon name="code" size={12} />
                            {openSource === 'figure' ? 'Close source' : 'View source'}
                          </button>
                        </div>
                      </div>
                      {openSource === 'figure' && <DemoSourcePanel id="home-demo-figure-source" label="Python source for Figure 1" lines={figureSource} />}
                      <svg viewBox="0 0 440 160" role="img" aria-labelledby="home-demo-chart-title">
                        <title id="home-demo-chart-title">Canopy recovery over six weeks for control and irrigated plots</title>
                        <g className="home-demo-chart-grid">
                          <path d="M38 20V132H420M38 104H420M38 76H420M38 48H420" />
                        </g>
                        <path className="home-demo-chart-control" d="M40 120 C100 116 120 103 170 96 S260 81 300 72 S370 61 416 57" />
                        <path className="home-demo-chart-treatment" d="M40 118 C80 106 120 83 170 68 S240 42 300 35 S370 26 416 24" />
                        <g className="home-demo-chart-points">
                          <circle cx="40" cy="118" r="3" /><circle cx="170" cy="68" r="3" /><circle cx="300" cy="35" r="3" /><circle cx="416" cy="24" r="3" />
                        </g>
                        <text x="38" y="150">0</text><text x="166" y="150">2</text><text x="296" y="150">4</text><text x="410" y="150">6 weeks</text>
                      </svg>
                      <figcaption><strong>Figure 1.</strong> Canopy recovery after rainfall resumed. Irrigated plots are shown in sage.</figcaption>
                    </figure>

                    <p>
                      At the end of the observation period, irrigated plots reached{' '}
                      <span className="home-demo-computed">
                        18.4%<small>computed</small>
                      </span>
                      {' '}above the dry-season baseline, compared with 8.7% in control plots. Treatment estimates and confidence intervals are summarized in <span className="home-demo-cross-reference" aria-label="Automatic reference to Table 1">Table 1</span>.
                    </p>

                    <div id="home-demo-table-1" className="home-demo-table-wrap is-preview-active">
                      <div className="home-demo-table-title"><strong>Table 1.</strong> Recovery estimates by treatment</div>
                      <div className="home-demo-result-bar">
                        <span>Reproducible table</span>
                        <div className="home-demo-result-tools" aria-label="Reproducible table controls">
                          <span><Icon name="play" size={12} />Run result</span>
                          <button
                            type="button"
                            className="home-demo-source-toggle"
                            aria-expanded={openSource === 'table'}
                            aria-controls="home-demo-table-source"
                            aria-label={`${openSource === 'table' ? 'Close' : 'View'} source for Table 1`}
                            onClick={() => setOpenSource((current) => current === 'table' ? null : 'table')}
                          >
                            <Icon name="code" size={12} />
                            {openSource === 'table' ? 'Close source' : 'View source'}
                          </button>
                        </div>
                      </div>
                      {openSource === 'table' && <DemoSourcePanel id="home-demo-table-source" label="Python source for Table 1" lines={tableSource} />}
                      <table>
                        <thead><tr><th>Treatment</th><th>Change</th><th>95% CI</th></tr></thead>
                        <tbody>
                          <tr><td>Control</td><td>8.7%</td><td>6.1 to 11.2</td></tr>
                          <tr><td>Irrigated</td><td>18.4%</td><td>15.8 to 21.0</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {activeFeature === 'citations' && (
                  <div className="is-preview-active" data-preview-feature="citations">
                    <section>
                      <div className="home-demo-section-heading">
                        <small>04</small><h4>Results</h4>
                      </div>
                      <p>
                        Recovery remained strongest in irrigated plots, consistent with earlier observations{' '}
                        <span className="home-demo-citation-wrap">
                          <button
                            type="button"
                            className="home-demo-citation is-preview-active"
                            aria-label="Reference details for Meyer and Okafor, 2025"
                            aria-expanded={citationDetailsOpen}
                            aria-controls="home-demo-citation-details"
                            onMouseEnter={() => setCitationDetailsOpen(true)}
                            onMouseLeave={() => setCitationDetailsOpen(false)}
                            onFocus={() => setCitationDetailsOpen(true)}
                            onBlur={() => setCitationDetailsOpen(false)}
                            onClick={() => setCitationDetailsOpen(true)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setCitationDetailsOpen(false)
                            }}
                          >
                            (Meyer and Okafor, 2025)
                          </button>
                          {citationDetailsOpen && (
                            <span id="home-demo-citation-details" className="home-demo-citation-card" role="tooltip">
                              <span className="home-demo-citation-card-head">
                                <span>B</span>
                                <span><small>Project bibliography</small><strong>Meyer and Okafor, 2025</strong></span>
                              </span>
                              <strong>Canopy resilience following seasonal drought</strong>
                              <span className="home-demo-citation-authors">Lena Meyer · Chidi Okafor</span>
                              <span className="home-demo-citation-metadata">
                                <span><span>Published</span><span>2025 · Journal of Canopy Ecology</span></span>
                                <span><span>Citekey</span><span><code>@meyer2025</code></span></span>
                              </span>
                            </span>
                          )}
                        </span>.
                      </p>
                    </section>

                    <div className="home-demo-document-jump" aria-label="The manuscript continues to the References section">
                      <span aria-hidden="true" />
                      <span className="home-demo-document-ellipsis" aria-hidden="true">•••</span>
                      <span aria-hidden="true" />
                    </div>

                    <section className="home-demo-references is-preview-active" aria-labelledby="home-demo-references-heading">
                      <div className="home-demo-references-heading">
                        <h4 id="home-demo-references-heading">References</h4>
                        <span><Icon name="check" size={11} />Automatically generated</span>
                      </div>
                      <ol>
                        <li>
                          Meyer, L., &amp; Okafor, C. (2025). Canopy resilience following seasonal drought.{' '}
                          <em>Journal of Canopy Ecology, 18</em>(2), 114–129.
                        </li>
                      </ol>
                    </section>
                  </div>
                )}

                {activeFeature === 'review' && (
                  <section className="is-preview-active" data-preview-feature="review">
                    <div className="home-demo-section-heading">
                      <small>05</small><h4>Discussion</h4>
                    </div>
                    <p>
                      Irrigated plots recovered more quickly after rainfall resumed, while control plots showed a delayed but sustained response.
                    </p>
                    <p className="home-demo-revision">
                      Recovery in control plots was <del>slower</del> <ins>more gradual</ins>, with{' '}
                      <mark>the difference narrowing after week four</mark><sup>1</sup>.
                    </p>
                    <div className="home-demo-review-context">
                      <Icon name="message" size={14} />
                      <span><strong>Comment attached to this sentence</strong><small>Review stays beside the relevant text.</small></span>
                    </div>
                  </section>
                )}

                {activeFeature === 'checks' && (
                  <section className="home-demo-preflight is-preview-active" data-preview-feature="checks">
                    <span className="home-demo-preflight-kicker"><Icon name="check" size={13} />Whole-manuscript review</span>
                    <h3>Ready to export, with one item to review</h3>
                    <p>DraftMatter checks the manuscript, bibliography, computed outputs, and export settings together before a file is created.</p>
                    <div className="home-demo-preflight-summary">
                      <div><strong>6</strong><small>sections</small></div>
                      <div><strong>1</strong><small>citation</small></div>
                      <div><strong>2</strong><small>computed outputs</small></div>
                    </div>
                    <ul>
                      <li><Icon name="check" size={13} /><span><strong>Citations</strong><small>Formatted and included in References</small></span><em>Ready</em></li>
                      <li><Icon name="check" size={13} /><span><strong>Computation</strong><small>Figure and table outputs are current</small></span><em>Ready</em></li>
                      <li className="has-warning"><Icon name="info" size={13} /><span><strong>Export</strong><small>Add a running title for the journal template</small></span><em>Review</em></li>
                    </ul>
                    <div className="home-demo-preflight-formats"><span>PDF</span><span>Word</span><span>HTML</span></div>
                  </section>
                )}
              </div>
            </article>

            <aside className="home-demo-side" aria-label="Review and project status">
              <div className={`home-demo-comment ${featureState(activeFeature, 'review')}`} data-preview-feature="review">
                <span>1</span>
                <div><strong>Sofia Rossi</strong><small>Could we connect this result to Figure 1?</small></div>
              </div>
              <div className={`home-demo-checks ${featureState(activeFeature, 'checks')}`} data-preview-feature="checks">
                <div><Icon name="check" size={14} /><strong>Project checks</strong></div>
                <ul>
                  <li><span />Citations <small>Ready</small></li>
                  <li><span />Computation <small>Current</small></li>
                  <li className="has-warning"><span />Export <small>1 issue</small></li>
                </ul>
                <span className="home-demo-check-action">Review before export</span>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}
