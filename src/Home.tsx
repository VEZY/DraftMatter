import { useMemo, useState } from 'react'
import { desktopHost } from './desktopHost'
import { Icon } from './Icon'
import {
  useCollaborationSession,
  type CatalogueDraft,
  type CollaborationProjectLaunch,
} from './collaboration/sessionContext'
import type { WorkspaceRole } from './collaboration/workspaceService'
import type { LocalProjectRecent } from './localProjectCatalogue'
import { GettingStarted } from './GettingStarted'

interface HomeProps {
  preferredWorkspaceId?: string
  onOpenDraft: (launch: CollaborationProjectLaunch) => void
  onNewDraft: () => void
  onNewLocalDraft: () => void
  onOpenLocalProject: () => void
  onOpenLocalRecent: (project: LocalProjectRecent) => void
  onForgetLocalRecent: (project: LocalProjectRecent) => void
  onStartLocalCollaboration: (project: LocalProjectRecent) => void
  localProjects: LocalProjectRecent[]
  localProblem?: string
  onOpenExample: () => void
  onOpenLearn: () => void
  onOpenTutorial: () => void
}

function roleLabel(role: WorkspaceRole) {
  return role[0].toUpperCase() + role.slice(1)
}

function createdLabel(createdAt: string) {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return 'Created date unavailable'
  return `Created ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(created)}`
}

function activityLabel(draft: CatalogueDraft) {
  const value = draft.lastActivityAt ?? draft.createdAt
  const activity = new Date(value)
  if (Number.isNaN(activity.getTime())) return createdLabel(draft.createdAt)
  return `Active ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(activity)}`
}

const homeFeatures = [
  {
    icon: 'document',
    title: 'A manuscript, not a notebook',
    detail: 'Write in a calm rendered page with sections, equations, footnotes, figures and tables. DraftMatter keeps the underlying Markdown or Quarto source portable.',
    note: 'Automatic numbering and cross-references',
  },
  {
    icon: 'book',
    title: 'Citations in the flow',
    detail: 'Search the web through Crossref, connect a local Zotero library, or import BibTeX, CSL JSON, RIS and EndNote records without leaving the draft.',
    note: 'Formatted citations and references, automatically',
  },
  {
    icon: 'code',
    title: 'Results that stay reproducible',
    detail: 'Run Python, R and Julia—even in the same document—and publish their figures, tables and named values directly into the paper.',
    note: 'Freshness checks and runtime provenance',
  },
  {
    icon: 'message',
    title: 'Review without parallel copies',
    detail: 'Track changes, anchor comments to the text, reply with attribution, and accept or reject suggestions without creating another “final” file.',
    note: 'Original, review and clean final views',
  },
  {
    icon: 'users',
    title: 'Collaboration with boundaries',
    detail: 'Co-author online with owner, editor, commenter and viewer roles. Work can converge after reconnecting, then return to the project as an explicit checkpoint.',
    note: 'Optional service, including self-hosting',
  },
  {
    icon: 'branch',
    title: 'Plain text, real version control',
    detail: 'Keep the manuscript, bibliography, code and data in one repository. Use DraftMatter’s rendered Git history or manage everything from your preferred IDE.',
    note: 'Semantic diffs, checkpoints, branches and remotes',
  },
] as const

function DraftRow({
  draft,
  onOpen,
}: {
  draft: CatalogueDraft
  onOpen: () => void
}) {
  return (
    <button className="home-draft-row" onClick={onOpen}>
      <span className="home-draft-icon"><Icon name="document" size={18} /></span>
      <span className="home-draft-copy">
        <strong>{draft.name}</strong>
        <small>{draft.workspaceName} · {activityLabel(draft)}</small>
        {(draft.reviewRequested || draft.participantCount !== undefined) && <em>{draft.reviewRequested ? 'Review requested' : ''}{draft.reviewRequested && draft.participantCount !== undefined ? ' · ' : ''}{draft.participantCount !== undefined ? `${draft.participantCount} ${draft.participantCount === 1 ? 'person' : 'people'}` : ''}</em>}
      </span>
      <span className={`home-role home-role-${draft.role}`}>{roleLabel(draft.role)}</span>
      <Icon name="arrowRight" size={16} />
    </button>
  )
}

function SignedOutHome({
  onOpenLocalProject,
  onOpenLocalRecent,
  onForgetLocalRecent,
  onStartLocalCollaboration,
  onNewLocalDraft,
  localProjects,
  localProblem,
  onOpenExample,
  onOpenLearn,
  onOpenTutorial,
}: Pick<HomeProps, 'onOpenLocalProject' | 'onOpenLocalRecent' | 'onForgetLocalRecent' | 'onStartLocalCollaboration' | 'onNewLocalDraft' | 'localProjects' | 'localProblem' | 'onOpenExample' | 'onOpenLearn' | 'onOpenTutorial'>) {
  const session = useCollaborationSession()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [serviceUrl, setServiceUrl] = useState(session.serviceUrl || 'https://')
  const [accessToken, setAccessToken] = useState('')

  return (
    <main className="home-welcome">
      <header className="home-welcome-header">
        <a className="home-brand" href="/" aria-label="DraftMatter home">
          <img src="/draftmatter-pencil-mark.svg" alt="" />
          <span>DraftMatter</span>
        </a>
        <button className="home-link-button" onClick={onOpenLearn}>Learn DraftMatter</button>
      </header>

      <section className="home-hero" aria-labelledby="home-title">
        <span className="home-kicker">The research writing workspace</span>
        <h1 id="home-title">Write the paper. <span>Keep it reproducible.</span></h1>
        <p>DraftMatter brings scholarly writing, citations, tracked review, live collaboration and executable results into one calm environment, without locking your work inside the app.</p>
        <div className="home-hero-actions">
          <button className="home-primary" onClick={() => void session.signIn()} disabled={session.state === 'signing-in'}>
            <Icon name="users" size={17} />
            {session.state === 'signing-in' ? 'Opening sign-in…' : 'Sign in'}
          </button>
          {desktopHost.available && <button onClick={onOpenLocalProject}><Icon name="folder" size={17} />Open local project</button>}
          <button onClick={onOpenExample}><Icon name="spark" size={17} />Explore complete example</button>
        </div>
        <ul className="home-hero-proof" aria-label="DraftMatter principles">
          <li><Icon name="check" size={14} />Plain-text source</li>
          <li><Icon name="check" size={14} />Local-first desktop</li>
          <li><Icon name="check" size={14} />Python · R · Julia</li>
          <li><Icon name="check" size={14} />Clean publication exports</li>
        </ul>
        {session.error && <p className="home-account-error" role="alert">{session.error}</p>}
        {!session.serviceUrl && (
          <p className="home-deployment-note">Online collaboration is not configured for this installation. Local projects and the complete example remain available.</p>
        )}
      </section>

      <section className="home-positioning" aria-labelledby="home-positioning-title">
        <div className="home-positioning-copy">
          <span className="home-kicker">One research project</span>
          <h2 id="home-positioning-title">Your paper should not be the least reproducible part of your research.</h2>
          <p>Stop copying results out of notebooks, passing review files around, and fixing references by hand. DraftMatter keeps the readable manuscript at the center while the evidence behind it stays close.</p>
        </div>
        <div className="home-project-picture" aria-label="Code, data and references feed one portable rendered manuscript">
          <div className="home-project-assets">
            <span><Icon name="code" size={16} /><strong>analysis.py · model.R · figures.jl</strong><small>Executable research</small></span>
            <span><Icon name="table" size={16} /><strong>data/</strong><small>Project inputs</small></span>
            <span><Icon name="book" size={16} /><strong>references.bib</strong><small>Scholarly sources</small></span>
          </div>
          <Icon className="home-project-arrow" name="arrowRight" size={22} />
          <div className="home-project-paper">
            <span><Icon name="document" size={18} />paper.qmd</span>
            <strong>One rendered manuscript</strong>
            <small>Write · cite · compute · review</small>
          </div>
        </div>
      </section>

      <section className="home-feature-section" aria-labelledby="home-features-title">
        <div className="home-section-intro">
          <span className="home-kicker">Everything the paper needs</span>
          <h2 id="home-features-title">Research writing, with the missing pieces built in.</h2>
          <p>DraftMatter is designed for researchers who want a polished writing experience and a project that can still explain where every result came from.</p>
        </div>
        <div className="home-feature-grid">
          {homeFeatures.map((feature) => (
            <article key={feature.title}>
              <span className="home-feature-icon"><Icon name={feature.icon} size={20} /></span>
              <h3>{feature.title}</h3>
              <p>{feature.detail}</p>
              <small><Icon name="check" size={13} />{feature.note}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="home-publication" aria-labelledby="home-publication-title">
        <div>
          <span className="home-kicker">From source to submission</span>
          <h2 id="home-publication-title">The working project stays rich. The paper leaves clean.</h2>
          <p>Publish the results and references—not the machinery behind them. Export clean Markdown, HTML, PDF or DOCX, or pass inert source to Pandoc and Quarto.</p>
        </div>
        <div className="home-publication-formats" aria-label="Publication features">
          <span>Markdown</span><span>HTML</span><span>PDF</span><span>DOCX</span>
          <small><Icon name="check" size={14} />Citations, cross-references and reproducible outputs included</small>
        </div>
      </section>

      {desktopHost.available && <LocalProjectsSection projects={localProjects} problem={localProblem} onOpen={onOpenLocalRecent} onForget={onForgetLocalRecent} onStartCollaboration={onStartLocalCollaboration} onOpenFolder={onOpenLocalProject} onCreate={onNewLocalDraft} />}
      {desktopHost.available && <GettingStarted userId="desktop" role="owner" hasDraft={localProjects.length > 0} onTutorial={onOpenTutorial} onLearn={onOpenLearn} />}

      <section className="home-advanced">
        <button className="home-disclosure" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
          Advanced connection setup
          <Icon name="chevronDown" size={15} />
        </button>
        {advancedOpen && (
          <form onSubmit={(event) => {
            event.preventDefault()
            session.configureDevelopmentService(serviceUrl)
            if (accessToken.trim()) void session.useAccessToken(serviceUrl, accessToken.trim())
          }}>
            <p>For development and self-hosted installations. Access tokens are held in memory only.</p>
            <label><span>Collaboration service</span><input value={serviceUrl} onChange={(event) => setServiceUrl(event.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} /></label>
            <label><span>Short-lived access token</span><input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} autoComplete="one-time-code" /></label>
            <button type="submit">Use this service</button>
          </form>
        )}
      </section>
    </main>
  )
}

function Catalogue({
  preferredWorkspaceId,
  onOpenDraft,
  onNewDraft,
  onNewLocalDraft,
  onOpenLocalProject,
  onOpenLocalRecent,
  onForgetLocalRecent,
  onStartLocalCollaboration,
  localProjects,
  localProblem,
  onOpenLearn,
  onOpenTutorial,
}: Pick<HomeProps, 'preferredWorkspaceId' | 'onOpenDraft' | 'onNewDraft' | 'onNewLocalDraft' | 'onOpenLocalProject' | 'onOpenLocalRecent' | 'onForgetLocalRecent' | 'onStartLocalCollaboration' | 'localProjects' | 'localProblem' | 'onOpenLearn' | 'onOpenTutorial'>) {
  const session = useCollaborationSession()
  const [query, setQuery] = useState('')
  const [workspaceId, setWorkspaceId] = useState(() => (
    preferredWorkspaceId && session.workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
      ? preferredWorkspaceId
      : 'all'
  ))
  const [roleFilter, setRoleFilter] = useState<WorkspaceRole | 'all'>('all')
  const [sort, setSort] = useState<'activity' | 'title' | 'created'>('activity')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleDrafts = useMemo(() => session.drafts.filter((draft) => (
    (workspaceId === 'all' || draft.workspaceId === workspaceId)
    && (roleFilter === 'all' || draft.role === roleFilter)
    && (!normalizedQuery || `${draft.name} ${draft.workspaceName}`.toLocaleLowerCase().includes(normalizedQuery))
  )).sort((left, right) => {
    if (sort === 'title') return left.name.localeCompare(right.name)
    const leftDate = new Date(sort === 'created' ? left.createdAt : left.lastActivityAt ?? left.createdAt).getTime()
    const rightDate = new Date(sort === 'created' ? right.createdAt : right.lastActivityAt ?? right.createdAt).getTime()
    return rightDate - leftDate || left.name.localeCompare(right.name)
  }), [normalizedQuery, roleFilter, session.drafts, sort, workspaceId])
  const continueWriting = visibleDrafts.slice(0, 3)
  const owned = visibleDrafts.filter((draft) => draft.role === 'owner')
  const shared = visibleDrafts.filter((draft) => draft.role !== 'owner')
  const accountName = session.profile?.displayName ?? session.profile?.email ?? session.profile?.userId ?? 'Account'
  const role = session.workspaces.some((workspace) => workspace.role === 'owner')
    ? 'owner'
    : session.workspaces.some((workspace) => workspace.role === 'editor')
      ? 'editor'
      : session.workspaces.some((workspace) => workspace.role === 'commenter')
        ? 'commenter'
        : 'viewer'

  const openDraft = (draft: CatalogueDraft) => {
    const launch = session.launchFor(draft.workspaceId, draft.id, { canBootstrap: false })
    if (launch) onOpenDraft(launch)
  }

  return (
    <main className="home-catalogue">
      <header className="home-catalogue-bar">
        <a className="home-brand" href="/" aria-label="DraftMatter home">
          <img src="/draftmatter-pencil-mark.svg" alt="" />
          <span>DraftMatter</span>
        </a>
        <label className="home-search">
          <Icon name="search" size={16} />
          <span className="sr-only">Search drafts</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search drafts" />
        </label>
        <button className="home-link-button" onClick={onOpenLearn}>Help</button>
        <div className="home-account">
          <span aria-hidden="true">{accountName.slice(0, 1).toUpperCase()}</span>
          <span><strong>{accountName}</strong><small>Signed in</small></span>
          <button onClick={session.signOut}>Sign out</button>
        </div>
      </header>

      <div className="home-catalogue-content">
        <section className="home-catalogue-heading">
          <div><span className="home-kicker">Your research workspace</span><h1>Drafts</h1><p>Every manuscript you can access, across all of your workspaces.</p></div>
          <button className="home-primary" onClick={onNewDraft}><Icon name="plus" size={16} />New draft</button>
        </section>

        <div className="home-catalogue-tools">
          <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="all">All workspaces</option>{session.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <label><span>Role</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as WorkspaceRole | 'all')}><option value="all">All roles</option><option value="owner">Owner</option><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select></label>
          <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="activity">Recent activity</option><option value="created">Created</option><option value="title">Title</option></select></label>
          <span>{visibleDrafts.length} draft{visibleDrafts.length === 1 ? '' : 's'}</span>
        </div>

        {session.workspaceFailures.length > 0 && (
          <section className="home-partial-failure" role="status" aria-label="Some workspaces could not be loaded">
            <Icon name="info" size={17} />
            <span><strong>Some workspaces could not be loaded.</strong><small>{session.workspaceFailures.map((failure) => failure.workspaceName).join(', ')}</small></span>
            <button onClick={() => void session.refresh()}>Retry</button>
          </section>
        )}

        {session.state === 'loading' ? (
          <div className="home-loading" role="status">Loading your drafts…</div>
        ) : visibleDrafts.length === 0 ? (
          <section className="home-empty">
            <span><Icon name="document" size={24} /></span>
            <h2>{query ? 'No matching drafts' : 'No drafts here yet'}</h2>
            <p>{query ? 'Try a different title or workspace.' : 'Create a manuscript with a portable source, then invite collaborators when you are ready.'}</p>
            {!query && <button className="home-primary" onClick={onNewDraft}>Create your first draft</button>}
          </section>
        ) : (
          <div className="home-draft-sections">
            {continueWriting.length > 0 && <section aria-labelledby="continue-drafts-title"><div className="home-section-title"><h2 id="continue-drafts-title">Continue writing</h2><span>{continueWriting.length}</span></div><div className="home-draft-list">{continueWriting.map((draft) => <DraftRow key={`continue:${draft.workspaceId}:${draft.id}`} draft={draft} onOpen={() => openDraft(draft)} />)}</div></section>}
            {shared.length > 0 && <section aria-labelledby="shared-drafts-title"><div className="home-section-title"><h2 id="shared-drafts-title">Shared with me</h2><span>{shared.length}</span></div><div className="home-draft-list">{shared.map((draft) => <DraftRow key={`${draft.workspaceId}:${draft.id}`} draft={draft} onOpen={() => openDraft(draft)} />)}</div></section>}
            {owned.length > 0 && <section aria-labelledby="owned-drafts-title"><div className="home-section-title"><h2 id="owned-drafts-title">My drafts</h2><span>{owned.length}</span></div><div className="home-draft-list">{owned.map((draft) => <DraftRow key={`${draft.workspaceId}:${draft.id}`} draft={draft} onOpen={() => openDraft(draft)} />)}</div></section>}
          </div>
        )}

        {desktopHost.available && <LocalProjectsSection projects={localProjects} problem={localProblem} onOpen={onOpenLocalRecent} onForget={onForgetLocalRecent} onStartCollaboration={onStartLocalCollaboration} onOpenFolder={onOpenLocalProject} onCreate={onNewLocalDraft} />}
        {session.profile && <GettingStarted userId={session.profile.userId} role={role} client={session.client} hasDraft={session.drafts.length + localProjects.length > 0} onTutorial={onOpenTutorial} onLearn={onOpenLearn} />}
      </div>
    </main>
  )
}

function openedLabel(lastOpenedAt: string) {
  const opened = new Date(lastOpenedAt)
  if (Number.isNaN(opened.getTime())) return 'Last opened date unavailable'
  return `Last opened ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(opened)}`
}

function LocalProjectsSection({
  projects,
  problem,
  onOpen,
  onForget,
  onStartCollaboration,
  onOpenFolder,
  onCreate,
}: {
  projects: LocalProjectRecent[]
  problem?: string
  onOpen: (project: LocalProjectRecent) => void
  onForget: (project: LocalProjectRecent) => void
  onStartCollaboration: (project: LocalProjectRecent) => void
  onOpenFolder: () => void
  onCreate: () => void
}) {
  return (
    <section className="home-local-projects" aria-labelledby="local-projects-title">
      <div className="home-local-heading">
        <div><span className="home-kicker">Desktop</span><h2 id="local-projects-title">On this computer</h2></div>
        <div><button onClick={onOpenFolder}><Icon name="folder" size={15} />Open project</button><button onClick={onCreate}><Icon name="plus" size={15} />New local draft</button></div>
      </div>
      {problem && <p className="home-account-error" role="alert">{problem}</p>}
      {projects.length ? (
        <div className="home-local-list">
          {projects.map((project) => (
            <div key={project.root} className="home-local-row">
              <button className="home-local-open" onClick={() => onOpen(project)} title={project.root}>
                <span className="home-draft-icon"><Icon name="folder" size={18} /></span>
                <span className="home-draft-copy"><strong>{project.name}</strong><small>On this computer · {openedLabel(project.lastOpenedAt)}</small></span>
                <span className="home-local-state">{project.collaboration ? 'Collaborative · linked' : 'Local only'}</span>
                <Icon name="arrowRight" size={16} />
              </button>
              {!project.collaboration && <button className="home-local-collaborate" onClick={() => onStartCollaboration(project)}><Icon name="users" size={14} />Start collaboration</button>}
              <button className="home-local-forget" onClick={() => onForget(project)} aria-label={`Forget ${project.name} from recent projects`} title="Forget recent project"><Icon name="close" size={14} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="home-local-empty"><Icon name="folder" size={20} /><span><strong>No local projects yet</strong><small>Open an existing DraftMatter folder or create a new project on this computer.</small></span></div>
      )}
    </section>
  )
}

export function Home(props: HomeProps) {
  const session = useCollaborationSession()
  if (session.profile) return <Catalogue {...props} />
  return <SignedOutHome {...props} />
}
