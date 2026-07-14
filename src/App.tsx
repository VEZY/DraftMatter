import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { cleanProjection, downloadText, reviewedProjection } from './projections'
import type { DraftState, MarkupView, SuggestionStatus } from './types'

const STORAGE_KEY = 'draftmatter.prototype.v2'

const initialDraft: DraftState = {
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
  activeProposal: 'alice',
  aliceStatus: 'open',
  marcusStatus: 'open',
  commentResolved: false,
  commentReplies: [],
  cellStatus: 'current',
  lastSavedAt: new Date().toISOString(),
}

function getInitialDraft(): DraftState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? { ...initialDraft, ...JSON.parse(saved) } : initialDraft
  } catch {
    return initialDraft
  }
}

function Avatar({ initials, tone = 'sage', small = false }: { initials: string; tone?: 'sage' | 'blue' | 'clay'; small?: boolean }) {
  return <span className={`avatar avatar-${tone} ${small ? 'avatar-small' : ''}`}>{initials}</span>
}

function Editable({
  value,
  onChange,
  as: Element = 'p',
  className = '',
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  as?: 'p' | 'h1'
  className?: string
  ariaLabel: string
}) {
  const elementRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (elementRef.current && elementRef.current.innerText !== value) elementRef.current.innerText = value
  }, [value])

  return (
    <Element
      ref={elementRef as never}
      className={`editable ${className}`}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      aria-label={ariaLabel}
      onBlur={(event) => onChange(event.currentTarget.innerText.trim())}
    >
      {value}
    </Element>
  )
}

function CitationChip({ onClick, expanded = false }: { onClick: () => void; expanded?: boolean }) {
  return (
    <button className="citation-chip" onClick={onClick} aria-label="Open citation details">
      (Vezy et al., 2024{expanded ? '; Martin & Chen, 2023' : ''})
    </button>
  )
}

function StatusPill({ status }: { status: SuggestionStatus }) {
  const label = status === 'needs-rebase' ? 'Needs rebase' : status[0].toUpperCase() + status.slice(1)
  return <span className={`status-pill status-${status}`}>{label}</span>
}

function App() {
  const [draft, setDraft] = useState<DraftState>(getInitialDraft)
  const [markupView, setMarkupView] = useState<MarkupView>('all')
  const [activeNav, setActiveNav] = useState<'manuscript' | 'review' | 'sources' | 'history'>('manuscript')
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [citationOpen, setCitationOpen] = useState(false)
  const [citationSearchOpen, setCitationSearchOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceTab, setSourceTab] = useState<'reviewed' | 'final' | 'original'>('reviewed')
  const [commandOpen, setCommandOpen] = useState(false)
  const [reply, setReply] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [toast, setToast] = useState('')

  const activeStatus = draft.activeProposal === 'alice' ? draft.aliceStatus : draft.marcusStatus
  const activeReplacement = draft.activeProposal === 'alice'
    ? 'reduced leaf area by 18%'
    : 'lowered leaf expansion during the treatment period'

  const updateDraft = (patch: Partial<DraftState>) => {
    setSaveState('saving')
    setDraft((current) => ({ ...current, ...patch }))
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const next = { ...draft, lastSavedAt: new Date().toISOString() }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      setSaveState('saved')
    }, 380)
    return () => window.clearTimeout(timeout)
  }, [draft])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setCitationOpen(false)
        setCitationSearchOpen(false)
        setExportOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const words = useMemo(() => {
    const text = [draft.title, draft.abstract, draft.introduction, draft.methods, draft.resultsLead, draft.conclusion].join(' ')
    return text.trim().split(/\s+/).length
  }, [draft])

  const source = sourceTab === 'reviewed'
    ? reviewedProjection(draft)
    : cleanProjection(draft, sourceTab)

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const runCell = () => {
    updateDraft({ cellStatus: 'running' })
    window.setTimeout(() => {
      updateDraft({ cellStatus: 'current' })
      setToast('Figure regenerated · run 6f42f1a')
    }, 1100)
  }

  const acceptProposal = () => {
    if (draft.activeProposal === 'alice') {
      updateDraft({ aliceStatus: 'accepted', marcusStatus: draft.marcusStatus === 'open' ? 'needs-rebase' : draft.marcusStatus })
    } else {
      updateDraft({ marcusStatus: 'accepted', aliceStatus: draft.aliceStatus === 'open' ? 'needs-rebase' : draft.aliceStatus })
    }
    setToast('Suggestion accepted · intersecting proposal preserved')
  }

  const rejectProposal = () => {
    if (draft.activeProposal === 'alice') updateDraft({ aliceStatus: 'rejected', activeProposal: 'marcus' })
    else updateDraft({ marcusStatus: 'rejected', activeProposal: 'alice' })
    setToast('Suggestion rejected · accepted text unchanged')
  }

  const addReply = () => {
    if (!reply.trim()) return
    updateDraft({ commentReplies: [...draft.commentReplies, reply.trim()] })
    setReply('')
  }

  const download = (kind: 'reviewed' | 'final' | 'original') => {
    const content = kind === 'reviewed' ? reviewedProjection(draft) : cleanProjection(draft, kind)
    downloadText(kind === 'reviewed' ? 'canopy-drought.qmd' : `canopy-drought.${kind}.qmd`, content)
    setExportOpen(false)
    setToast(kind === 'reviewed' ? 'Portable project source exported' : `Clean ${kind} projection exported`)
  }

  const showReviewPanel = () => {
    setActiveNav('review')
    setRightPanelOpen(true)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <button className="icon-button mobile-panel-button" aria-label="Toggle left panel" onClick={() => setLeftPanelOpen((open) => !open)}>
            <Icon name="panelLeft" />
          </button>
          <div className="wordmark" aria-label="DraftMatter home">
            <span className="brand-mark">D</span>
            <span>DraftMatter</span>
          </div>
          <span className="topbar-divider" />
          <button className="project-switcher">
            <span className="project-dot" />
            <span className="project-switcher-name">Canopy drought study</span>
            <Icon name="chevronDown" size={14} />
          </button>
        </div>

        <div className="document-state" aria-live="polite">
          <span className={`save-indicator ${saveState}`} />
          {saveState === 'saving' ? 'Saving locally…' : 'Saved locally'}
        </div>

        <div className="topbar-actions">
          <button className="icon-button command-button" onClick={() => setCommandOpen(true)} aria-label="Open command menu">
            <Icon name="search" />
            <span className="shortcut"><Icon name="command" size={12} />K</span>
          </button>
          <span className="topbar-divider" />
          <button className={`review-toggle ${activeNav === 'review' ? 'active' : ''}`} onClick={showReviewPanel}>
            <Icon name="message" size={16} />
            Review
            <span className="count-badge">3</span>
          </button>
          <div className="export-wrap">
            <button className="primary-button" onClick={() => setExportOpen((open) => !open)}>
              <Icon name="download" size={16} />
              Export
              <Icon name="chevronDown" size={13} />
            </button>
            {exportOpen && (
              <div className="popover export-menu">
                <button onClick={() => download('final')}><span><strong>Clean final</strong><small>Resolved manuscript, no review data</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('original')}><span><strong>Clean original</strong><small>Accepted base before open suggestions</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('reviewed')}><span><strong>Portable source</strong><small>QMD with anchors and review records</small></span><Icon name="arrowRight" /></button>
              </div>
            )}
          </div>
          <Avatar initials="RV" />
          <button className="icon-button mobile-panel-button" aria-label="Toggle review panel" onClick={() => setRightPanelOpen((open) => !open)}>
            <Icon name="panelRight" />
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="app-rail" aria-label="Workspace navigation">
          <div className="rail-items">
            <button className={activeNav === 'manuscript' ? 'active' : ''} onClick={() => setActiveNav('manuscript')} data-label="Manuscript"><Icon name="document" /></button>
            <button className={activeNav === 'review' ? 'active' : ''} onClick={showReviewPanel} data-label="Review"><Icon name="message" /><span className="rail-notice">3</span></button>
            <button className={activeNav === 'sources' ? 'active' : ''} onClick={() => setActiveNav('sources')} data-label="Sources"><Icon name="book" /></button>
            <button className={activeNav === 'history' ? 'active' : ''} onClick={() => setActiveNav('history')} data-label="History"><Icon name="history" /></button>
          </div>
          <button data-label="Settings"><Icon name="settings" /></button>
        </nav>

        {leftPanelOpen && (
          <aside className="left-panel">
            <div className="panel-heading-row">
              <div>
                <span className="eyebrow">Manuscript</span>
                <h2>Outline</h2>
              </div>
              <button className="icon-button subtle"><Icon name="more" /></button>
            </div>

            <div className="outline-tree">
              <button className="outline-title active" onClick={() => scrollTo('title')}>{draft.title}</button>
              <button onClick={() => scrollTo('abstract')}><span>Abstract</span><small>112</small></button>
              <button onClick={() => scrollTo('introduction')}><span>Introduction</span><small>146</small></button>
              <button onClick={() => scrollTo('methods')}><span>Methods</span><small>185</small></button>
              <button className="outline-nested" onClick={() => scrollTo('code-cell')}><span>Canopy response</span><small>Fig. 1</small></button>
              <button onClick={() => scrollTo('results')}><span>Results</span><small>164</small></button>
              <button onClick={() => scrollTo('conclusion')}><span>Conclusion</span><small>88</small></button>
              <button className="add-section"><Icon name="plus" size={15} /> Add section</button>
            </div>

            <div className="left-panel-spacer" />

            <div className="project-health">
              <div className="project-health-title"><Icon name="spark" size={16} /> Project health</div>
              <div><span><i className="health-dot okay" /> Citations</span><small>12 linked</small></div>
              <div><span><i className="health-dot warning" /> Figures</span><small>1 stale</small></div>
              <div><span><i className="health-dot okay" /> Git</span><small>2 changes</small></div>
            </div>

            <div className="panel-footer">
              <span>{words} words</span>
              <button onClick={() => setSourceOpen(true)}><Icon name="code" size={15} /> View source</button>
            </div>
          </aside>
        )}

        <main className="editor-area">
          <div className="format-toolbar" aria-label="Formatting toolbar">
            <button className="style-select">Body text <Icon name="chevronDown" size={13} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Bold"><strong>B</strong></button>
            <button aria-label="Italic"><em>I</em></button>
            <button aria-label="Add link"><Icon name="link" size={16} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Block quote"><Icon name="quote" size={17} /></button>
            <button aria-label="Insert image"><Icon name="image" size={17} /></button>
            <button aria-label="Insert table"><Icon name="table" size={17} /></button>
            <button aria-label="Insert code cell"><Icon name="code" size={17} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Undo"><Icon name="undo" size={16} /></button>
            <button aria-label="Redo" disabled><Icon name="redo" size={16} /></button>
          </div>

          <article className="manuscript" aria-label="Editable manuscript">
            <div className="paper-meta">RESEARCH ARTICLE · PLANT ECOLOGY</div>
            <Editable as="h1" value={draft.title} onChange={(title) => updateDraft({ title })} ariaLabel="Manuscript title" className="paper-title" />
            <div className="authors">
              <span><Avatar initials="RV" tone="sage" small /> Remi Vezy<sup>1</sup></span>
              <span><Avatar initials="AM" tone="blue" small /> Alice Martin<sup>2</sup></span>
              <button><Icon name="plus" size={13} /> Add author</button>
            </div>
            <div className="affiliations"><sup>1</sup> CIRAD, UMR AMAP, Montpellier, France · <sup>2</sup> Wageningen University, Netherlands</div>

            <section id="abstract" className="abstract-block">
              <h2>Abstract</h2>
              <Editable value={draft.abstract} onChange={(abstract) => updateDraft({ abstract })} ariaLabel="Abstract" />
              <div className="keywords"><strong>Keywords</strong> drought acclimation · plant architecture · reproducibility · phenotyping</div>
            </section>

            <section id="introduction">
              <h2><span>1</span> Introduction</h2>
              <p className="editable" contentEditable suppressContentEditableWarning spellCheck onBlur={(event) => updateDraft({ introduction: event.currentTarget.innerText.replace(/\s*\(Vezy.*$/, '').trim() })}>
                {draft.introduction}{' '}
                <CitationChip onClick={() => setCitationOpen((open) => !open)} expanded={draft.citationInserted} />
              </p>
              {citationOpen && (
                <div className="citation-detail popover">
                  <div className="citation-detail-top">
                    <span className="source-icon">Z</span>
                    <div><strong>Vezy, R. et al. (2024)</strong><p>Modelling plant architecture across scales</p></div>
                    <button className="icon-button subtle" onClick={() => setCitationOpen(false)}><Icon name="close" size={15} /></button>
                  </div>
                  <dl><div><dt>Journal</dt><dd>in silico Plants</dd></div><div><dt>DOI</dt><dd>10.1093/insilicoplants/diae012</dd></div></dl>
                  <div className="citation-actions"><button>Edit citation</button><button onClick={() => { setCitationSearchOpen(true); setCitationOpen(false) }}>Add another source</button></div>
                </div>
              )}
              <p>
                Reproducible writing environments can shorten the path between an observation, its supporting analysis, and the claim that enters the literature. This manuscript keeps those elements close without exposing the mechanics during ordinary reading.
              </p>
            </section>

            <section id="methods">
              <h2><span>2</span> Methods</h2>
              <Editable value={draft.methods} onChange={(methods) => updateDraft({ methods })} ariaLabel="Methods" />

              <div className={`code-cell ${draft.cellStatus}`} id="code-cell">
                <div className="code-cell-header">
                  <div className="code-cell-label"><span className="python-mark">Py</span><strong>Canopy response over time</strong><span className={`cell-status ${draft.cellStatus}`}><i />{draft.cellStatus === 'running' ? 'Running' : draft.cellStatus === 'stale' ? 'Stale' : 'Current'}</span></div>
                  <div className="code-cell-actions">
                    <button className="run-button" onClick={runCell} disabled={draft.cellStatus === 'running'}><Icon name="play" size={14} /> {draft.cellStatus === 'running' ? 'Running…' : 'Run'}</button>
                    <button className="icon-button subtle"><Icon name="more" /></button>
                  </div>
                </div>
                <div className="code-editor-wrap">
                  <div className="line-numbers">1<br />2<br />3<br />4</div>
                  <textarea
                    aria-label="Python code"
                    value={draft.code}
                    onChange={(event) => updateDraft({ code: event.target.value, cellStatus: 'stale' })}
                    spellCheck={false}
                  />
                </div>
                <figure className="cell-output">
                  <div className={`chart-wrap ${draft.cellStatus === 'running' ? 'loading' : ''}`}>
                    <svg viewBox="0 0 620 250" role="img" aria-label="Line chart comparing control and drought canopy response over twelve weeks">
                      <g className="grid-lines">
                        <path d="M50 30H590M50 80H590M50 130H590M50 180H590M50 230H590" />
                        <path d="M50 30V230M140 30V230M230 30V230M320 30V230M410 30V230M500 30V230M590 30V230" />
                      </g>
                      <g className="axis-labels">
                        <text x="48" y="247">0</text><text x="134" y="247">2</text><text x="224" y="247">4</text><text x="314" y="247">6</text><text x="404" y="247">8</text><text x="492" y="247">10</text><text x="580" y="247">12</text>
                        <text x="10" y="35">100</text><text x="17" y="85">75</text><text x="17" y="135">50</text><text x="17" y="185">25</text><text x="25" y="233">0</text>
                      </g>
                      <path className="chart-line control" d="M50 230L140 214L230 188L320 152L410 114L500 78L590 48" />
                      <path className="chart-line drought" d="M50 230L140 216L230 192L320 164L410 136L500 110L590 86" />
                      <g className="chart-points control-points"><circle cx="50" cy="230" r="3"/><circle cx="140" cy="214" r="3"/><circle cx="230" cy="188" r="3"/><circle cx="320" cy="152" r="3"/><circle cx="410" cy="114" r="3"/><circle cx="500" cy="78" r="3"/><circle cx="590" cy="48" r="3"/></g>
                      <g className="chart-points drought-points"><circle cx="50" cy="230" r="3"/><circle cx="140" cy="216" r="3"/><circle cx="230" cy="192" r="3"/><circle cx="320" cy="164" r="3"/><circle cx="410" cy="136" r="3"/><circle cx="500" cy="110" r="3"/><circle cx="590" cy="86" r="3"/></g>
                    </svg>
                    <div className="chart-legend"><span><i className="legend-control" /> Well-watered</span><span><i className="legend-drought" /> Drought</span></div>
                  </div>
                  <figcaption><strong>Figure 1.</strong> Normalized canopy area across twelve weeks. Shaded uncertainty omitted in this prototype. <button><Icon name="link" size={13} /> fig-canopy-result</button></figcaption>
                </figure>
                <div className="provenance-bar"><span><Icon name="check" size={14} /> Run 6f42f1a · Python 3.12</span><span>1.2 s · figures/generated/fig-canopy.svg</span></div>
              </div>
            </section>

            <section id="results">
              <h2><span>3</span> Results</h2>
              <Editable value={draft.resultsLead} onChange={(resultsLead) => updateDraft({ resultsLead })} ariaLabel="Results lead" />
              <p className={`reviewed-sentence markup-${markupView}`}>
                The drought treatment{' '}
                {markupView === 'original' ? (
                  <span>did not substantially alter leaf expansion</span>
                ) : markupView === 'final' ? (
                  <span>{activeReplacement}</span>
                ) : markupView === 'simple' ? (
                  <span className="simple-change" onClick={showReviewPanel}>{activeReplacement}</span>
                ) : (
                  <>
                    <span className="deletion" onClick={showReviewPanel}>did not substantially alter leaf expansion</span>{' '}
                    <span className="insertion" onClick={showReviewPanel}>{activeReplacement}</span>
                  </>
                )}
                , while root allocation <mark onClick={showReviewPanel}>increased modestly</mark> <button className="citation-inline" onClick={() => setCitationOpen(true)}>(Coutellier et al., 2022)</button>.
                <button className="comment-anchor" onClick={showReviewPanel} aria-label="Open comment">1</button>
              </p>
              <p>
                Treatment effects were consistent across harvest cohorts, although individual trajectories varied during rewatering. The executable figure above remains attached to its code, environment, and generated artifact.
              </p>
            </section>

            <section id="conclusion">
              <h2><span>4</span> Conclusion</h2>
              <Editable value={draft.conclusion} onChange={(conclusion) => updateDraft({ conclusion })} ariaLabel="Conclusion" />
            </section>

            <button className="end-insert" onClick={() => setCommandOpen(true)}><Icon name="plus" size={15} /> Add block or type /</button>
          </article>

          <div className="editor-statusbar">
            <span><Icon name="eye" size={14} /> Page 1 of 3</span>
            <span>{words} words · 4 min read</span>
            <span><Icon name="clock" size={14} /> Autosave on</span>
          </div>
        </main>

        {rightPanelOpen && (
          <aside className="review-panel">
            <div className="review-panel-header">
              <div><span className="eyebrow">Review</span><h2>Open feedback <span>3</span></h2></div>
              <button className="icon-button subtle" onClick={() => setRightPanelOpen(false)}><Icon name="close" /></button>
            </div>

            <div className="markup-view-control">
              <Icon name="eye" size={16} />
              <select value={markupView} onChange={(event) => setMarkupView(event.target.value as MarkupView)} aria-label="Markup view">
                <option value="simple">Simple Markup</option>
                <option value="all">All Markup</option>
                <option value="original">Original</option>
                <option value="final">Final preview</option>
              </select>
              <Icon name="chevronDown" size={13} />
            </div>

            <div className="review-scroll">
              <div className="review-location"><span>RESULTS · PARAGRAPH 1</span><button><Icon name="more" /></button></div>

              <div className="conflict-card">
                <div className="conflict-heading"><Icon name="branch" size={16} /><span>2 overlapping alternatives</span><small>Compare one at a time</small></div>

                <button className={`proposal-option ${draft.activeProposal === 'alice' ? 'selected' : ''}`} onClick={() => updateDraft({ activeProposal: 'alice' })}>
                  <Avatar initials="AM" tone="blue" small />
                  <span className="proposal-author"><strong>Alice Martin</strong><small>12 minutes ago</small></span>
                  <StatusPill status={draft.aliceStatus} />
                  <span className="proposal-copy"><del>did not substantially alter leaf expansion</del><ins>reduced leaf area by 18%</ins></span>
                </button>

                <button className={`proposal-option ${draft.activeProposal === 'marcus' ? 'selected' : ''}`} onClick={() => updateDraft({ activeProposal: 'marcus' })}>
                  <Avatar initials="MC" tone="clay" small />
                  <span className="proposal-author"><strong>Marcus Chen</strong><small>8 minutes ago</small></span>
                  <StatusPill status={draft.marcusStatus} />
                  <span className="proposal-copy"><del>did not substantially alter leaf expansion</del><ins>lowered leaf expansion during the treatment period</ins></span>
                </button>

                <div className="proposal-rationale">
                  “{draft.activeProposal === 'alice' ? 'State the measured effect directly.' : 'Keep the interpretation conservative until the model comparison is final.'}”
                </div>

                {activeStatus === 'open' ? (
                  <div className="review-actions"><button className="accept" onClick={acceptProposal}><Icon name="check" size={15} /> Accept</button><button className="reject" onClick={rejectProposal}><Icon name="x" size={15} /> Reject</button><button className="icon-button"><Icon name="more" /></button></div>
                ) : (
                  <div className="decision-note"><Icon name={activeStatus === 'accepted' ? 'check' : activeStatus === 'rejected' ? 'x' : 'branch'} size={15} /> This proposal is {activeStatus === 'needs-rebase' ? 'preserved and needs rebase' : activeStatus}.</div>
                )}
              </div>

              <div className={`comment-card ${draft.commentResolved ? 'resolved' : ''}`}>
                <div className="comment-author"><Avatar initials="MC" tone="clay" small /><span><strong>Marcus Chen</strong><small>5 minutes ago</small></span><button className="icon-button subtle"><Icon name="more" /></button></div>
                <div className="comment-quote">“increased modestly”</div>
                <p>Can we quantify this increase in the main text? The estimate is already in the supplement.</p>
                {draft.commentReplies.map((message, index) => <div className="reply-message" key={`${message}-${index}`}><Avatar initials="RV" tone="sage" small /><p><strong>You</strong>{message}</p></div>)}
                {!draft.commentResolved && (
                  <div className="reply-box"><input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addReply() }} placeholder="Reply…" aria-label="Reply to comment" /><button onClick={addReply} disabled={!reply.trim()}><Icon name="arrowRight" size={15} /></button></div>
                )}
                <button className="resolve-button" onClick={() => updateDraft({ commentResolved: !draft.commentResolved })}><Icon name="check" size={14} /> {draft.commentResolved ? 'Reopen thread' : 'Resolve thread'}</button>
              </div>
            </div>

            <div className="review-panel-footer"><button><Icon name="message" size={15} /> New comment</button><span>1 of 3</span><button>↑</button><button>↓</button></div>
          </aside>
        )}
      </div>

      {citationSearchOpen && (
        <div className="modal-backdrop" onMouseDown={() => setCitationSearchOpen(false)}>
          <div className="citation-picker" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Insert citation">
            <div className="picker-search"><Icon name="search" /><input autoFocus placeholder="Search Zotero and references.bib…" /><kbd>esc</kbd></div>
            <div className="picker-body">
              <div className="picker-filter"><span>Suggested sources</span><button>All libraries <Icon name="chevronDown" size={13} /></button></div>
              <button className="source-result selected" onClick={() => { updateDraft({ citationInserted: true }); setCitationSearchOpen(false); setToast('Citation inserted and linked') }}>
                <span className="source-icon">Z</span><span><strong>Growth coordination under fluctuating water availability</strong><small>Martin, A. & Chen, M. · 2023 · New Phytologist</small><em>10.1111/nph.19208</em></span><Icon name="plus" />
              </button>
              <button className="source-result"><span className="source-icon bib">B</span><span><strong>Plant modelling as a reproducible research practice</strong><small>Vezy, R. et al. · 2024 · in silico Plants</small><em>references.bib</em></span><Icon name="plus" /></button>
              <button className="source-result"><span className="source-icon">Z</span><span><strong>Architectural plasticity mediates drought response</strong><small>Coutellier, L. et al. · 2022 · Plant Methods</small><em>10.1186/s13007-022-00891-3</em></span><Icon name="plus" /></button>
            </div>
            <div className="picker-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Add citation</span></div>
          </div>
        </div>
      )}

      {sourceOpen && (
        <div className="source-drawer-backdrop" onMouseDown={() => setSourceOpen(false)}>
          <div className="source-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <div className="source-drawer-head"><div><span className="eyebrow">Portable source</span><h2>Projection inspector</h2></div><button className="icon-button" onClick={() => setSourceOpen(false)}><Icon name="close" /></button></div>
            <div className="source-tabs">
              <button className={sourceTab === 'reviewed' ? 'active' : ''} onClick={() => setSourceTab('reviewed')}>Reviewed .qmd</button>
              <button className={sourceTab === 'final' ? 'active' : ''} onClick={() => setSourceTab('final')}>Clean final</button>
              <button className={sourceTab === 'original' ? 'active' : ''} onClick={() => setSourceTab('original')}>Original</button>
            </div>
            <div className="projection-note">
              <Icon name={sourceTab === 'reviewed' ? 'branch' : 'check'} size={16} />
              {sourceTab === 'reviewed' ? 'Portable source includes stable anchors and review records.' : 'Clean projection contains no DraftMatter review structures.'}
            </div>
            <pre>{source}</pre>
            <div className="source-drawer-footer"><span>{source.split('\n').length} lines · UTF-8</span><button onClick={() => download(sourceTab)}><Icon name="download" size={15} /> Download projection</button></div>
          </div>
        </div>
      )}

      {commandOpen && (
        <div className="modal-backdrop command-backdrop" onMouseDown={() => setCommandOpen(false)}>
          <div className="command-menu" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command menu">
            <div className="picker-search"><Icon name="search" /><input autoFocus placeholder="Search commands…" /><kbd>esc</kbd></div>
            <span className="command-group-title">Suggested</span>
            <button onClick={() => { setCommandOpen(false); setCitationSearchOpen(true) }}><span className="command-icon">@</span><span><strong>Insert citation</strong><small>Search Zotero and project bibliography</small></span><kbd>⌘ ⇧ C</kbd></button>
            <button onClick={() => { setCommandOpen(false); showReviewPanel() }}><span className="command-icon"><Icon name="message" size={17} /></span><span><strong>Add comment</strong><small>Attach a note to selected text</small></span></button>
            <button onClick={() => { setCommandOpen(false); runCell() }}><span className="command-icon"><Icon name="play" size={17} /></span><span><strong>Run code cell</strong><small>Execute the current cell explicitly</small></span><kbd>⌘ ↵</kbd></button>
            <button onClick={() => { setCommandOpen(false); setSourceOpen(true) }}><span className="command-icon"><Icon name="code" size={17} /></span><span><strong>Inspect portable source</strong><small>Compare reviewed and clean projections</small></span></button>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status"><Icon name="check" size={16} /> {toast}</div>}

      {!citationSearchOpen && !commandOpen && (
        <button className="quick-cite" onClick={() => setCitationSearchOpen(true)} aria-label="Insert citation"><span>@</span> Cite</button>
      )}
    </div>
  )
}

export default App
