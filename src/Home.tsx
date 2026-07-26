import { useMemo, useState } from 'react'
import { AssistantConnectionsDialog } from './AssistantConnectionsDialog'
import { desktopHost } from './desktopHost'
import { Icon } from './Icon'
import {
  useCollaborationSession,
  type CatalogueDraft,
  type CollaborationProjectLaunch,
} from './collaboration/sessionContext'
import type { WorkspaceRole } from './collaboration/workspaceService'
import type { LocalProjectRecent } from './localProjectCatalogue'
import { HomeLearningGuide, HomeTrustGuide } from './HomeLearningGuide'
import { HomeHeroPreview, HomeShowcase } from './HomeShowcase'

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
  onOpenBrowserDraft: () => void
  onOpenLearn: () => void
  onOpenAiLearn: () => void
  onOpenLanguages: () => void
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
  onOpenBrowserDraft,
  onOpenLearn,
  onOpenLanguages,
  onOpenTutorial,
  onConnectAssistants,
  onOpenAiLearn,
}: Pick<HomeProps, 'onOpenLocalProject' | 'onOpenLocalRecent' | 'onForgetLocalRecent' | 'onStartLocalCollaboration' | 'onNewLocalDraft' | 'localProjects' | 'localProblem' | 'onOpenExample' | 'onOpenBrowserDraft' | 'onOpenLearn' | 'onOpenAiLearn' | 'onOpenLanguages' | 'onOpenTutorial'> & { onConnectAssistants: () => void }) {
  const session = useCollaborationSession()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [serviceUrl, setServiceUrl] = useState(session.serviceUrl || 'https://')
  const [accessToken, setAccessToken] = useState('')
  const startWriting = () => {
    if (desktopHost.available) {
      onNewLocalDraft()
      return
    }
    if (session.serviceUrl) {
      void session.signIn()
      return
    }
    onOpenBrowserDraft()
  }
  const showProductPreview = () => {
    const showcase = document.getElementById('home-showcase')
    if (!showcase) return
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    showcase.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
  }

  return (
    <main className="home-welcome">
      <header className="home-welcome-header">
        <a className="home-brand" href="/" aria-label="DraftMatter home">
          <img src="/draftmatter-pencil-mark.svg" alt="" />
          <span>DraftMatter</span>
        </a>
        <nav className="home-welcome-links" aria-label="Learn about DraftMatter">
          {desktopHost.available && <button className="home-link-button home-ai-connect-link" onClick={onConnectAssistants}><Icon name="spark" size={15} />Connect AI assistants</button>}
          <button className="home-link-button home-languages-link" onClick={onOpenLanguages}><Icon name="code" size={15} />Languages</button>
          <button className="home-link-button home-learn-link" onClick={onOpenLearn}><Icon name="spark" size={15} />Learn DraftMatter</button>
        </nav>
      </header>

      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-layout">
          <div className="home-hero-copy">
            <span className="home-kicker">A calm workspace for rigorous research</span>
            <h1 id="home-title">Your paper should be as <span>reproducible</span> as your research.</h1>
            <p className="home-hero-support">Research writing, with the missing pieces built in.</p>
            <p className="home-hero-summary">DraftMatter brings writing, citations, reproducible results, review, and collaboration into one focused workspace. Everything is available when needed and quiet when it is not.</p>
            <div className="home-hero-actions">
              <button className="home-primary" onClick={startWriting} disabled={!desktopHost.available && session.state === 'signing-in'}>
                <Icon name="document" size={17} />
                Start a new paper
              </button>
              <button className="home-example-action" onClick={onOpenExample}>
                <Icon name="spark" size={16} />
                Explore the complete example
              </button>
              <button className="home-preview-action" onClick={showProductPreview}>
                See how it works
                <Icon name="arrowRight" size={17} />
              </button>
            </div>
            <ul className="home-hero-proof" aria-label="DraftMatter principles">
              <li><Icon name="check" size={13} />Portable manuscript</li>
              <li><Icon name="check" size={13} />Local computation</li>
              <li><Icon name="check" size={13} />Reviews inside Markdown</li>
              <li><Icon name="check" size={13} />AI integration, on your terms</li>
            </ul>
            {session.error && <p className="home-account-error" role="alert">{session.error}</p>}
          </div>
          <HomeHeroPreview />
        </div>
      </section>

      <HomeShowcase />

      <section className="home-ai-connect" aria-labelledby="home-ai-connect-title">
        <div>
          <span className="home-kicker">Optional · bring your own model</span>
          <h2 id="home-ai-connect-title">AI integration, on your terms</h2>
          <p>Connect Codex, Claude Code, GitHub Copilot, or Mistral Vibe once on this computer. Then choose separately which projects each connected assistant may access.</p>
          <nav className="home-ai-brands" aria-label="Supported AI assistant product pages">
            <a href="https://openai.com/codex/" target="_blank" rel="noreferrer" aria-label="Open the OpenAI Codex product page">
              <img src="/ai-openai.svg" alt="" /><span>Codex</span>
            </a>
            <a href="https://claude.com/product/claude-code" target="_blank" rel="noreferrer" aria-label="Open the Claude Code product page">
              <img src="/ai-claude-code.svg" alt="" /><span>Claude Code</span>
            </a>
            <a href="https://mistral.ai/products/vibe/code/" target="_blank" rel="noreferrer" aria-label="Open the Mistral Vibe Code product page">
              <img src="/ai-mistral.svg" alt="" /><span>Mistral Vibe</span>
            </a>
          </nav>
        </div>
        <div>
          {desktopHost.available
            ? <button className="home-primary" onClick={onConnectAssistants}><Icon name="spark" size={16} />Connect AI assistants</button>
            : <button className="home-primary" onClick={onOpenAiLearn}><Icon name="spark" size={16} />See desktop AI setup</button>}
          <button onClick={onOpenAiLearn}>How the two-step setup works <Icon name="arrowRight" size={15} /></button>
        </div>
      </section>

      <HomeTrustGuide onStartTour={onOpenTutorial} />

      {desktopHost.available && <LocalProjectsSection projects={localProjects} problem={localProblem} onOpen={onOpenLocalRecent} onForget={onForgetLocalRecent} onStartCollaboration={onStartLocalCollaboration} onOpenFolder={onOpenLocalProject} onCreate={onNewLocalDraft} />}

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
  onOpenLanguages,
  onOpenTutorial,
  onConnectAssistants,
}: Pick<HomeProps, 'preferredWorkspaceId' | 'onOpenDraft' | 'onNewDraft' | 'onNewLocalDraft' | 'onOpenLocalProject' | 'onOpenLocalRecent' | 'onForgetLocalRecent' | 'onStartLocalCollaboration' | 'localProjects' | 'localProblem' | 'onOpenLearn' | 'onOpenLanguages' | 'onOpenTutorial'> & { onConnectAssistants: () => void }) {
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
        <button className="home-link-button" onClick={onOpenLanguages}>Languages</button>
        {desktopHost.available && <button className="home-link-button" onClick={onConnectAssistants}>Connect AI</button>}
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
        <HomeLearningGuide onStartTour={onOpenTutorial} />
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

function HomeSketchDefinitions() {
  return (
    <svg className="home-sketch-defs" aria-hidden="true">
      <defs>
        <filter id="home-pencil-wobble" x="-8%" y="-8%" width="116%" height="116%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".012 .18" numOctaves="1" seed="17" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale=".55" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="home-pencil-wobble-deep" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".009 .11" numOctaves="2" seed="29" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.15" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  )
}

export function Home(props: HomeProps) {
  const session = useCollaborationSession()
  const [assistantConnectionsOpen, setAssistantConnectionsOpen] = useState(false)
  return (
    <>
      <HomeSketchDefinitions />
      {session.profile
        ? <Catalogue {...props} onConnectAssistants={() => setAssistantConnectionsOpen(true)} />
        : <SignedOutHome {...props} onConnectAssistants={() => setAssistantConnectionsOpen(true)} />}
      <AssistantConnectionsDialog
        open={assistantConnectionsOpen}
        onClose={() => setAssistantConnectionsOpen(false)}
        onOpenLearn={() => {
          setAssistantConnectionsOpen(false)
          props.onOpenAiLearn()
        }}
      />
    </>
  )
}
